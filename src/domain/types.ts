export const PROTECTION_EVENTS = [
  "memberBan",
  "channelDelete",
  "channelCreate",
  "channelUpdate",
  "roleDelete",
  "roleUpdate",
  "botAdd",
  "webhookCreate",
  "dangerousRoleGrant",
] as const;

export type ProtectionEvent = (typeof PROTECTION_EVENTS)[number];
export type EnforcementAction = "ban" | "kick" | "quarantine";

export interface Threshold {
  limit: number;
  windowMs: number;
}

export interface GuildConfig {
  guildId: string;
  enabled: boolean;
  messageGuardEnabled: boolean;
  logChannelId?: string;
  trustedUserIds: string[];
  trustedRoleIds: string[];
  trustedBotIds: string[];
  enforcementAction: EnforcementAction;
  lockdownOnCritical: boolean;
  lockdownActive: boolean;
  thresholds: Record<ProtectionEvent, Threshold>;
  createdAt: string;
  updatedAt: string;
}

export interface PermissionOverwriteSnapshot {
  id: string;
  type: 0 | 1;
  allow: string;
  deny: string;
}

export interface ChannelSnapshot {
  id: string;
  name: string;
  type: number;
  parentId: string | null;
  position: number;
  topic?: string | null;
  nsfw?: boolean;
  rateLimitPerUser?: number;
  bitrate?: number;
  userLimit?: number;
  permissionOverwrites: PermissionOverwriteSnapshot[];
}

export interface RoleSnapshot {
  id: string;
  name: string;
  color: number;
  hoist: boolean;
  position: number;
  permissions: string;
  mentionable: boolean;
  managed: boolean;
}

export interface GuildSnapshot {
  guildId: string;
  createdAt: string;
  channels: ChannelSnapshot[];
  roles: RoleSnapshot[];
  memberRoles: Record<string, string[]>;
}

export interface IncidentRecord {
  id: string;
  guildId: string;
  event: ProtectionEvent | "messageRaid" | "manualLockdown";
  executorId?: string;
  targetIds: string[];
  action: string;
  createdAt: string;
  details?: string;
}

export interface PersistedData {
  version: 1;
  configs: Record<string, GuildConfig>;
  snapshots: Record<string, GuildSnapshot>;
  incidents: IncidentRecord[];
  pendingMemberRoles: Record<string, Record<string, string[]>>;
}

export const DEFAULT_THRESHOLDS: Record<ProtectionEvent, Threshold> = {
  memberBan: { limit: 4, windowMs: 10_000 },
  channelDelete: { limit: 3, windowMs: 10_000 },
  channelCreate: { limit: 5, windowMs: 10_000 },
  channelUpdate: { limit: 8, windowMs: 15_000 },
  roleDelete: { limit: 3, windowMs: 10_000 },
  roleUpdate: { limit: 5, windowMs: 10_000 },
  botAdd: { limit: 3, windowMs: 20_000 },
  webhookCreate: { limit: 3, windowMs: 10_000 },
  dangerousRoleGrant: { limit: 3, windowMs: 10_000 },
};

export function createDefaultGuildConfig(guildId: string): GuildConfig {
  const now = new Date().toISOString();
  return {
    guildId,
    enabled: false,
    messageGuardEnabled: true,
    trustedUserIds: [],
    trustedRoleIds: [],
    trustedBotIds: [],
    enforcementAction: "quarantine",
    lockdownOnCritical: false,
    lockdownActive: false,
    thresholds: structuredClone(DEFAULT_THRESHOLDS),
    createdAt: now,
    updatedAt: now,
  };
}
