import {
  AuditLogEvent,
  PermissionFlagsBits,
  PermissionsBitField,
  type Guild,
  type GuildAuditLogsEntry,
} from "discord.js";
import type { GuildConfig, ProtectionEvent } from "../domain/types.js";
import { logger } from "../logger.js";
import { JsonStore } from "../store/json-store.js";
import { ResponseService } from "./response-service.js";
import { SlidingWindow } from "./sliding-window.js";
import { SnapshotService, type RestoreSummary } from "./snapshot-service.js";
import { TrustService } from "./trust-service.js";

const CRITICAL_EVENTS = new Set<ProtectionEvent>([
  "memberBan",
  "channelDelete",
  "roleDelete",
  "botAdd",
  "webhookCreate",
  "dangerousRoleGrant",
]);

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

interface MappedEntry {
  event: ProtectionEvent;
  targetId: string;
}

export class SecurityEngine {
  private readonly windows = new SlidingWindow<string>();
  private readonly lastUntrustedActivity = new Map<string, number>();

  constructor(
    private readonly store: JsonStore,
    private readonly trust: TrustService,
    private readonly snapshots: SnapshotService,
    private readonly responses: ResponseService,
  ) {}

  async handleAuditEntry(entry: GuildAuditLogsEntry, guild: Guild): Promise<void> {
    const config = this.store.getConfig(guild.id);
    if (!config.enabled || !entry.executorId) return;

    const mapped = this.mapEntry(entry);
    if (!mapped) return;
    if (mapped.event === "dangerousRoleGrant" && !this.isDangerousRoleGrant(entry, guild)) return;
    if (mapped.event === "botAdd" && (config.trustedBotIds.includes(mapped.targetId) || mapped.targetId === "1516603522584416376" || mapped.targetId === "1539527939723497473")) return;

    const trust = await this.trust.evaluate(guild, entry.executorId, config);
    if (trust.trusted) {
      // Người thuộc danh sách tin cậy hoặc Admin thêm bot thì được phép
      return;
    }
    this.lastUntrustedActivity.set(guild.id, Date.now());

    const threshold = config.thresholds[mapped.event];
    const key = `${guild.id}:${entry.executorId}:${mapped.event}`;
    const result = this.windows.add(key, mapped.targetId, threshold.limit, threshold.windowMs);
    if (!result.triggered) return;
    this.windows.clear(key);

    const targetIds = [...new Set(result.occurrences.map((item) => item.value))];
    try {
      await this.respond(guild, config, mapped.event, entry.executorId, targetIds);
    } catch (error) {
      logger.error(
        { guildId: guild.id, executorId: entry.executorId, event: mapped.event, error },
        "Security response thất bại",
      );
      await this.responses.notifyError(
        guild,
        config,
        "Phản ứng bảo mật chưa hoàn tất",
        `Sự kiện: ${mapped.event}\nTác nhân: <@${entry.executorId}>\nHãy kiểm tra quyền và thứ tự role của bot.`,
      );
    }
  }

  isSafeToSnapshot(guildId: string, quietPeriodMs = 2 * 60_000): boolean {
    return Date.now() - (this.lastUntrustedActivity.get(guildId) ?? 0) >= quietPeriodMs;
  }

  private async respond(
    guild: Guild,
    config: GuildConfig,
    event: ProtectionEvent,
    executorId: string,
    targetIds: string[],
  ): Promise<void> {
    const enforcement = await this.responses.enforce(guild, executorId, config);
    const recovery = await this.recover(guild, event, targetIds);
    let lockedChannels = 0;
    if (config.lockdownOnCritical && CRITICAL_EVENTS.has(event)) {
      lockedChannels = await this.responses.enableLockdown(guild, event, true);
    }
    const action = [
      enforcement.success ? enforcement.action : `${enforcement.action} (không hoàn tất)`,
      lockedChannels > 0 ? `lockdown ${lockedChannels} kênh` : undefined,
      this.recoveryText(recovery),
    ]
      .filter(Boolean)
      .join("; ");

    await this.responses.recordAndNotify(guild, config, {
      guildId: guild.id,
      event,
      executorId,
      targetIds,
      action,
      details: enforcement.detail,
    });
  }

  private async recover(
    guild: Guild,
    event: ProtectionEvent,
    targetIds: string[],
  ): Promise<RestoreSummary | undefined> {
    switch (event) {
      case "memberBan":
        await this.reverseBans(guild, targetIds);
        return undefined;
      case "channelDelete":
        return this.snapshots.restoreDeletedChannels(guild, targetIds);
      case "channelCreate":
        await this.deleteRaidChannels(guild, targetIds);
        return undefined;
      case "channelUpdate":
        await Promise.all(targetIds.map((id) => this.snapshots.restoreChannelState(guild, id)));
        return undefined;
      case "roleDelete":
        return this.snapshots.restoreDeletedRoles(guild, targetIds);
      case "roleUpdate":
        await Promise.all(targetIds.map((id) => this.snapshots.restoreRoleState(guild, id)));
        return undefined;
      case "botAdd":
        await this.removeUnknownBots(guild, targetIds);
        return undefined;
      case "webhookCreate":
        await this.removeUnknownWebhooks(guild, targetIds);
        return undefined;
      case "dangerousRoleGrant":
        await this.revokeDangerousRoleGrants(guild, targetIds);
        return undefined;
    }
  }

