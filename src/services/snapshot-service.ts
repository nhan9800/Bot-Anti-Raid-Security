import {
  ChannelType,
  type Guild,
  type GuildBasedChannel,
  type GuildChannelCreateOptions,
  type Role,
} from "discord.js";
import type {
  ChannelSnapshot,
  GuildSnapshot,
  PermissionOverwriteSnapshot,
  RoleSnapshot,
} from "../domain/types.js";
import { logger } from "../logger.js";
import { JsonStore } from "../store/json-store.js";

const RESTORE_REASON = "Bot Anti-Raid Security: khôi phục từ snapshot an toàn";

export interface RestoreSummary {
  restoredChannels: number;
  restoredRoles: number;
  failed: string[];
}

export class SnapshotService {
  private readonly restoredChannelIds = new Map<string, Map<string, string>>();
  private readonly restoredRoleIds = new Map<string, Map<string, string>>();

  constructor(private readonly store: JsonStore) {}

  async capture(guild: Guild): Promise<GuildSnapshot> {
    try {
      await guild.members.fetch();
    } catch (error) {
      logger.warn({ guildId: guild.id, error }, "Không thể nạp toàn bộ member khi tạo snapshot");
    }

    const channels = guild.channels.cache
      .filter((channel) => !channel.isThread())
      .map((channel) => this.snapshotChannel(channel));

    const roles = guild.roles.cache
      .filter((role) => role.id !== guild.id)
      .map((role) => this.snapshotRole(role));

    const memberRoles: Record<string, string[]> = {};
    for (const member of guild.members.cache.values()) {
      const roleIds = member.roles.cache
        .filter((role) => role.id !== guild.id && !role.managed)
        .map((role) => role.id);
      if (roleIds.length > 0) memberRoles[member.id] = roleIds;
    }

    const snapshot: GuildSnapshot = {
      guildId: guild.id,
      createdAt: new Date().toISOString(),
      channels,
      roles,
      memberRoles,
    };
    await this.store.setSnapshot(snapshot);
    logger.info(
      { guildId: guild.id, channels: channels.length, roles: roles.length },
      "Đã tạo snapshot server",
    );
    return snapshot;
  }

  async restoreDeletedChannels(guild: Guild, oldChannelIds: string[]): Promise<RestoreSummary> {
    const snapshot = this.requireSnapshot(guild.id);
    const idMap = this.getIdMap(this.restoredChannelIds, guild.id);
    const wanted = new Set(oldChannelIds);
    for (const channelId of oldChannelIds) {
      const state = snapshot.channels.find((channel) => channel.id === channelId);
      if (state?.parentId && !guild.channels.cache.has(state.parentId) && !idMap.has(state.parentId)) {
        wanted.add(state.parentId);
      }
    }
    const candidates = snapshot.channels
      .filter(
        (channel) => wanted.has(channel.id) && !guild.channels.cache.has(channel.id) && !idMap.has(channel.id),
      )
      .sort((a, b) => Number(a.type !== ChannelType.GuildCategory) - Number(b.type !== ChannelType.GuildCategory));

    const summary: RestoreSummary = { restoredChannels: 0, restoredRoles: 0, failed: [] };
    for (const channel of candidates) {
      try {
        const restored = await guild.channels.create(this.toCreateOptions(channel, guild, idMap));
        idMap.set(channel.id, restored.id);
        await restored.setPosition(channel.position, { reason: RESTORE_REASON });
        summary.restoredChannels += 1;
      } catch (error) {
        summary.failed.push(`channel:${channel.name}`);
        logger.error({ guildId: guild.id, channelId: channel.id, error }, "Khôi phục channel thất bại");
      }
    }
    return summary;
  }

  async restoreDeletedRoles(guild: Guild, oldRoleIds: string[]): Promise<RestoreSummary> {
    const snapshot = this.requireSnapshot(guild.id);
    const roleMap = this.getIdMap(this.restoredRoleIds, guild.id);
    const wanted = new Set(oldRoleIds);
    const candidates = snapshot.roles
      .filter(
        (role) =>
          wanted.has(role.id) && !role.managed && !guild.roles.cache.has(role.id) && !roleMap.has(role.id),
      )
      .sort((a, b) => a.position - b.position);
    const summary: RestoreSummary = { restoredChannels: 0, restoredRoles: 0, failed: [] };

    for (const role of candidates) {
      try {
        const restored = await guild.roles.create({
          name: role.name,
          color: role.color,
          hoist: role.hoist,
          permissions: BigInt(role.permissions),
          mentionable: role.mentionable,
          reason: RESTORE_REASON,
        });
        roleMap.set(role.id, restored.id);
        await restored.setPosition(role.position, { reason: RESTORE_REASON });
        await this.restoreMemberAssignments(guild, role.id, restored.id, snapshot);
        await this.restoreRoleOverwrites(guild, role.id, restored.id, snapshot);
        summary.restoredRoles += 1;
      } catch (error) {
        summary.failed.push(`role:${role.name}`);
        logger.error({ guildId: guild.id, roleId: role.id, error }, "Khôi phục role thất bại");
      }
    }
    return summary;
  }

