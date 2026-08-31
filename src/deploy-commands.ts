import { REST, Routes } from "discord.js";
import { env } from "./config.js";
import { guardCommand } from "./commands/guard-command.js";
import {
  kichhoatCommand,
  licenseCommand,
  xacnhanCommand,
  genkeyCommand,
} from "./commands/license-command.js";
import { logger } from "./logger.js";

const rest = new REST({ version: "10" }).setToken(env.BOT_TOKEN);
const route = env.DEV_GUILD_ID
  ? Routes.applicationGuildCommands(env.CLIENT_ID, env.DEV_GUILD_ID)
  : Routes.applicationCommands(env.CLIENT_ID);

const allCommands = [
  guardCommand.toJSON(),
  kichhoatCommand.toJSON(),
  licenseCommand.toJSON(),
  xacnhanCommand.toJSON(),
  genkeyCommand.toJSON(),
];

await rest.put(route, { body: allCommands });
logger.info(
  { scope: env.DEV_GUILD_ID ? `guild:${env.DEV_GUILD_ID}` : "global", count: allCommands.length },
  "Đã deploy toàn bộ slash commands (Guard + License & Key)"
);
