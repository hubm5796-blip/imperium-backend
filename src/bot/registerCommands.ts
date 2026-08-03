/**
 * One-time (or on-change) slash-command registration script. Run manually
 * whenever a command is added/changed — this is NOT part of the request
 * path (unlike the old gateway bot, which re-registered on every
 * ClientReady). `@discordjs/rest` is a pure HTTP client with no gateway
 * dependency, so this also runs fine as a plain Node script.
 *
 * Usage: tsx src/bot/registerCommands.ts [--guild]
 *   --guild registers to DISCORD_DEV_GUILD_ID only (near-instant propagation,
 *   for iterating during development). Without it, registers globally
 *   (can take up to an hour to propagate — use for real deploys).
 */
import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import { initEnvFromProcess, env } from '../env.js';
import { commands } from './commands/index.js';
import { getBotConfig } from './config.js';

async function main(): Promise<void> {
  await initEnvFromProcess();

  const { clientId, devGuildId } = getBotConfig();
  if (!clientId) throw new Error('DISCORD_CLIENT_ID is not set');
  if (!env.discord.botToken) throw new Error('DISCORD_BOT_TOKEN is not set');

  const useGuild = process.argv.includes('--guild');
  if (useGuild && !devGuildId) {
    throw new Error('--guild passed but DISCORD_DEV_GUILD_ID is not set');
  }

  const rest = new REST({ version: '10' }).setToken(env.discord.botToken);
  const body = commands.map((c) => c.toJSON());

  if (useGuild && devGuildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, devGuildId), { body });
    console.log(`Registered ${body.length} commands to guild ${devGuildId}.`);
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body });
    console.log(`Registered ${body.length} commands globally (may take up to an hour to propagate).`);
  }
}

main().catch((err) => {
  console.error('Failed to register slash commands:', err);
  process.exitCode = 1;
});
