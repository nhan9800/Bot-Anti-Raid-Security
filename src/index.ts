import { createServer, IncomingMessage, ServerResponse } from "node:http";
import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
} from "discord.js";
import { GuardCommandHandler } from "./commands/guard-command.js";
import { LicenseCommandHandler } from "./commands/license-command.js";
import { env } from "./config.js";
import { logger } from "./logger.js";
import { JsonStore } from "./store/json-store.js";
import { MessageGuard } from "./services/message-guard.js";
import { ResponseService } from "./services/response-service.js";
import { SecurityEngine } from "./services/security-engine.js";
import { SnapshotService } from "./services/snapshot-service.js";
import { TrustService } from "./services/trust-service.js";
import { LicenseService } from "./services/license-service.js";
import { LicenseScheduler } from "./services/license-scheduler.js";
import { unlockGuildProtection } from "./services/unlock-service.js";

const store = new JsonStore(env.DATA_DIR);
await store.load();

const licenseService = new LicenseService(env.DATA_DIR);

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
const licenseCommands = new LicenseCommandHandler(licenseService, store, responses, snapshots, client);
const licenseScheduler = new LicenseScheduler(licenseService, client, store, responses, snapshots);
const snapshotJobs = new Set<string>();

client.once(Events.ClientReady, (readyClient) => {
  readyClient.user.setPresence({
    activities: [{ name: "🛡️ MIMI SHIELD Anti-Raid 24/7", type: ActivityType.Watching }],
    status: "online",
  });
  logger.info(
    { userId: readyClient.user.id, guilds: readyClient.guilds.cache.size },
    "MIMI SHIELD BOT (Anti-Raid Security) đã sẵn sàng hoạt động!"
  );

  // Khởi động bộ quét bản quyền & auto-leave cho server chưa kích hoạt
  licenseScheduler.start(10);
  void licenseScheduler.checkAllGuilds();

  for (const guild of readyClient.guilds.cache.values()) {
    const lic = licenseService.getLicense(guild.id);
    if (!lic.active) continue;

    // Đảm bảo máy chủ đã kích hoạt bản quyền luôn được mở khóa bảo vệ 100%
    const config = store.getConfig(guild.id);
    if (!config.enabled) {
      void unlockGuildProtection(guild.id, store, responses, snapshots, readyClient);
    }

    if (!responses.isLockedDown(guild.id)) continue;
    void responses
      .enableLockdown(guild, "khôi phục trạng thái sau restart", true)
      .catch((error: unknown) => logger.error({ guildId: guild.id, error }, "Không thể tái áp dụng lockdown"));
  }

  setInterval(() => {
    for (const guild of readyClient.guilds.cache.values()) {
      const lic = licenseService.getLicense(guild.id);
      if (!lic.active) continue;

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

client.on(Events.GuildCreate, (guild) => {
  void licenseScheduler.handleGuildCreate(guild);
});

client.on(Events.GuildAuditLogEntryCreate, (entry, guild) => {
  const lic = licenseService.getLicense(guild.id);
  if (!lic.active) return; // Nếu chưa có bản quyền thì không chạy bảo vệ
  void security.handleAuditEntry(entry, guild);
});

client.on(Events.MessageCreate, (message) => {
  if (!message.guildId) return;
  const lic = licenseService.getLicense(message.guildId);
  if (!lic.active) return;
  void messageGuard.handle(message).catch((error: unknown) => {
    logger.error({ guildId: message.guildId, messageId: message.id, error }, "Message Guard thất bại");
  });
});

client.on(Events.GuildMemberAdd, (member) => {
  const lic = licenseService.getLicense(member.guild.id);
  if (!lic.active) return;

  void (async () => {
    const roleIds = store
      .getPendingMemberRoles(member.guild.id, member.id)
      .filter((roleId) => member.guild.roles.cache.get(roleId)?.editable);
    if (roleIds.length === 0) return;
    await member.roles.add(roleIds, "MIMI SHIELD: trả role sau khi nạn nhân vào lại");
    await store.clearPendingMemberRoles(member.guild.id, member.id);
    logger.info({ guildId: member.guild.id, memberId: member.id, roles: roleIds.length }, "Đã trả role cho nạn nhân");
  })().catch((error: unknown) => {
    logger.warn({ guildId: member.guild.id, memberId: member.id, error }, "Không thể trả role đang chờ");
  });
});

client.on(Events.InteractionCreate, (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  void (async () => {
    const cmd = interaction.commandName;
    if (cmd === "kichhoat") {
      await licenseCommands.handleKichhoat(interaction);
    } else if (cmd === "license") {
      await licenseCommands.handleLicense(interaction);
    } else if (cmd === "xacnhan") {
      await licenseCommands.handleXacnhan(interaction);
    } else if (cmd === "genkey") {
      await licenseCommands.handleGenkey(interaction);
    } else if (cmd === "guard") {
      if (interaction.guildId) {
        const lic = licenseService.getLicense(interaction.guildId);
        if (!lic.active) {
          await interaction.reply({
            content: "🔒 **Máy chủ chưa kích hoạt bản quyền MIMI SHIELD!**\nVui lòng dùng lệnh `/kichhoat [mã_key]` hoặc mua key tại https://mimibot.id.vn/pricing để mở khóa tính năng bảo vệ.",
            ephemeral: true,
          });
          return;
        }
      }
      await guardCommands.execute(interaction);
    }
  })().catch(async (error: unknown) => {
    logger.error({ interactionId: interaction.id, error }, "Slash command thất bại");
    const payload = { content: "Không thể hoàn tất lệnh. Hãy kiểm tra log của bot." };
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply(payload);
      else await interaction.reply({ ...payload, ephemeral: true });
    } catch {}
  });
});

client.on(Events.Error, (error) => logger.error({ error }, "Discord client error"));
client.on(Events.Warn, (message) => logger.warn({ message }, "Discord client warning"));

function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy();
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const healthServer = createServer((request: IncomingMessage, response: ServerResponse) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (request.method === "OPTIONS") {
    response.writeHead(204).end();
    return;
  }

  const urlObj = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  const pathname = urlObj.pathname;

  void (async () => {
    if (pathname === "/health" || pathname === "/status") {
      response
        .writeHead(client.isReady() ? 200 : 503, { "content-type": "application/json; charset=utf-8" })
        .end(
          JSON.stringify({
            status: client.isReady() ? "ok" : "starting",
            guilds: client.guilds.cache.size,
            uptimeSeconds: Math.floor(process.uptime()),
          })
        );
      return;
    }

    if (pathname === "/api/license/check" && request.method === "GET") {
      const guildId = urlObj.searchParams.get("guildId")?.trim();
      if (!guildId) {
        response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: "Thiếu guildId" }));
        return;
      }
      const lic = licenseService.getLicense(guildId);
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, license: lic }));
      return;
    }

    if (pathname === "/api/license/redeem" && request.method === "POST") {
      const body = await readJsonBody<{ guildId?: string; key?: string }>(request);
      const { guildId, key } = body || {};
      if (!guildId || !key) {
        response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: "Thiếu Server ID hoặc mã Key" }));
        return;
      }
      const result = licenseService.redeemKey(guildId, key, "Website Client");
      if (result.ok) {
        await unlockGuildProtection(guildId, store, responses, snapshots, client);
      }
      response.writeHead(result.ok ? 200 : 400, { "content-type": "application/json" }).end(JSON.stringify(result));
      return;
    }

    if (pathname === "/api/license/admin/confirm" && request.method === "POST") {
      const body = await readJsonBody<{
        guildId?: string;
        plan?: string;
        secret?: string;
        action?: "activate" | "generate_key";
        note?: string;
      }>(request);

      const { guildId, plan = "1m", secret, action = "activate", note = "" } = body || {};
      const validSecret = secret === (process.env.ADMIN_SECRET || "mimi2026") || secret === process.env.MIMI_API_TOKEN;

      if (!validSecret) {
        response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: "Mã xác thực Admin không chính xác." }));
        return;
      }

      if (action === "generate_key") {
        const keyObj = licenseService.generateKey(plan, note || "Tạo từ Admin Web", "Admin Web");
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            ok: true,
            key: keyObj.key,
            plan: keyObj.plan,
            planName: keyObj.planName,
            durationDays: keyObj.durationDays,
            message: `Đã tạo Key ${keyObj.planName} thành công!`,
          })
        );
        return;
      }

      if (!guildId) {
        response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: "Vui lòng cung cấp Server ID cần kích hoạt." }));
        return;
      }

      const updatedLic = licenseService.grantLicense(guildId, plan, null, "Admin Web Direct");
      await unlockGuildProtection(guildId, store, responses, snapshots, client);
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          ok: true,
          license: updatedLic,
          message: `Đã xác nhận thanh toán & kích hoạt thành công ${updatedLic.planName} cho Server ${guildId}!`,
        })
      );
      return;
    }

    response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: "Not Found" }));
  })().catch((err: unknown) => {
    logger.error({ error: err }, "Lỗi HTTP Server");
    response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: "Internal Server Error" }));
  });
});

if (env.HEALTH_PORT > 0) {
  healthServer.listen(env.HEALTH_PORT, "0.0.0.0", () => {
    logger.info({ port: env.HEALTH_PORT }, "HTTP Server & License API đang lắng nghe");
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
