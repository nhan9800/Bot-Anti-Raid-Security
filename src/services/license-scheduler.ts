import {
  ChannelType,
  Client,
  EmbedBuilder,
  Guild,
  PermissionFlagsBits,
} from "discord.js";
import { LicenseService, LicenseInfo } from "./license-service.js";
import { logger } from "../logger.js";
import type { JsonStore } from "../store/json-store.js";
import type { ResponseService } from "./response-service.js";
import type { SnapshotService } from "./snapshot-service.js";
import { unlockGuildProtection } from "./unlock-service.js";

const HOME_GUILD_IDS = ["1517068246493429852"];

export class LicenseScheduler {
  private readonly licenseService: LicenseService;
  private readonly client: Client;
  private readonly store: JsonStore | undefined;
  private readonly responses: ResponseService | undefined;
  private readonly snapshots: SnapshotService | undefined;

  constructor(
    licenseService: LicenseService,
    client: Client,
    store?: JsonStore | undefined,
    responses?: ResponseService | undefined,
    snapshots?: SnapshotService | undefined
  ) {
    this.licenseService = licenseService;
    this.client = client;
    this.store = store;
    this.responses = responses;
    this.snapshots = snapshots;
  }

  private findNotifyChannel(guild: Guild) {
    if (
      guild.systemChannel &&
      guild.systemChannel.permissionsFor(guild.members.me!)?.has(PermissionFlagsBits.SendMessages)
    ) {
      return guild.systemChannel;
    }
    return (
      guild.channels.cache.find(
        (c) =>
          (c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement) &&
          c.permissionsFor(guild.members.me!)?.has(PermissionFlagsBits.SendMessages)
      ) || null
    );
  }

  public buildRequireActivationEmbed(guild: Guild): EmbedBuilder {
    return new EmbedBuilder()
      .setColor("#FFA500")
      .setTitle("🔒 [YÊU CẦU KÍCH HOẠT BẢN QUYỀN] MIMI SHIELD ANTI-RAID")
      .setDescription(
        `Cảm ơn bạn đã mời **MIMI SHIELD BOT** vào máy chủ **${guild.name}**!\n\n` +
          `⚠️ **MÁY CHỦ CHƯA ĐƯỢC KÍCH HOẠT BẢN QUYỀN.**\n` +
          `Toàn bộ hệ thống bảo vệ Anti-Raid, Anti-Nuke, Khôi phục Channel & Snapshot đang ở **trạng thái khóa** cho đến khi được kích hoạt bản quyền hợp lệ.\n\n` +
          `👉 **CÁCH KÍCH HOẠT:**\n` +
          `Gõ lệnh: **\`/kichhoat mã_key: [MÃ_KEY_CỦA_BẠN]\`**\n` +
          `*(Hoặc kích hoạt trực tiếp trên website https://mimibot.id.vn/pricing)*`
      )
      .addFields(
        {
          name: "💎 3 Gói Bản Quyền Chính Thức",
          value:
            "• **Gói 1 Tháng**: `50.000đ` (30 ngày)\n" +
            "• **Gói 3 Tháng**: `140.000đ` *(Tiết kiệm 10k - 90 ngày)*\n" +
            "• **Gói 12 Tháng**: `390.000đ` *(VIP Tiết kiệm 210k - 365 ngày)*",
        },
        {
          name: "💳 Chuyển Khoản Vietcombank (Tự Động)",
          value:
            "• Số TK: **`9369144188`** (Vietcombank)\n" +
            "• Chủ TK: **DAO NGOC QUANG**\n" +
            `• Cú pháp CK: **\`MIMI 1M ${guild.id}\`** (hoặc **\`MIMI 3M ${guild.id}\`**, **\`MIMI 12M ${guild.id}\`**)`,
        },
        {
          name: "⏳ Lưu Ý Tự Động Rời Server",
          value: "Nếu sau **30 phút** máy chủ không được kích hoạt bản quyền, bot sẽ **tự động rời khỏi máy chủ**.",
        }
      )
      .setFooter({ text: `Server ID (HWID): ${guild.id} • Liên hệ Admin để nhận License Key` })
      .setTimestamp();
  }

  public buildExpiredFarewellEmbed(guild: Guild, license: LicenseInfo): EmbedBuilder {
    return new EmbedBuilder()
      .setColor("#FF3366")
      .setTitle("⚠️ [THÔNG BÁO] HẾT HẠN BẢN QUYỀN MIMI SHIELD")
      .setDescription(
        `Kính gửi Quản trị viên máy chủ **${guild.name}**,\n\n` +
          `Gói bản quyền bảo vệ Anti-Raid **${license.planName}** của máy chủ đã **HẾT HẠN** (hoặc chưa kích hoạt Key sau thời gian chờ).\n\n` +
          `MIMI SHIELD BOT sẽ **tự động rời khỏi máy chủ** sau thông báo này.`
      )
      .addFields(
        {
          name: "💎 Bảng Giá Gia Hạn & Mua Mới",
          value:
            "• **Gói 1 Tháng**: `50.000đ` (30 ngày)\n" +
            "• **Gói 3 Tháng**: `140.000đ` *(90 ngày)*\n" +
            "• **Gói 12 Tháng**: `390.000đ` *(VIP 365 ngày)*",
        },
        {
          name: "💳 Hướng Dẫn Gia Hạn",
          value:
            "1. Chuyển khoản đến Vietcombank: **`9369144188`** (Chủ TK: `DAO NGOC QUANG`)\n" +
            `2. Nội dung CK: **\`MIMI 1M ${guild.id}\`**\n` +
            "3. Hoặc mua License Key trên https://mimibot.id.vn/pricing rồi mời lại bot!",
        }
      )
      .setFooter({ text: `Server ID (HWID): ${guild.id} • Hẹn gặp lại máy chủ của bạn!` })
      .setTimestamp();
  }

