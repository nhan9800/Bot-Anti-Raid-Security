import pino from "pino";
import { env } from "./config.js";

export const logger = pino({
  level: env.LOG_LEVEL,
  base: null,
  redact: {
    paths: ["token", "BOT_TOKEN", "authorization", "req.headers.authorization"],
    censor: "[REDACTED]",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});
