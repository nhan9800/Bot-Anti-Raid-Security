import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  PermissionsBitField,
  type Guild,
  type GuildTextBasedChannel,
  type GuildMember,
  type MessageCreateOptions,
} from "discord.js";
import type { GuildConfig, IncidentRecord, ProtectionEvent } from "../domain/types.js";
import { emoji } from "../config.js";
import { logger } from "../logger.js";
import { JsonStore } from "../store/json-store.js";

const DANGEROUS_PERMISSIONS = new PermissionsBitField([
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.ModerateMembers,
]);

const LOCKDOWN_PERMISSIONS = [
  "SendMessages",
  "AddReactions",
  "CreatePublicThreads",
  "CreatePrivateThreads",
  "SendMessagesInThreads",
] as const;

export interface EnforcementResult {
  action: string;
  success: boolean;
  detail: string;
}

export class ResponseService {
  constructor(private readonly store: JsonStore) {}

  isLockedDown(guildId: string): boolean {
    return this.store.getConfig(guildId).lockdownActive;
  }

  async enforce(guild: Guild, executorId: string, config: GuildConfig): Promise<EnforcementResult> {
    if (executorId === guild.ownerId) {
      return { action: "alert-only", success: false, detail: "Không thể xử lý chủ server" };
    }

    let member: GuildMember;
    try {
      member = await guild.members.fetch(executorId);
    } catch {
      return { action: "not-in-guild", success: true, detail: "Tài khoản đã rời server" };
    }

    try {
      if (config.enforcementAction === "ban" && member.bannable) {
        await member.ban({ reason: "Bot Anti-Raid Security: phát hiện hành vi phá hoại" });
        return { action: "ban", success: true, detail: "Đã ban tác nhân" };
      }
      if (config.enforcementAction === "kick" && member.kickable) {
        await member.kick("Bot Anti-Raid Security: phát hiện hành vi phá hoại");
        return { action: "kick", success: true, detail: "Đã kick tác nhân" };
      }

      const dangerousRoles = member.roles.cache.filter(
        (role) => role.id !== guild.id && role.editable && role.permissions.any(DANGEROUS_PERMISSIONS),
      );
      if (dangerousRoles.size === 0) {
        return {
          action: "quarantine",
          success: false,
          detail: "Không có role nguy hiểm nào bot có thể gỡ",
        };
      }
      await member.roles.remove(dangerousRoles, "Bot Anti-Raid Security: cách ly tác nhân");
      return { action: "quarantine", success: true, detail: `Đã gỡ ${dangerousRoles.size} role nguy hiểm` };
    } catch (error) {
      logger.error({ guildId: guild.id, executorId, error }, "Không thể xử lý tác nhân");
      return { action: config.enforcementAction, success: false, detail: "Bot thiếu quyền hoặc role thấp hơn tác nhân" };
    }
  }

  async enableLockdown(guild: Guild, reason: string, force = false): Promise<number> {
    if (this.isLockedDown(guild.id) && !force) return 0;

    const me = guild.members.me;
    if (!me) return 0;

    const editable = guild.channels.cache.filter(
      (channel) =>
        !channel.isThread() &&
        channel.type !== ChannelType.GuildCategory &&
        "permissionOverwrites" in channel &&
        channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageChannels),
    );

