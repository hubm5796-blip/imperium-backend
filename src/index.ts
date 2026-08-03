import { serve } from '@hono/node-server';
import { env, initEnvFromProcess } from './env.js';
import { createApp } from './app.js';
import { startBot } from './bot/index.js';
import { initPool, closePool } from './db/pool.js';
import { logger } from './utils/logger.js';

// env must be populated before anything below reads it (route handlers only
// read env at call time, so this just needs to finish before the first
// request — well before serve() below actually starts listening).
await initEnvFromProcess();
initPool(env.databaseUrl);

const app = createApp();

/* ------------------------------------------------------------ Lifecycle */

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutting down...');
  try {
    // Redis is now a per-call connection (db/redisSocket.ts) — nothing
    // persistent to close there. Only the Postgres pool needs draining.
    await closePool();
  } catch (err) {
    logger.error({ err }, 'Error during shutdown');
  }
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

serve(
  { fetch: app.fetch, port: env.port },
  (info) => {
    logger.info({ port: info.port, env: env.nodeEnv }, 'ImperiumMC API listening');
    // Start the bot in the background if a token is configured.
    if (env.discord.botToken) {
      void startBot().catch((err) => {
        logger.error({ err }, 'Bot startup failed');
      });
    }
  },
);