  async restoreChannelState(guild: Guild, channelId: string): Promise<boolean> {
    const snapshot = this.store.getSnapshot(guild.id);
    const state = snapshot?.channels.find((item) => item.id === channelId);
    const channel = guild.channels.cache.get(channelId);
    if (!state || !channel || channel.isThread()) return false;

    try {
      const editable: Record<string, unknown> = {
        name: state.name,
        parent: state.parentId
          ? (this.getIdMap(this.restoredChannelIds, guild.id).get(state.parentId) ?? state.parentId)
          : null,
        permissionOverwrites: this.permissionOverwrites(state.permissionOverwrites, guild.id),
        reason: RESTORE_REASON,
      };
      if ("topic" in channel) editable.topic = state.topic ?? null;
      if ("nsfw" in channel) editable.nsfw = state.nsfw ?? false;
      if ("rateLimitPerUser" in channel) editable.rateLimitPerUser = state.rateLimitPerUser ?? 0;
      if ("bitrate" in channel && state.bitrate !== undefined) editable.bitrate = state.bitrate;
      if ("userLimit" in channel && state.userLimit !== undefined) editable.userLimit = state.userLimit;
      await channel.edit(editable);
      await channel.setPosition(state.position, { reason: RESTORE_REASON });
      return true;
    } catch (error) {
      logger.error({ guildId: guild.id, channelId, error }, "Rollback channel update thất bại");
      return false;
    }
  }

  async restoreRoleState(guild: Guild, roleId: string): Promise<boolean> {
    const snapshot = this.store.getSnapshot(guild.id);
    const state = snapshot?.roles.find((item) => item.id === roleId);
    const role = guild.roles.cache.get(roleId);
    if (!state || !role || role.managed) return false;

    try {
      await role.edit({
        name: state.name,
        color: state.color,
        hoist: state.hoist,
        permissions: BigInt(state.permissions),
        mentionable: state.mentionable,
        reason: RESTORE_REASON,
      });
      await role.setPosition(state.position, { reason: RESTORE_REASON });
      return true;
    } catch (error) {
      logger.error({ guildId: guild.id, roleId, error }, "Rollback role update thất bại");
      return false;
    }
  }

  async restoreAllMissing(guild: Guild): Promise<RestoreSummary> {
    const snapshot = this.requireSnapshot(guild.id);
    const missingRoles = snapshot.roles.map((role) => role.id).filter((id) => !guild.roles.cache.has(id));
    const missingChannels = snapshot.channels
      .map((channel) => channel.id)
      .filter((id) => !guild.channels.cache.has(id));
    const roles = await this.restoreDeletedRoles(guild, missingRoles);
    const channels = await this.restoreDeletedChannels(guild, missingChannels);
    return {
      restoredChannels: channels.restoredChannels,
      restoredRoles: roles.restoredRoles,
      failed: [...roles.failed, ...channels.failed],
    };
  }

  private snapshotChannel(channel: GuildBasedChannel): ChannelSnapshot {
    const state: ChannelSnapshot = {
      id: channel.id,
      name: channel.name,
      type: channel.type,
      parentId: "parentId" in channel ? channel.parentId : null,
      position: "position" in channel ? (channel.position ?? 0) : 0,
      permissionOverwrites: "permissionOverwrites" in channel
        ? channel.permissionOverwrites.cache.map((overwrite) => ({
            id: overwrite.id,
            type: overwrite.type,
            allow: overwrite.allow.bitfield.toString(),
            deny: overwrite.deny.bitfield.toString(),
          }))
        : [],
    };
    if ("topic" in channel) state.topic = channel.topic;
    if ("nsfw" in channel) state.nsfw = channel.nsfw;
    if ("rateLimitPerUser" in channel) state.rateLimitPerUser = channel.rateLimitPerUser ?? 0;
    if ("bitrate" in channel) state.bitrate = channel.bitrate;
    if ("userLimit" in channel) state.userLimit = channel.userLimit;
    return state;
  }

