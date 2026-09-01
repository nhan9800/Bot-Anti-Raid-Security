import {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
} from "discord.js";
import { emoji } from "../config.js";
import { PROTECTION_EVENTS, type EnforcementAction, type ProtectionEvent } from "../domain/types.js";
import { JsonStore } from "../store/json-store.js";
import { ResponseService } from "../services/response-service.js";
import { SnapshotService } from "../services/snapshot-service.js";

const EVENT_LABELS: Record<ProtectionEvent, string> = {
  memberBan: "Mass Ban",
  channelDelete: "Xóa channel",
  channelCreate: "Tạo channel hàng loạt",
  channelUpdate: "Sửa channel hàng loạt",
  roleDelete: "Xóa role",
  roleUpdate: "Sửa role/quyền",
  botAdd: "Thêm bot lạ",
  webhookCreate: "Tạo webhook lạ",
  dangerousRoleGrant: "Cấp role nguy hiểm",
};

export const guardCommand = new SlashCommandBuilder()
  .setName("guard")
  .setDescription("Cấu hình Bot Anti-Raid Security")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false)
  .addSubcommand((command) =>
    command
      .setName("setup")
      .setDescription("Chọn kênh security log và chuẩn bị hệ thống")
      .addChannelOption((option) =>
        option
          .setName("log-channel")
          .setDescription("Kênh nhận cảnh báo bảo mật")
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(true),
      ),
  )
  .addSubcommand((command) => command.setName("status").setDescription("Xem trạng thái bảo vệ"))
  .addSubcommand((command) => command.setName("enable").setDescription("Bật hệ thống bảo vệ"))
  .addSubcommand((command) => command.setName("disable").setDescription("Tắt hệ thống bảo vệ"))
  .addSubcommand((command) =>
    command
      .setName("trust-user")
      .setDescription("Quản lý người dùng tin cậy")
      .addStringOption((option) =>
        option
          .setName("action")
          .setDescription("Thao tác")
          .setRequired(true)
          .addChoices({ name: "Thêm", value: "add" }, { name: "Gỡ", value: "remove" }),
      )
      .addUserOption((option) => option.setName("user").setDescription("Người dùng").setRequired(true)),
  )
  .addSubcommand((command) =>
    command
      .setName("trust-role")
      .setDescription("Quản lý role tin cậy")
      .addStringOption((option) =>
        option
          .setName("action")
          .setDescription("Thao tác")
          .setRequired(true)
          .addChoices({ name: "Thêm", value: "add" }, { name: "Gỡ", value: "remove" }),
      )
      .addRoleOption((option) => option.setName("role").setDescription("Role").setRequired(true)),
  )
  .addSubcommand((command) =>
    command
      .setName("trust-bot")
      .setDescription("Quản lý bot được phép tham gia server")
      .addStringOption((option) =>
        option
          .setName("action")
          .setDescription("Thao tác")
          .setRequired(true)
          .addChoices({ name: "Thêm", value: "add" }, { name: "Gỡ", value: "remove" }),
      )
      .addUserOption((option) => option.setName("bot").setDescription("Bot").setRequired(true)),
  )
  .addSubcommand((command) =>
    command
      .setName("threshold")
      .setDescription("Điều chỉnh ngưỡng phát hiện")
      .addStringOption((option) => {
        option.setName("event").setDescription("Loại sự kiện").setRequired(true);
        for (const event of PROTECTION_EVENTS) {
          option.addChoices({ name: EVENT_LABELS[event], value: event });
        }
        return option;
      })
      .addIntegerOption((option) =>
        option.setName("limit").setDescription("Số lần để kích hoạt").setMinValue(1).setMaxValue(25).setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName("window-seconds")
          .setDescription("Khoảng quan sát, tính bằng giây")
          .setMinValue(2)
          .setMaxValue(120)
          .setRequired(true),
      ),
  )
  .addSubcommand((command) =>
    command
      .setName("response-action")
      .setDescription("Chọn cách xử lý tác nhân")
      .addStringOption((option) =>
        option
          .setName("action")
          .setDescription("Phản ứng")
          .setRequired(true)
          .addChoices(
            { name: "Ban", value: "ban" },
            { name: "Kick", value: "kick" },
            { name: "Cách ly role", value: "quarantine" },
          ),
      ),
  )
  .addSubcommand((command) =>
    command
      .setName("message-guard")
      .setDescription("Bật hoặc tắt bảo vệ nội dung phối hợp")
      .addBooleanOption((option) => option.setName("enabled").setDescription("Trạng thái").setRequired(true)),
  )
  .addSubcommand((command) => command.setName("snapshot-create").setDescription("Tạo snapshot an toàn ngay"))
  .addSubcommand((command) =>
    command
      .setName("snapshot-restore")
      .setDescription("Khôi phục role/channel đang thiếu từ snapshot")
      .addStringOption((option) =>
        option.setName("confirm").setDescription("Nhập RESTORE để xác nhận").setRequired(true),
      ),
  )
  .addSubcommand((command) =>
    command
      .setName("lockdown")
      .setDescription("Bật hoặc gỡ Emergency Lockdown")
      .addStringOption((option) =>
        option
          .setName("mode")
          .setDescription("Chế độ")
          .setRequired(true)
          .addChoices({ name: "Bật", value: "on" }, { name: "Gỡ", value: "off" }),
      ),
  )
  .addSubcommand((command) =>
    command
      .setName("unlock")
      .setDescription("Mở khóa toàn bộ kênh ngay lập tức và khôi phục quyền chat cho mọi người"),
  )
  .addSubcommand((command) => command.setName("incidents").setDescription("Xem 10 sự cố gần nhất"));

