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
import { getBotConfig } from './config.js';
import { commands } from './commands/index.js';
import { registerHandlers } from './events.js';

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
