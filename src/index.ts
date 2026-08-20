import { serve } from '@hono/node-server';
import { env, initEnvFromProcess } from './env.js';
import { createApp } from './app.js';
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

// Fire-and-forget promises that reject (void setCachedJson(...), background
// fans) crash modern Node with an unhelpful top-level trace. Route them through
// the logger so the failing promise has a name and a stack before any exit.
process.on('unhandledRejection', (reason) => {
  logger.error({ reason: String(reason) }, 'Unhandled promise rejection');
});
process.on('uncaughtException', (err) => {
  logger.error({ err }, 'Uncaught exception — exiting nonzero');
  process.exitCode = 1;
});

// The Discord bot no longer runs as a separate gateway process — Discord
// posts interactions directly to /discord/interactions (see
// src/bot/interactions.ts), served by this same app. Run
// `tsx src/bot/registerCommands.ts` once (or after changing a command) to
// register slash commands.
serve(
  { fetch: app.fetch, port: env.port },
  (info) => {
    logger.info({ port: info.port, env: env.nodeEnv }, 'ImperiumMC API listening');
  },
);