  private async reverseBans(guild: Guild, userIds: string[]): Promise<void> {
    const snapshot = this.store.getSnapshot(guild.id);
    for (const userId of userIds) {
      try {
        await guild.bans.remove(userId, "Bot Anti-Raid Security: đảo ngược mass-ban");
        const roles = snapshot?.memberRoles[userId] ?? [];
        if (roles.length > 0) await this.store.setPendingMemberRoles(guild.id, userId, roles);
      } catch (error) {
        logger.warn({ guildId: guild.id, userId, error }, "Không thể unban nạn nhân");
      }
    }
  }

  private async deleteRaidChannels(guild: Guild, channelIds: string[]): Promise<void> {
    for (const channelId of channelIds) {
      const channel = guild.channels.cache.get(channelId);
      if (!channel || channel.isThread()) continue;
      try {
        await channel.delete("Bot Anti-Raid Security: dọn channel spam");
      } catch (error) {
        logger.warn({ guildId: guild.id, channelId, error }, "Không thể xóa channel spam");
      }
    }
  }

  private async removeUnknownBots(guild: Guild, botIds: string[]): Promise<void> {
    for (const botId of botIds) {
      try {
        const member = await guild.members.fetch(botId);
        if (member.user.bot && member.kickable) {
          await member.kick("Bot Anti-Raid Security: bot chưa được tin cậy");
        }
      } catch (error) {
        logger.warn({ guildId: guild.id, botId, error }, "Không thể kick bot lạ");
      }
    }
  }

  private async removeUnknownWebhooks(guild: Guild, webhookIds: string[]): Promise<void> {
    try {
      const webhooks = await guild.fetchWebhooks();
      for (const webhookId of webhookIds) {
        const webhook = webhooks.get(webhookId);
        if (webhook) await webhook.delete("Bot Anti-Raid Security: webhook chưa được tin cậy");
      }
    } catch (error) {
      logger.warn({ guildId: guild.id, error }, "Không thể dọn webhook lạ");
    }
  }

  private async revokeDangerousRoleGrants(guild: Guild, memberIds: string[]): Promise<void> {
    const snapshot = this.store.getSnapshot(guild.id);
    for (const memberId of memberIds) {
      try {
        const member = await guild.members.fetch(memberId);
        const previouslyAssigned = new Set(snapshot?.memberRoles[memberId] ?? []);
        const addedDangerous = member.roles.cache.filter(
          (role) =>
            role.id !== guild.id &&
            !previouslyAssigned.has(role.id) &&
            role.editable &&
            role.permissions.any(DANGEROUS_PERMISSIONS),
        );
        if (addedDangerous.size > 0) {
          await member.roles.remove(addedDangerous, "Bot Anti-Raid Security: thu hồi quyền nguy hiểm");
        }
      } catch (error) {
        logger.warn({ guildId: guild.id, memberId, error }, "Không thể thu hồi role nguy hiểm");
      }
    }
  }

  private mapEntry(entry: GuildAuditLogsEntry): MappedEntry | undefined {
    const targetId = entry.targetId;
    if (!targetId) return undefined;

    switch (entry.action) {
      case AuditLogEvent.MemberBanAdd:
        return { event: "memberBan", targetId };
      case AuditLogEvent.ChannelDelete:
        return { event: "channelDelete", targetId };
      case AuditLogEvent.ChannelCreate:
        return { event: "channelCreate", targetId };
      case AuditLogEvent.ChannelUpdate:
      case AuditLogEvent.ChannelOverwriteCreate:
      case AuditLogEvent.ChannelOverwriteUpdate:
      case AuditLogEvent.ChannelOverwriteDelete:
        return { event: "channelUpdate", targetId };
      case AuditLogEvent.RoleDelete:
        return { event: "roleDelete", targetId };
      case AuditLogEvent.RoleUpdate:
        return { event: "roleUpdate", targetId };
      case AuditLogEvent.BotAdd:
        return { event: "botAdd", targetId };
      case AuditLogEvent.WebhookCreate:
        return { event: "webhookCreate", targetId };
      case AuditLogEvent.MemberRoleUpdate:
        return { event: "dangerousRoleGrant", targetId };
      default:
        return undefined;
    }
  }

  private isDangerousRoleGrant(entry: GuildAuditLogsEntry, guild: Guild): boolean {
    for (const change of entry.changes) {
      if (change.key !== "$add" || !Array.isArray(change.new)) continue;
      for (const added of change.new as Array<{ id?: string }>) {
        if (!added.id) continue;
        const role = guild.roles.cache.get(added.id);
        if (role?.permissions.any(DANGEROUS_PERMISSIONS)) return true;
      }
    }
    return false;
  }

  private recoveryText(summary: RestoreSummary | undefined): string | undefined {
    if (!summary) return undefined;
    const restored = summary.restoredChannels + summary.restoredRoles;
    return summary.failed.length > 0
      ? `khôi phục ${restored}, lỗi ${summary.failed.length}`
      : `khôi phục ${restored} cấu phần`;
  }
}