    let changed = 0;
    for (const channel of editable.values()) {
      if (!("permissionOverwrites" in channel)) continue;
      try {
        await channel.permissionOverwrites.edit(
          guild.roles.everyone,
          Object.fromEntries(LOCKDOWN_PERMISSIONS.map((permission) => [permission, false])),
          { reason: `Bot Anti-Raid Security lockdown: ${reason}` },
        );
        changed += 1;
      } catch (error: any) {
        if (error?.code !== 50001 && error?.code !== 50013) {
          logger.warn({ guildId: guild.id, channelId: channel.id, message: error?.message }, "Không thể khóa channel");
        }
      }
    }
    const config = this.store.getConfig(guild.id);
    config.lockdownActive = true;
    await this.store.setConfig(config);
    return changed;
  }

  async disableLockdown(guild: Guild): Promise<number> {
    const me = guild.members.me;
    if (!me) return 0;

    const snapshot = this.store.getSnapshot(guild.id);
    let changed = 0;
    for (const channel of guild.channels.cache.values()) {
      if (
        channel.isThread() ||
        channel.type === ChannelType.GuildCategory ||
        !("permissionOverwrites" in channel) ||
        !channel.permissionsFor(me)?.has(PermissionFlagsBits.ManageChannels)
      ) {
        continue;
      }

      const saved = snapshot?.channels.find((item) => item.id === channel.id);
      const everyone = saved?.permissionOverwrites.find((item) => item.id === guild.id);
      const allow = new PermissionsBitField(everyone ? BigInt(everyone.allow) : 0n);
      // Gỡ bỏ hoàn toàn mọi cấm đoán (đặt null để inherit/cho phép chat, hoặc true nếu snapshot cho phép)
      const restored = Object.fromEntries(
        LOCKDOWN_PERMISSIONS.map((permission) => {
          const bit = PermissionFlagsBits[permission];
          return [permission, allow.has(bit) ? true : null];
        }),
      );
      try {
        await channel.permissionOverwrites.edit(guild.roles.everyone, restored, {
          reason: "MIMI SHIELD: mở khóa toàn bộ kênh cho thành viên chat bình thường",
        });
        changed += 1;
      } catch (error: any) {
        if (error?.code !== 50001 && error?.code !== 50013) {
          logger.warn({ guildId: guild.id, channelId: channel.id, message: error?.message }, "Không thể mở khóa channel");
        }
      }
    }
    const config = this.store.getConfig(guild.id);
    config.lockdownActive = false;
    await this.store.setConfig(config);
    return changed;
  }

  async recordAndNotify(
    guild: Guild,
    config: GuildConfig,
    incident: Omit<IncidentRecord, "id" | "createdAt">,
  ): Promise<void> {
    const record: IncidentRecord = {
      ...incident,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    await this.store.addIncident(record);

    if (!config.logChannelId) return;
    const channel = guild.channels.cache.get(config.logChannelId);
    if (!channel?.isTextBased()) return;
    await this.sendIncidentLog(channel, record);
  }

  async notifyError(guild: Guild, config: GuildConfig, title: string, details: string): Promise<void> {
    if (!config.logChannelId) return;
    const channel = guild.channels.cache.get(config.logChannelId);
    if (!channel?.isTextBased()) return;
    const embed = new EmbedBuilder()
      .setColor(0xdc2626)
      .setAuthor({ name: "BOT ANTI-RAID SECURITY" })
      .setTitle(`${emoji.alert} ${title}`)
      .setDescription(details)
      .setTimestamp();
    await this.safeSend(channel, { embeds: [embed], allowedMentions: { parse: [] } });
  }

  private async sendIncidentLog(channel: GuildTextBasedChannel, incident: IncidentRecord): Promise<void> {
    const embed = new EmbedBuilder()
      .setColor(0xe11d48)
      .setAuthor({ name: "BOT ANTI-RAID SECURITY" })
      .setTitle(`${emoji.shield} Mối đe dọa đã được xử lý`)
      .addFields(
        { name: "Loại", value: this.eventName(incident.event), inline: true },
        { name: "Phản ứng", value: incident.action, inline: true },
        { name: "Tác nhân", value: incident.executorId ? `<@${incident.executorId}>` : "Không xác định", inline: true },
        { name: "Mục tiêu", value: `${incident.targetIds.length} đối tượng`, inline: true },
      )
      .setFooter({ text: `Incident ${incident.id.slice(0, 8)}` })
      .setTimestamp(new Date(incident.createdAt));
    if (incident.details) embed.setDescription(incident.details.slice(0, 4_000));
    await this.safeSend(channel, { embeds: [embed], allowedMentions: { parse: [] } });
  }

  private eventName(event: IncidentRecord["event"]): string {
    const names: Record<IncidentRecord["event"], string> = {
      memberBan: "Mass Ban",
      channelDelete: "Channel Nuke",
      channelCreate: "Channel Create Spam",
      channelUpdate: "Channel Edit Spam",
      roleDelete: "Role Delete",
      roleUpdate: "Role Permission Change",
      botAdd: "Bot lạ",
      webhookCreate: "Webhook lạ",
      dangerousRoleGrant: "Cấp quyền nguy hiểm",
      messageRaid: "Raid nội dung phối hợp",
      manualLockdown: "Lockdown thủ công",
    };
    return names[event];
  }

  private async safeSend(channel: GuildTextBasedChannel, payload: MessageCreateOptions) {
    try {
      await channel.send(payload);
    } catch (error) {
      logger.warn({ channelId: channel.id, error }, "Không thể gửi security log");
    }
  }
}

export type CriticalProtectionEvent = Extract<
  ProtectionEvent,
  "memberBan" | "channelDelete" | "roleDelete" | "botAdd" | "webhookCreate" | "dangerousRoleGrant"
>;
