import "dotenv/config";
import { z } from "zod";

const optionalSnowflake = z
  .string()
  .trim()
  .regex(/^\d{17,20}$/)
  .optional()
  .or(z.literal("").transform(() => undefined));

const schema = z.object({
  BOT_TOKEN: z.string().trim().min(30),
  CLIENT_ID: z.string().trim().regex(/^\d{17,20}$/),
  DEV_GUILD_ID: optionalSnowflake,
  DATA_DIR: z.string().trim().min(1).default("./data"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  HEALTH_PORT: z.coerce.number().int().min(0).max(65_535).default(3_000),
  SNAPSHOT_INTERVAL_MINUTES: z.coerce.number().int().min(5).max(1_440).default(15),
  EMOJI_SHIELD_ID: optionalSnowflake,
  EMOJI_ALERT_ID: optionalSnowflake,
  EMOJI_LOCK_ID: optionalSnowflake,
  EMOJI_RESTORE_ID: optionalSnowflake,
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  throw new Error(`Cấu hình môi trường không hợp lệ:\n${problems.join("\n")}`);
}

export const env = parsed.data;

export const emoji = {
  shield: env.EMOJI_SHIELD_ID ? `<:shield:${env.EMOJI_SHIELD_ID}>` : "[SHIELD]",
  alert: env.EMOJI_ALERT_ID ? `<:alert:${env.EMOJI_ALERT_ID}>` : "[ALERT]",
  lock: env.EMOJI_LOCK_ID ? `<:lock:${env.EMOJI_LOCK_ID}>` : "[LOCK]",
  restore: env.EMOJI_RESTORE_ID ? `<:restore:${env.EMOJI_RESTORE_ID}>` : "[RESTORE]",
} as const;
