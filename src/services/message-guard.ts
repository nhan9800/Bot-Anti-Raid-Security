import type { Message } from "discord.js";
import { logger } from "../logger.js";
import { JsonStore } from "../store/json-store.js";
import { assessContent } from "./content-analysis.js";
import { ResponseService } from "./response-service.js";
import { SlidingWindow } from "./sliding-window.js";

interface MessagePointer {
  channelId: string;
  messageId: string;
  userId: string;
}

export class MessageGuard {
  private readonly userWindows = new SlidingWindow<MessagePointer>();
  private readonly contentWindows = new SlidingWindow<MessagePointer>();
  private readonly actionCooldown = new Map<string, number>();

  constructor(
    private readonly store: JsonStore,
    private readonly responses: ResponseService,
  ) {}

  async handle(message: Message): Promise<void> {
    if (!message.inGuild() || message.author.bot || !message.member) return;
    const config = this.store.getConfig(message.guildId);
    if (!config.enabled || !config.messageGuardEnabled) return;

    const trusted =
      message.author.id === message.guild.ownerId ||
      config.trustedUserIds.includes(message.author.id) ||
      message.member.roles.cache.some((role) => config.trustedRoleIds.includes(role.id));
    if (trusted) return;

    const pointer: MessagePointer = {
      channelId: message.channelId,
      messageId: message.id,
      userId: message.author.id,
    };
    const assessment = assessContent(message.content);

    if (assessment.suspiciousLink) {
      await this.removeMessages(message, [pointer]);
      await this.timeoutUsers(message, [message.author.id], "liên kết có dấu hiệu giả mạo/phishing");
      await this.report(message, [pointer], "Đã xóa liên kết đáng ngờ và timeout người gửi");
      return;
    }

    const userResult = this.userWindows.add(
      `${message.guildId}:${message.author.id}`,
      pointer,
      7,
      8_000,
    );
    if (userResult.triggered && this.canAct(`${message.guildId}:user:${message.author.id}`)) {
      const pointers = userResult.occurrences.map((item) => item.value);
      await this.removeMessages(message, pointers);
      await this.timeoutUsers(message, [message.author.id], "spam/flood tốc độ cao");
      await this.report(message, pointers, "Đã dọn flood và timeout người gửi");
      return;
    }

    if (assessment.fingerprint.length < 12) return;
    const contentResult = this.contentWindows.add(
      `${message.guildId}:${assessment.fingerprint}`,
      pointer,
      5,
      12_000,
    );
    const pointers = contentResult.occurrences.map((item) => item.value);
    const uniqueUsers = new Set(pointers.map((item) => item.userId));
    const uniqueChannels = new Set(pointers.map((item) => item.channelId));
    const coordinated =
      contentResult.triggered &&
      uniqueUsers.size >= 3 &&
      (uniqueChannels.size >= 2 || assessment.hasMassMention || assessment.domains.length > 0);
    if (!coordinated || !this.canAct(`${message.guildId}:content:${assessment.fingerprint}`)) return;

    await this.removeMessages(message, pointers);
    await this.timeoutUsers(message, [...uniqueUsers], "raid nội dung phối hợp");
    const locked = config.lockdownOnCritical
      ? await this.responses.enableLockdown(message.guild, "messageRaid", true)
      : 0;
    await this.report(
      message,
      pointers,
      `Đã dọn raid nội dung, timeout ${uniqueUsers.size} tài khoản${locked > 0 ? ` và khóa ${locked} kênh` : ""}`,
    );
  }

  private canAct(key: string): boolean {
    const now = Date.now();
    const previous = this.actionCooldown.get(key) ?? 0;
    if (now - previous < 30_000) return false;
    this.actionCooldown.set(key, now);
    return true;
  }

  private async removeMessages(origin: Message<true>, pointers: MessagePointer[]): Promise<void> {
    const unique = new Map(pointers.map((pointer) => [pointer.messageId, pointer]));
    await Promise.allSettled(
      [...unique.values()].map(async (pointer) => {
        const channel = origin.guild.channels.cache.get(pointer.channelId);
        if (!channel?.isTextBased() || channel.isDMBased()) return;
        try {
          const target = await channel.messages.fetch(pointer.messageId);
          if (target.deletable) await target.delete();
        } catch {
          // Message may already be deleted by another moderation system.
        }
      }),
    );
  }

  private async timeoutUsers(origin: Message<true>, userIds: string[], reason: string): Promise<void> {
    await Promise.allSettled(
      userIds.map(async (userId) => {
        try {
          const member = await origin.guild.members.fetch(userId);
          if (member.moderatable) await member.timeout(10 * 60_000, `Bot Anti-Raid Security: ${reason}`);
        } catch (error) {
          logger.warn({ guildId: origin.guildId, userId, error }, "Không thể timeout spammer");
        }
      }),
    );
  }

  private async report(origin: Message<true>, pointers: MessagePointer[], action: string): Promise<void> {
    const config = this.store.getConfig(origin.guildId);
    await this.responses.recordAndNotify(origin.guild, config, {
      guildId: origin.guildId,
      event: "messageRaid",
      targetIds: [...new Set(pointers.map((pointer) => pointer.userId))],
      action,
      details: "Nội dung đã được xử lý trong RAM và không được lưu vào kho dữ liệu.",
    });
  }
}