  public async checkAllGuilds(): Promise<void> {
    if (!this.client.isReady()) return;

    for (const guild of this.client.guilds.cache.values()) {
      try {
        if (HOME_GUILD_IDS.includes(guild.id)) continue;

        const lic = this.licenseService.getLicense(guild.id);
        if (lic.isPermanent) continue;

        // Nếu hết hạn hoặc chưa kích hoạt
        if (lic.expired) {
          const joinedAt = guild.joinedTimestamp || Date.now();
          const stayMs = Date.now() - joinedAt;

          if (lic.activatedAt || stayMs > 30 * 60 * 1000) {
            logger.warn(
              { guildId: guild.id, guildName: guild.name },
              "Máy chủ chưa kích hoạt hoặc đã hết hạn bản quyền -> Tự động rời server"
            );

            const channel = this.findNotifyChannel(guild);
            if (channel && "send" in channel) {
              const embed = this.buildExpiredFarewellEmbed(guild, lic);
              await channel.send({ embeds: [embed] }).catch(() => null);
            }

            try {
              const owner = await guild.fetchOwner().catch(() => null);
              if (owner) {
                const dmEmbed = this.buildExpiredFarewellEmbed(guild, lic);
                await owner.send({ embeds: [dmEmbed] }).catch(() => null);
              }
            } catch {}

            setTimeout(() => {
              guild.leave().catch((e: unknown) => logger.error({ guildId: guild.id, error: e }, "Lỗi khi rời guild"));
            }, 5000);
          }
          continue;
        }

        // Cảnh báo sắp hết hạn (3 ngày và 1 ngày)
        if (lic.active && lic.remainingDays <= 3 && !lic.warned3Days) {
          this.licenseService.markWarning(guild.id, "3days");
          const channel = this.findNotifyChannel(guild);
          if (channel && "send" in channel) {
            const embed = new EmbedBuilder()
              .setColor("#FFAA00")
              .setTitle(`⏳ [CẢNH BÁO] BẢN QUYỀN MIMI SHIELD CÒN ${lic.remainingDays} NGÀY`)
              .setDescription(
                `Bản quyền bảo vệ máy chủ **${guild.name}** sắp hết hạn trong vòng **${lic.remainingDays} ngày** tới.\n` +
                  `Vui lòng gia hạn sớm tại https://mimibot.id.vn/pricing để không bị gián đoạn bảo vệ!`
              )
              .setFooter({ text: `Server ID: ${guild.id}` })
              .setTimestamp();
            await channel.send({ embeds: [embed] }).catch(() => null);
          }
        } else if (lic.active && lic.remainingDays <= 1 && !lic.warned1Day) {
          this.licenseService.markWarning(guild.id, "1day");
          const channel = this.findNotifyChannel(guild);
          if (channel && "send" in channel) {
            const embed = new EmbedBuilder()
              .setColor("#FF3333")
              .setTitle("🚨 [KHẨN CẤP] BẢN QUYỀN MIMI SHIELD SẼ HẾT HẠN TRONG 24H")
              .setDescription(
                `Bản quyền máy chủ **${guild.name}** sẽ chính thức **HẾT HẠN HÔM NAY**.\n` +
                  `Bot sẽ tự động rời khỏi máy chủ khi hết hạn nếu chưa gia hạn.`
              )
              .setFooter({ text: `Server ID: ${guild.id}` })
              .setTimestamp();
            await channel.send({ embeds: [embed] }).catch(() => null);
          }
        }
      } catch (err: unknown) {
        logger.error({ guildId: guild.id, error: err }, "Lỗi kiểm tra bản quyền guild");
      }
    }
  }

  public async handleGuildCreate(guild: Guild): Promise<void> {
    if (!guild || HOME_GUILD_IDS.includes(guild.id)) return;

    const lic = this.licenseService.getLicense(guild.id);
    if (lic.active) {
      logger.info(
        { guildId: guild.id, guildName: guild.name },
        "MIMI SHIELD vừa tham gia server đã có bản quyền -> Kích hoạt mở khóa bảo vệ 24/7"
      );
      if (this.store && this.responses && this.snapshots) {
        await unlockGuildProtection(guild.id, this.store, this.responses, this.snapshots, this.client);
      }
      return;
    }

    if (!lic.active) {
      logger.info(
        { guildId: guild.id, guildName: guild.name },
        "MIMI SHIELD vừa tham gia server mới -> Gửi thông báo yêu cầu kích hoạt Key"
      );

      const channel = this.findNotifyChannel(guild);
      if (channel && "send" in channel) {
        const embed = this.buildRequireActivationEmbed(guild);
        await channel.send({ embeds: [embed] }).catch(() => null);
      }

      try {
        const owner = await guild.fetchOwner().catch(() => null);
        if (owner) {
          const embed = this.buildRequireActivationEmbed(guild);
          await owner.send({ embeds: [embed] }).catch(() => null);
        }
      } catch {}
    }
  }

  public start(intervalMinutes = 10): void {
    setInterval(() => {
      void this.checkAllGuilds();
    }, intervalMinutes * 60_000).unref();
  }
}