  private snapshotRole(role: Role): RoleSnapshot {
    return {
      id: role.id,
      name: role.name,
      color: role.color,
      hoist: role.hoist,
      position: role.position,
      permissions: role.permissions.bitfield.toString(),
      mentionable: role.mentionable,
      managed: role.managed,
    };
  }

  private toCreateOptions(
    state: ChannelSnapshot,
    guild: Guild,
    idMap: Map<string, string>,
  ): GuildChannelCreateOptions {
    const parent = state.parentId
      ? (idMap.get(state.parentId) ?? (guild.channels.cache.has(state.parentId) ? state.parentId : undefined))
      : undefined;
    const options: GuildChannelCreateOptions = {
      name: state.name,
      type: state.type as Exclude<GuildChannelCreateOptions["type"], undefined>,
      permissionOverwrites: this.permissionOverwrites(state.permissionOverwrites, guild.id),
      reason: RESTORE_REASON,
    };
    if (parent) options.parent = parent;
    if (state.topic !== undefined && state.topic !== null) options.topic = state.topic;
    if (state.nsfw !== undefined) options.nsfw = state.nsfw;
    if (state.rateLimitPerUser !== undefined) options.rateLimitPerUser = state.rateLimitPerUser;
    if (state.bitrate !== undefined) options.bitrate = state.bitrate;
    if (state.userLimit !== undefined) options.userLimit = state.userLimit;
    return options;
  }

  private permissionOverwrites(overwrites: PermissionOverwriteSnapshot[], guildId?: string) {
    const roleMap = guildId ? this.getIdMap(this.restoredRoleIds, guildId) : undefined;
    return overwrites.map((overwrite) => ({
      id: roleMap?.get(overwrite.id) ?? overwrite.id,
      type: overwrite.type,
      allow: BigInt(overwrite.allow),
      deny: BigInt(overwrite.deny),
    }));
  }

  private async restoreMemberAssignments(
    guild: Guild,
    oldRoleId: string,
    newRoleId: string,
    snapshot: GuildSnapshot,
  ): Promise<void> {
    const memberIds = Object.entries(snapshot.memberRoles)
      .filter(([, roleIds]) => roleIds.includes(oldRoleId))
      .map(([memberId]) => memberId);
    for (const memberId of memberIds) {
      try {
        const member = await guild.members.fetch(memberId);
        await member.roles.add(newRoleId, RESTORE_REASON);
      } catch (error) {
        logger.warn({ guildId: guild.id, memberId, newRoleId, error }, "Không thể trả lại role cho member");
      }
    }
  }

  private async restoreRoleOverwrites(
    guild: Guild,
    oldRoleId: string,
    newRoleId: string,
    snapshot: GuildSnapshot,
  ): Promise<void> {
    for (const channelState of snapshot.channels) {
      const saved = channelState.permissionOverwrites.find((overwrite) => overwrite.id === oldRoleId);
      const channel = guild.channels.cache.get(channelState.id);
      if (!saved || !channel || channel.isThread()) continue;
      try {
        const current = channel.permissionOverwrites.cache.map((overwrite) => ({
          id: overwrite.id,
          type: overwrite.type,
          allow: overwrite.allow.bitfield,
          deny: overwrite.deny.bitfield,
        }));
        current.push({
          id: newRoleId,
          type: saved.type,
          allow: BigInt(saved.allow),
          deny: BigInt(saved.deny),
        });
        await channel.permissionOverwrites.set(current, RESTORE_REASON);
      } catch (error) {
        logger.warn(
          { guildId: guild.id, channelId: channel.id, oldRoleId, newRoleId, error },
          "Không thể phục hồi overwrite của role",
        );
      }
    }
  }

  private getIdMap(
    collection: Map<string, Map<string, string>>,
    guildId: string,
  ): Map<string, string> {
    const existing = collection.get(guildId);
    if (existing) return existing;
    const created = new Map<string, string>();
    collection.set(guildId, created);
    return created;
  }

  private requireSnapshot(guildId: string): GuildSnapshot {
    const snapshot = this.store.getSnapshot(guildId);
    if (!snapshot) throw new Error("Server chưa có snapshot. Hãy chạy /guard snapshot-create trước.");
    return snapshot;
  }
}
