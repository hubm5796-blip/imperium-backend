/**
 * Discord bot entrypoint.
 *
 * Boots a gateway Client, registers slash commands, and wires all event
 * handlers. The web panel starts this module (see src/index.ts) when
 * DISCORD_BOT_TOKEN is configured so the API and bot share a process.
 */
import {
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
} from 'discord.js';
import { env } from '../env.js';
import { logger } from '../utils/logger.js';
import { BRANDING, EMOJI, getBotConfig } from './config.js';
import { commands } from './commands/index.js';
import { registerHandlers } from './events.js';
import { getServerStatus } from './apiClient.js';

/** Register slash commands with Discord (global or dev-guild). */
async function registerSlashCommands(client: Client): Promise<void> {
  const { clientId, devGuildId } = getBotConfig();
  if (!clientId || !env.discord.botToken) return;

  const rest = new REST({ version: '10' }).setToken(env.discord.botToken);
  const body = commands.map((c) => c.toJSON());

  try {
    if (devGuildId) {
      await rest.put(
        Routes.applicationGuildCommands(clientId, devGuildId),
        { body },
      );
      logger.info({ guild: devGuildId, count: body.length }, 'Registered guild commands');
    } else {
      await rest.put(Routes.applicationCommands(clientId), { body });
      logger.info({ count: body.length }, 'Registered global commands');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to register slash commands');
  }
}

/**
 * Start the Discord bot if a token is configured. Resolves once the client
 * is ready; the gateway keeps running in the background. Returns the client
 * (or null if no token is set / login failed).
 */
export async function startBot(): Promise<Client | null> {
  const { token } = getBotConfig();
  if (!token) {
    logger.info('DISCORD_BOT_TOKEN not set — bot disabled');
    return null;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.GuildMember],
  });

  // Register slash commands once ready, then log.
  client.once(Events.ClientReady, async (ready) => {
    await registerSlashCommands(ready);
    logger.info({ tag: ready.user.tag }, 'Discord bot connected');
  });

  client.on(Events.Error, (err) => {
    logger.error({ err }, 'Discord client error');
  });

  // Wire interaction/member event handlers.
  registerHandlers(client);

  try {
    await client.login(token);
    return client;
  } catch (err) {
    logger.error({ err }, 'Failed to start Discord bot');
    return null;
  }
}

/**
 * Update the bot's "Watching …" presence from the live server status. Best-effort:
 * failures are logged but never thrown.
 */
async function refreshPresence(client: Client): Promise<void> {
  let count: number | undefined;
  try {
    const status = await getServerStatus();
    if (status.ok && status.data.online) count = status.data.playerCount;
  } catch (err) {
    logger.debug({ err }, 'Could not fetch server status for presence');
  }
  const name = count ? `${count} citizens on ${BRANDING.serverIp}` : BRANDING.serverIp;
  client.user?.setPresence({
    status: 'online',
    activities: [{ name, type: 3 /* Watching */ }],
  });
}

/**
 * Standalone entry point (npm run dev:bot / start:bot). Logs in, registers
 * commands, sets a live presence, and shuts down gracefully on SIGTERM/SIGINT.
 * Only runs when this file is the process entry point.
 */
async function main(): Promise<void> {
  const client = await startBot();
  if (!client) {
    process.exitCode = 1;
    return;
  }

  await refreshPresence(client);
  const presenceTimer = setInterval(() => void refreshPresence(client), 60_000);

  logger.info({ tag: client.user?.tag }, `${EMOJI.eagle} ${BRANDING.serverName} bot online`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(presenceTimer);
    logger.info({ signal }, `${EMOJI.eagle} Shutting down ${BRANDING.serverName} bot...`);
    try {
      client.user?.setPresence({ status: 'invisible' });
      await client.destroy();
    } catch (err) {
      logger.error({ err }, 'Error during bot shutdown');
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

// Run only when executed directly (not when imported by src/index.ts).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    logger.error({ err }, 'Fatal error starting bot');
    process.exit(1);
  });
}
