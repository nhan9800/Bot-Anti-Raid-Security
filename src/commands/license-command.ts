import {
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { LicenseService } from "../services/license-service.js";
import { JsonStore } from "../store/json-store.js";
import { ResponseService } from "../services/response-service.js";
import { SnapshotService } from "../services/snapshot-service.js";
import { unlockGuildProtection } from "../services/unlock-service.js";

const BOT_OWNER_IDS = ["1143387904064888942", "1138315103821889566", "1516603522584416376"];

export const kichhoatCommand = new SlashCommandBuilder()
  .setName("kichhoat")
  .setDescription("Kích hoạt bản quyền MIMI SHIELD cho máy chủ bằng mã License Key")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption((o) =>
    o
      .setName("mã_key")
      .setDescription("Mã License Key dạng MIMI-SHIELD-XXXX-XXXX-XXXX")
      .setRequired(true)
  );

export const licenseCommand = new SlashCommandBuilder()
  .setName("license")
  .setDescription("Xem thông tin bản quyền và Server ID (HWID) của máy chủ hiện tại");

export const xacnhanCommand = new SlashCommandBuilder()
  .setName("xacnhan")
  .setDescription("[Admin] Xác nhận đã nhận tiền và kích hoạt ngay bản quyền cho Server ID")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption((o) =>
    o.setName("server_id").setDescription("Server ID (Guild ID) của máy chủ khách hàng").setRequired(true)
  )
  .addStringOption((o) =>
    o
      .setName("gói")
      .setDescription("Gói bản quyền kích hoạt")
      .setRequired(true)
      .addChoices(
        { name: "🌟 Gói 1 Tháng (50.000đ - 30 ngày)", value: "1m" },
        { name: "💎 Gói 3 Tháng (140.000đ - 90 ngày)", value: "3m" },
        { name: "👑 Gói 12 Tháng (390.000đ - 365 ngày)", value: "12m" },
        { name: "♾️ Gói Vĩnh Viễn (Lifetime VIP)", value: "permanent" }
      )
  )
  .addStringOption((o) =>
    o.setName("ghi_chú").setDescription("Ghi chú bill / tên người mua").setRequired(false)
  );

export const genkeyCommand = new SlashCommandBuilder()
  .setName("genkey")
  .setDescription("[Admin] Tạo mã License Key bản quyền để cấp cho khách hàng")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption((o) =>
    o
      .setName("gói")
      .setDescription("Gói bản quyền cần tạo")
      .setRequired(true)
      .addChoices(
        { name: "🌟 Gói 1 Tháng (50.000đ - 30 ngày)", value: "1m" },
        { name: "💎 Gói 3 Tháng (140.000đ - 90 ngày)", value: "3m" },
        { name: "👑 Gói 12 Tháng (390.000đ - 365 ngày)", value: "12m" }
      )
  )
  .addIntegerOption((o) =>
    o
      .setName("số_lượng")
      .setDescription("Số lượng mã key muốn tạo (1-20)")
      .setMinValue(1)
      .setMaxValue(20)
      .setRequired(false)
  )
  .addStringOption((o) =>
    o.setName("ghi_chú").setDescription("Ghi chú người mua / lý do tạo").setRequired(false)
  );

export class LicenseCommandHandler {
  private readonly licenseService: LicenseService;
  private readonly store: JsonStore;
  private readonly responses: ResponseService;
  private readonly snapshots: SnapshotService;
  private readonly client: Client;

  constructor(
    licenseService: LicenseService,
    store: JsonStore,
    responses: ResponseService,
    snapshots: SnapshotService,
    client: Client
  ) {
    this.licenseService = licenseService;
    this.store = store;
    this.responses = responses;
    this.snapshots = snapshots;
    this.client = client;
  }

  public async handleKichhoat(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild) {
      await interaction.reply({ content: "❌ Lệnh này chỉ dùng được trong máy chủ.", ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const key = interaction.options.getString("mã_key", true).trim();
    const result = this.licenseService.redeemKey(interaction.guild.id, key, interaction.user.tag);

    if (!result.ok || !result.license) {
      await interaction.editReply({
        content: `❌ **Kích hoạt thất bại:** ${result.error || "Mã key không hợp lệ."}`,
      });
      return;
    }

    // 🚀 TỰ ĐỘNG MỞ KHÓA HOÀN TOÀN HỆ THỐNG BẢO VỆ
    const unlock = await unlockGuildProtection(
      interaction.guild.id,
      this.store,
      this.responses,
      this.snapshots,
      this.client
    );

    const embed = new EmbedBuilder()
      .setColor("#00FFA3")
      .setTitle("🎉 KÍCH HOẠT BẢN QUYỀN & MỞ KHÓA TOÀN DIỆN THÀNH CÔNG!")
      .setDescription(
        `Chúc mừng máy chủ **${interaction.guild.name}** đã kích hoạt thành công gói **${result.planName}**!\n\n` +
          `🛡️ **HỆ THỐNG AN NINH ĐÃ TỰ ĐỘNG MỞ KHÓA 100%:**\n` +
          `• 🟢 **Lá Chắn Anti-Raid:** TỰ ĐỘNG BẬT (Bảo vệ 24/7)\n` +
          `• ⚡ **Anti-Nuke Kênh & Role:** Phản xạ 0.1s sẵn sàng\n` +
          `• 🤖 **Chống Bot Lạ & Webhook:** Tự động kick/ban bot chưa xác minh\n` +
          `• 👥 **Message Guard:** Quét mã độc & link lừa đảo realtime\n` +
          `• 📸 **Snapshot Cấu Trúc:** ${unlock.snapshotTaken ? "Đã sao lưu an toàn toàn bộ channel/role gốc" : "Sẵn sàng tự động sao lưu"}\n` +
          (unlock.channelsUnlocked > 0 ? `• 🔓 **Emergency Lockdown:** Đã tự động mở lại ${unlock.channelsUnlocked} kênh chat\n` : "")
      )
      .addFields(
        { name: "🛡️ Server ID (HWID)", value: `\`${interaction.guild.id}\``, inline: true },
        { name: "📦 Gói Kích Hoạt", value: `**${result.planName}**`, inline: true },
        { name: "⏳ Thời Gian Cộng Thêm", value: `+**${result.daysAdded} ngày**`, inline: true },
        {
          name: "📅 Hạn Bản Quyền Mới",
          value: result.license.isPermanent
            ? "`Vĩnh Viễn (Lifetime)`"
            : `<t:${Math.floor((result.license.expiresTimestamp || 0) / 1000)}:F>`,
          inline: false,
        }
      )
      .setFooter({ text: "Dữ liệu được đồng bộ trực tiếp với Website https://mimibot.id.vn" })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }

  public async handleLicense(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.guild) {
      await interaction.reply({ content: "❌ Lệnh này chỉ dùng được trong máy chủ.", ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const lic = this.licenseService.getLicense(interaction.guild.id);

    const embed = new EmbedBuilder()
      .setColor(lic.active ? "#2ECC71" : "#FF3366")
      .setTitle("🛡️ THÔNG TIN BẢN QUYỀN MIMI SHIELD BOT")
      .setDescription(
        `Thông tin bản quyền và trạng thái bảo vệ an ninh của máy chủ **${interaction.guild.name}**:`
      )
      .addFields(
        { name: "🆔 Server ID (HWID)", value: `\`${interaction.guild.id}\``, inline: true },
        {
          name: "⚡ Trạng Thái",
          value: lic.active ? "🟢 **ĐANG HOẠT ĐỘNG (ACTIVE)**" : "🔴 **CHƯA KÍCH HOẠT / HẾT HẠN**",
          inline: true,
        },
        { name: "📦 Gói Bản Quyền", value: `**${lic.planName}**`, inline: true },
        {
          name: "⏳ Thời Hạn Còn Lại",
          value: lic.isPermanent
            ? "`Vĩnh Viễn (Lifetime VIP)`"
            : lic.active
            ? `**${lic.remainingDays} ngày** (${lic.remainingHours} giờ)`
            : "`0 ngày`",
          inline: true,
        },
        {
          name: "📅 Ngày Hết Hạn",
          value: lic.isPermanent
            ? "`Vĩnh Viễn`"
            : lic.expiresTimestamp
            ? `<t:${Math.floor(lic.expiresTimestamp / 1000)}:F>`
            : "`Chưa có`",
          inline: true,
        }
      )
      .setFooter({ text: "Gia hạn & Kích hoạt bản quyền tại https://mimibot.id.vn/pricing" })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }

  public async handleXacnhan(interaction: ChatInputCommandInteraction): Promise<void> {
    const isOwner = BOT_OWNER_IDS.includes(interaction.user.id);
    if (!isOwner && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: "❌ Chỉ Quản trị viên / Owner mới có quyền duyệt bản quyền.", ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const targetGuildId = interaction.options.getString("server_id", true).trim();
    const plan = interaction.options.getString("gói", true);
    const note = interaction.options.getString("ghi_chú") || `Confirmed by ${interaction.user.tag}`;

    if (!targetGuildId || !/^\d{16,22}$/.test(targetGuildId)) {
      await interaction.editReply({ content: "❌ Server ID không hợp lệ (phải là dãy 17-20 chữ số)." });
      return;
    }

    const updatedLic = this.licenseService.grantLicense(
      targetGuildId,
      plan,
      null,
      `Discord Admin: ${interaction.user.tag} (${note})`
    );

    // 🚀 TỰ ĐỘNG MỞ KHÓA HOÀN TOÀN BẢO VỆ CHO MÁY CHỦ KHÁCH HÀNG
    await unlockGuildProtection(
      targetGuildId,
      this.store,
      this.responses,
      this.snapshots,
      this.client
    );

    const embed = new EmbedBuilder()
      .setColor("#2ECC71")
      .setTitle("✅ ĐÃ XÁC NHẬN THANH TOÁN & KÍCH HOẠT THÀNH CÔNG!")
      .setDescription(
        `Hệ thống đã cập nhật bản quyền MIMI SHIELD và mở khóa bảo vệ cho máy chủ **${targetGuildId}**.`
      )
      .addFields(
        { name: "🛡️ Server ID (HWID)", value: `\`${targetGuildId}\``, inline: true },
        { name: "📦 Gói Kích Hoạt", value: `**${updatedLic.planName}**`, inline: true },
        {
          name: "⏳ Hạn Bản Quyền",
          value: updatedLic.isPermanent
            ? "`Vĩnh Viễn (Lifetime)`"
            : `<t:${Math.floor((updatedLic.expiresTimestamp || 0) / 1000)}:F> (+${updatedLic.remainingDays} ngày)`,
          inline: false,
        },
        { name: "👤 Người Duyệt", value: `${interaction.user.tag}`, inline: true },
        { name: "📝 Ghi Chú", value: note, inline: true }
      )
      .setFooter({ text: "Dữ liệu đã được đồng bộ tự động với Website https://mimibot.id.vn" })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }

  public async handleGenkey(interaction: ChatInputCommandInteraction): Promise<void> {
    const isOwner = BOT_OWNER_IDS.includes(interaction.user.id);
    if (!isOwner && !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: "❌ Chỉ Quản trị viên / Creator mới có quyền tạo mã Key.", ephemeral: true });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const plan = interaction.options.getString("gói", true);
    const count = interaction.options.getInteger("số_lượng") || 1;
    const note = interaction.options.getString("ghi_chú") || `Created by ${interaction.user.tag}`;

    const keys = this.licenseService.generateKeys(plan, count, note, interaction.user.tag);
    const keyText = keys
      .map((k, i) => `${i + 1}. \`${k.key}\` — **${k.planName}** (${k.durationDays} ngày)`)
      .join("\n");

    const embed = new EmbedBuilder()
      .setColor("#F1C40F")
      .setTitle(`🔑 ĐÃ TẠO THÀNH CÔNG ${count} MÃ LICENSE KEY`)
      .setDescription(`Danh sách mã key mới tạo (gửi mã này cho khách hàng):\n\n${keyText}`)
      .setFooter({ text: "Khách có thể nhập mã bằng lệnh /kichhoat hoặc trên website mimibot.id.vn" })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }
}