export class GuardCommandHandler {
  constructor(
    private readonly store: JsonStore,
    private readonly snapshots: SnapshotService,
    private readonly responses: ResponseService,
  ) {}

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inCachedGuild()) {
      await interaction.reply({ content: "Lệnh này chỉ dùng trong server.", flags: MessageFlags.Ephemeral });
      return;
    }
    const member = interaction.member as GuildMember;
    if (!member.permissions.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: "Bạn cần quyền Administrator.", flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const subcommand = interaction.options.getSubcommand();
    const guild = interaction.guild;

    switch (subcommand) {
      case "setup":
        await this.setup(interaction, guild);
        break;
      case "status":
        await interaction.editReply({ embeds: [this.statusEmbed(guild)] });
        break;
      case "enable":
        await this.enable(interaction, guild);
        break;
      case "disable":
        await this.setEnabled(interaction, guild, false);
        break;
      case "trust-user":
        await this.updateTrust(interaction, guild, "trustedUserIds", interaction.options.getUser("user", true).id);
        break;
      case "trust-role":
        await this.updateTrust(interaction, guild, "trustedRoleIds", interaction.options.getRole("role", true).id);
        break;
      case "trust-bot": {
        const bot = interaction.options.getUser("bot", true);
        if (!bot.bot) {
          await interaction.editReply("Tài khoản được chọn không phải bot.");
          break;
        }
        await this.updateTrust(interaction, guild, "trustedBotIds", bot.id);
        break;
      }
      case "threshold":
        await this.updateThreshold(interaction, guild);
        break;
      case "response-action":
        await this.updateResponseAction(interaction, guild);
        break;
      case "message-guard":
        await this.updateMessageGuard(interaction, guild);
        break;
      case "snapshot-create":
        await this.createSnapshot(interaction, guild);
        break;
      case "snapshot-restore":
        await this.restoreSnapshot(interaction, guild);
        break;
      case "lockdown":
        await this.lockdown(interaction, guild);
        break;
      case "unlock":
        await this.unlock(interaction, guild);
        break;
      case "incidents":
        await interaction.editReply({ embeds: [this.incidentsEmbed(guild)] });
        break;
    }
  }

  private async setup(interaction: ChatInputCommandInteraction<"cached">, guild: Guild): Promise<void> {
    const channel = interaction.options.getChannel("log-channel", true);
    const config = this.store.getConfig(guild.id);
    config.logChannelId = channel.id;
    await this.store.setConfig(config);
    if (!this.store.getSnapshot(guild.id)) await this.snapshots.capture(guild);
    await interaction.editReply({
      embeds: [
        this.baseEmbed()
          .setTitle(`${emoji.shield} Thiết lập hoàn tất`)
          .setDescription(`Security log: <#${channel.id}>\nSnapshot nền đã sẵn sàng. Dùng \`/guard enable\` để bật bảo vệ.`),
      ],
    });
  }

  private async enable(interaction: ChatInputCommandInteraction<"cached">, guild: Guild): Promise<void> {
    const config = this.store.getConfig(guild.id);
    if (!config.logChannelId) {
      await interaction.editReply("Hãy chạy `/guard setup` và chọn kênh security log trước.");
      return;
    }
    const missing = this.missingBotPermissions(guild);
    if (missing.length > 0) {
      await interaction.editReply(`Bot đang thiếu quyền: ${missing.join(", ")}. Hãy cấp quyền và đặt role bot đủ cao.`);
      return;
    }
    if (!this.store.getSnapshot(guild.id)) await this.snapshots.capture(guild);
    await this.setEnabled(interaction, guild, true);
  }

  private async setEnabled(
    interaction: ChatInputCommandInteraction<"cached">,
    guild: Guild,
    enabled: boolean,
  ): Promise<void> {
    const config = this.store.getConfig(guild.id);
    config.enabled = enabled;
    await this.store.setConfig(config);
    await interaction.editReply({
      embeds: [
        this.baseEmbed()
          .setTitle(enabled ? `${emoji.shield} Bảo vệ đã bật` : "Bảo vệ đã tắt")
          .setDescription(
            enabled
              ? "Realtime detection, Message Guard và cơ chế phục hồi đang hoạt động."
              : "Bot vẫn online nhưng không phản ứng với sự kiện bảo mật.",
          ),
      ],
    });
  }

  private async updateTrust(
    interaction: ChatInputCommandInteraction<"cached">,
    guild: Guild,
    key: "trustedUserIds" | "trustedRoleIds" | "trustedBotIds",
    id: string,
  ): Promise<void> {
    const action = interaction.options.getString("action", true);
    const config = this.store.getConfig(guild.id);
    const values = new Set(config[key]);
    if (action === "add") values.add(id);
    else values.delete(id);
    config[key] = [...values];
    await this.store.setConfig(config);
    await interaction.editReply(`${action === "add" ? "Đã thêm" : "Đã gỡ"} đối tượng \`${id}\` trong trust tier.`);
  }

  private async updateThreshold(
    interaction: ChatInputCommandInteraction<"cached">,
    guild: Guild,
  ): Promise<void> {
    const event = interaction.options.getString("event", true) as ProtectionEvent;
    const limit = interaction.options.getInteger("limit", true);
    const windowSeconds = interaction.options.getInteger("window-seconds", true);
    const config = this.store.getConfig(guild.id);
    config.thresholds[event] = { limit, windowMs: windowSeconds * 1_000 };
    await this.store.setConfig(config);
    await interaction.editReply(`Đã đặt **${EVENT_LABELS[event]}**: ${limit} sự kiện trong ${windowSeconds} giây.`);
  }

  private async updateResponseAction(
    interaction: ChatInputCommandInteraction<"cached">,
    guild: Guild,
  ): Promise<void> {
    const config = this.store.getConfig(guild.id);
    config.enforcementAction = interaction.options.getString("action", true) as EnforcementAction;
    await this.store.setConfig(config);
    await interaction.editReply(`Phản ứng với tác nhân đã đặt thành: **${config.enforcementAction}**.`);
  }

  private async updateMessageGuard(
    interaction: ChatInputCommandInteraction<"cached">,
    guild: Guild,
  ): Promise<void> {
    const config = this.store.getConfig(guild.id);
    config.messageGuardEnabled = interaction.options.getBoolean("enabled", true);
    await this.store.setConfig(config);
    await interaction.editReply(`Message Guard: **${config.messageGuardEnabled ? "Bật" : "Tắt"}**.`);
  }

  private async createSnapshot(
    interaction: ChatInputCommandInteraction<"cached">,
    guild: Guild,
  ): Promise<void> {
    if (this.responses.isLockedDown(guild.id)) {
      await interaction.editReply("Không tạo snapshot trong lúc lockdown để tránh ghi đè trạng thái sạch.");
      return;
    }
    const snapshot = await this.snapshots.capture(guild);
    await interaction.editReply(
      `${emoji.restore} Đã lưu ${snapshot.channels.length} channel, ${snapshot.roles.length} role và ${Object.keys(snapshot.memberRoles).length} thành viên.`,
    );
  }

  private async restoreSnapshot(
    interaction: ChatInputCommandInteraction<"cached">,
    guild: Guild,
  ): Promise<void> {
    if (interaction.options.getString("confirm", true) !== "RESTORE") {
      await interaction.editReply("Chưa xác nhận. Nhập chính xác `RESTORE` để tiếp tục.");
      return;
    }
    const summary = await this.snapshots.restoreAllMissing(guild);
    await interaction.editReply(
      `${emoji.restore} Đã khôi phục ${summary.restoredChannels} channel và ${summary.restoredRoles} role. Lỗi: ${summary.failed.length}.`,
    );
  }

  private async unlock(
    interaction: ChatInputCommandInteraction<"cached">,
    guild: Guild,
  ): Promise<void> {
    const changed = await this.responses.disableLockdown(guild);
    const config = this.store.getConfig(guild.id);
    await this.responses.recordAndNotify(guild, config, {
      guildId: guild.id,
      event: "manualLockdown",
      executorId: interaction.user.id,
      targetIds: [],
      action: `gỡ lockdown ${changed} kênh`,
    });
    await interaction.editReply(`${emoji.lock} Đã gỡ bỏ Lockdown thành công trên **${changed} kênh**! Tất cả mọi người có thể chat bình thường.`);
  }

  private async lockdown(
    interaction: ChatInputCommandInteraction<"cached">,
    guild: Guild,
  ): Promise<void> {
    const mode = interaction.options.getString("mode", true);
    if (mode === "on" && !this.store.getSnapshot(guild.id)) {
      await this.snapshots.capture(guild);
    }
    const changed =
      mode === "on"
        ? await this.responses.enableLockdown(guild, `manual:${interaction.user.id}`)
        : await this.responses.disableLockdown(guild);
    const config = this.store.getConfig(guild.id);
    await this.responses.recordAndNotify(guild, config, {
      guildId: guild.id,
      event: "manualLockdown",
      executorId: interaction.user.id,
      targetIds: [],
      action: mode === "on" ? `lockdown ${changed} kênh` : `mở khóa ${changed} kênh`,
    });
    await interaction.editReply(`${emoji.lock} ${mode === "on" ? "Đã bật" : "Đã gỡ"} lockdown trên ${changed} kênh.`);
  }

  private statusEmbed(guild: Guild): EmbedBuilder {
    const config = this.store.getConfig(guild.id);
    const snapshot = this.store.getSnapshot(guild.id);
    const trustCount = config.trustedUserIds.length + config.trustedRoleIds.length + config.trustedBotIds.length;
    return this.baseEmbed()
      .setTitle(`${emoji.shield} Trạng thái bảo vệ`)
      .setDescription(config.enabled ? "Hệ thống đang bảo vệ server theo thời gian thực." : "Hệ thống đang tắt.")
      .addFields(
        { name: "Protection", value: config.enabled ? "ACTIVE" : "INACTIVE", inline: true },
        { name: "Message Guard", value: config.messageGuardEnabled ? "ACTIVE" : "INACTIVE", inline: true },
        { name: "Lockdown", value: this.responses.isLockedDown(guild.id) ? "ACTIVE" : "READY", inline: true },
        { name: "Trust entries", value: String(trustCount), inline: true },
        { name: "Response", value: config.enforcementAction.toUpperCase(), inline: true },
        {
          name: "Snapshot",
          value: snapshot ? `<t:${Math.floor(new Date(snapshot.createdAt).getTime() / 1_000)}:R>` : "Chưa có",
          inline: true,
        },
      );
  }

  private incidentsEmbed(guild: Guild): EmbedBuilder {
    const incidents = this.store.getIncidents(guild.id, 10);
    const body = incidents.length
      ? incidents
          .map(
            (item) =>
              `\`${item.createdAt.slice(0, 16).replace("T", " ")}\` **${item.event}** — ${item.action}`,
          )
          .join("\n")
      : "Chưa ghi nhận sự cố.";
    return this.baseEmbed().setTitle("Lịch sử bảo mật").setDescription(body.slice(0, 4_000));
  }

  private baseEmbed(): EmbedBuilder {
    return new EmbedBuilder()
      .setColor(0xe11d48)
      .setAuthor({ name: "BOT ANTI-RAID SECURITY" })
      .setFooter({ text: "Security without noise" })
      .setTimestamp();
  }

  private missingBotPermissions(guild: Guild): string[] {
    const member = guild.members.me;
    if (!member) return ["Bot chưa sẵn sàng trong server"];
    const required = [
      [PermissionFlagsBits.ViewAuditLog, "View Audit Log"],
      [PermissionFlagsBits.ManageGuild, "Manage Server"],
      [PermissionFlagsBits.ManageChannels, "Manage Channels"],
      [PermissionFlagsBits.ManageRoles, "Manage Roles"],
      [PermissionFlagsBits.BanMembers, "Ban Members"],
      [PermissionFlagsBits.KickMembers, "Kick Members"],
      [PermissionFlagsBits.ManageWebhooks, "Manage Webhooks"],
      [PermissionFlagsBits.ManageMessages, "Manage Messages"],
      [PermissionFlagsBits.ModerateMembers, "Timeout Members"],
      [PermissionFlagsBits.ViewChannel, "View Channels"],
      [PermissionFlagsBits.SendMessages, "Send Messages"],
      [PermissionFlagsBits.EmbedLinks, "Embed Links"],
    ] as const;
    return required.filter(([permission]) => !member.permissions.has(permission)).map(([, name]) => name);
  }
}
