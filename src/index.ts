import { createServer } from "node:http";
import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
} from "discord.js";
import { GuardCommandHandler } from "./commands/guard-command.js";
import { env } from "./config.js";
import { logger } from "./logger.js";
import { JsonStore } from "./store/json-store.js";
import { MessageGuard } from "./services/message-guard.js";
import { ResponseService } from "./services/response-service.js";
import { SecurityEngine } from "./services/security-engine.js";
import { SnapshotService } from "./services/snapshot-service.js";
import { TrustService } from "./services/trust-service.js";

const store = new JsonStore(env.DATA_DIR);
await store.load();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildWebhooks,
  ],
  partials: [Partials.GuildMember, Partials.Channel],
  allowedMentions: { parse: [], repliedUser: false },
});

const snapshots = new SnapshotService(store);
const responses = new ResponseService(store);
const trust = new TrustService(() => client.user?.id);
const security = new SecurityEngine(store, trust, snapshots, responses);
const messageGuard = new MessageGuard(store, responses);
const guardCommands = new GuardCommandHandler(store, snapshots, responses);
const snapshotJobs = new Set<string>();

client.once(Events.ClientReady, (readyClient) => {
  readyClient.user.setPresence({
    activities: [{ name: "mối đe dọa theo thời gian thực", type: ActivityType.Watching }],
    status: "online",
  });
  logger.info(
    { userId: readyClient.user.id, guilds: readyClient.guilds.cache.size },
    "Bot Anti-Raid Security đã sẵn sàng",
  );

  for (const guild of readyClient.guilds.cache.values()) {
    if (!responses.isLockedDown(guild.id)) continue;
    void responses
      .enableLockdown(guild, "khôi phục trạng thái sau restart", true)
      .catch((error: unknown) => logger.error({ guildId: guild.id, error }, "Không thể tái áp dụng lockdown"));
  }

  setInterval(() => {
    for (const guild of readyClient.guilds.cache.values()) {
      const config = store.getConfig(guild.id);
      if (
        !config.enabled ||
        responses.isLockedDown(guild.id) ||
        !security.isSafeToSnapshot(guild.id) ||
        snapshotJobs.has(guild.id)
      ) {
        continue;
      }
      snapshotJobs.add(guild.id);
      void snapshots
        .capture(guild)
        .catch((error: unknown) => logger.error({ guildId: guild.id, error }, "Snapshot định kỳ thất bại"))
        .finally(() => snapshotJobs.delete(guild.id));
    }
  }, env.SNAPSHOT_INTERVAL_MINUTES * 60_000).unref();
});

client.on(Events.GuildAuditLogEntryCreate, (entry, guild) => {
  void security.handleAuditEntry(entry, guild);
});

client.on(Events.MessageCreate, (message) => {
  void messageGuard.handle(message).catch((error: unknown) => {
    logger.error({ guildId: message.guildId, messageId: message.id, error }, "Message Guard thất bại");
  });
});

client.on(Events.GuildMemberAdd, (member) => {
  void (async () => {
    const roleIds = store
      .getPendingMemberRoles(member.guild.id, member.id)
      .filter((roleId) => member.guild.roles.cache.get(roleId)?.editable);
    if (roleIds.length === 0) return;
    await member.roles.add(roleIds, "Bot Anti-Raid Security: trả role sau khi nạn nhân vào lại");
    await store.clearPendingMemberRoles(member.guild.id, member.id);
    logger.info({ guildId: member.guild.id, memberId: member.id, roles: roleIds.length }, "Đã trả role cho nạn nhân");
  })().catch((error: unknown) => {
    logger.warn({ guildId: member.guild.id, memberId: member.id, error }, "Không thể trả role đang chờ");
  });
});

client.on(Events.InteractionCreate, (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "guard") return;
  void guardCommands.execute(interaction).catch(async (error: unknown) => {
    logger.error({ interactionId: interaction.id, error }, "Slash command thất bại");
    const payload = { content: "Không thể hoàn tất lệnh. Hãy kiểm tra log của bot." };
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
      else await interaction.reply({ ...payload, ephemeral: true });
    } catch {
      // The interaction token may already have expired.
    }
  });
});

client.on(Events.Error, (error) => logger.error({ error }, "Discord client error"));
client.on(Events.Warn, (message) => logger.warn({ message }, "Discord client warning"));

const healthServer = createServer((request, response) => {
  if (request.url !== "/health") {
    response.writeHead(404).end("Not Found");
    return;
  }
  response
    .writeHead(client.isReady() ? 200 : 503, { "content-type": "application/json; charset=utf-8" })
    .end(
      JSON.stringify({
        status: client.isReady() ? "ok" : "starting",
        guilds: client.guilds.cache.size,
        uptimeSeconds: Math.floor(process.uptime()),
      }),
    );
});

if (env.HEALTH_PORT > 0) {
  healthServer.listen(env.HEALTH_PORT, "0.0.0.0", () => {
    logger.info({ port: env.HEALTH_PORT }, "Health endpoint đang lắng nghe tại /health");
  });
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "Đang tắt bot an toàn");
  healthServer.close();
  client.destroy();
  await store.flush();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

await client.login(env.BOT_TOKEN);
