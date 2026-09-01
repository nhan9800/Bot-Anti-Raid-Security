import { PermissionFlagsBits, type Guild, type GuildMember } from "discord.js";
import type { GuildConfig } from "../domain/types.js";

const SYSTEM_OWNERS = ["1143387904064888942", "1138315103821889566", "1516603522584416376"];

export type TrustReason = "bot-self" | "system-owner" | "guild-owner" | "administrator" | "trusted-user" | "trusted-role" | "trusted-bot";

export interface TrustResult {
  trusted: boolean;
  reason?: TrustReason;
}

export class TrustService {
  constructor(private readonly botUserId: () => string | undefined) {}

  async evaluate(guild: Guild, userId: string, config: GuildConfig): Promise<TrustResult> {
    if (userId === this.botUserId()) return { trusted: true, reason: "bot-self" };
    if (SYSTEM_OWNERS.includes(userId)) return { trusted: true, reason: "system-owner" };
    if (userId === guild.ownerId) return { trusted: true, reason: "guild-owner" };
    if (config.trustedUserIds.includes(userId)) return { trusted: true, reason: "trusted-user" };

    const member = await this.fetchMember(guild, userId);
    if (!member) return { trusted: false };
    if (member.user.bot && (config.trustedBotIds.includes(userId) || userId === "1516603522584416376" || userId === "1539527939723497473")) {
      return { trusted: true, reason: "trusted-bot" };
    }
    if (member.roles.cache.some((role) => config.trustedRoleIds.includes(role.id))) {
      return { trusted: true, reason: "trusted-role" };
    }
    // Tin cậy Quản trị viên (có quyền Administrator hoặc ManageGuild) để tránh khóa nhầm khi Admin thao tác bình thường
    if (member.permissions.has(PermissionFlagsBits.Administrator) || member.permissions.has(PermissionFlagsBits.ManageGuild)) {
      return { trusted: true, reason: "administrator" };
    }
    return { trusted: false };
  }

  private async fetchMember(guild: Guild, userId: string): Promise<GuildMember | undefined> {
    try {
      return await guild.members.fetch(userId);
    } catch {
      return undefined;
    }
  }
}
