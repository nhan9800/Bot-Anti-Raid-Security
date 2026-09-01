import type { Client } from "discord.js";
import { logger } from "../logger.js";
import type { JsonStore } from "../store/json-store.js";
import type { ResponseService } from "./response-service.js";
import type { SnapshotService } from "./snapshot-service.js";

export async function unlockGuildProtection(
  guildId: string,
  store: JsonStore,
  responses: ResponseService,
  snapshots: SnapshotService,
  client: Client
): Promise<{
  enabled: boolean;
  snapshotTaken: boolean;
  channelsUnlocked: number;
}> {
  const config = store.getConfig(guildId);
  config.enabled = true;
  config.messageGuardEnabled = true;
  config.lockdownActive = false;

  const guild = client.guilds.cache.get(guildId);
  if (guild?.ownerId && !config.trustedUserIds.includes(guild.ownerId)) {
    config.trustedUserIds.push(guild.ownerId);
  }
  await store.setConfig(config);

  let channelsUnlocked = 0;
  if (guild && responses.isLockedDown(guildId)) {
    try {
      channelsUnlocked = await responses.disableLockdown(guild);
    } catch (e) {
      logger.warn({ guildId, error: e }, "Không thể tự động gỡ lockdown");
    }
  }

  let snapshotTaken = false;
  if (guild) {
    try {
      await snapshots.capture(guild);
      snapshotTaken = true;
    } catch (e) {
      logger.warn({ guildId, error: e }, "Không thể chụp snapshot tự động sau khi mở khóa");
    }
  }

  logger.info(
    { guildId, enabled: config.enabled, snapshotTaken, channelsUnlocked },
    "🎉 ĐÃ MỞ KHÓA TOÀN BỘ HỆ THỐNG BẢO VỆ CHO MÁY CHỦ!"
  );

  return { enabled: true, snapshotTaken, channelsUnlocked };
}
