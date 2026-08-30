import type { Guild, GuildMember } from "discord.js";
import type { GuildConfig } from "../domain/types.js";

export type TrustReason = "bot-self" | "guild-owner" | "trusted-user" | "trusted-role" | "trusted-bot";

export interface TrustResult {
  trusted: boolean;
  reason?: TrustReason;
}

export class TrustService {
  constructor(private readonly botUserId: () => string | undefined) {}

  async evaluate(guild: Guild, userId: string, config: GuildConfig): Promise<TrustResult> {
    if (userId === this.botUserId()) return { trusted: true, reason: "bot-self" };
    if (userId === guild.ownerId) return { trusted: true, reason: "guild-owner" };
    if (config.trustedUserIds.includes(userId)) return { trusted: true, reason: "trusted-user" };

    const member = await this.fetchMember(guild, userId);
    if (!member) return { trusted: false };
    if (member.user.bot && config.trustedBotIds.includes(userId)) {
      return { trusted: true, reason: "trusted-bot" };
    }
    if (member.roles.cache.some((role) => config.trustedRoleIds.includes(role.id))) {
      return { trusted: true, reason: "trusted-role" };
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
