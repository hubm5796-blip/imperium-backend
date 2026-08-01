import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { env } from './env.js';
import { api } from './api/routes.js';
import { startBot } from './bot/index.js';
import { pool } from './db/pool.js';
import { redisPublisher, redisSubscriber } from './db/redis.js';
import { logger } from './utils/logger.js';
import type { AppContextVariables } from './types/index.js';

const app = new Hono<{ Variables: AppContextVariables }>();

/* ----------------------------------------------------------- Middleware */

app.use(
  '*',
  cors({
    origin: (origin) => {
      const allowed = new Set<string>([
        'https://imperiummc.net',
        'https://www.imperiummc.net',
        'http://localhost:5173',
        'http://localhost:3000',
        'http://127.0.0.1:5173',
        'http://127.0.0.1:3000',
      ]);
      if (!origin) return null; // non-browser / curl requests
      return allowed.has(origin) ? origin : null;
    },
    credentials: true,
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
  }),
);

app.use('*', secureHeaders());

// Simple request logger.
app.use('*', async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  logger.info(
    { method: c.req.method, path: c.req.path, status: c.res.status, ms },
    'request',
  );
});

/* --------------------------------------------------------------- Routes */

app.get('/', (c) =>
  c.json({ name: 'ImperiumMC API', status: 'ok', version: '1.0.0' }),
);
app.get('/health', (c) => c.json({ status: 'ok' }));

app.route('/api', api);

/* ---------------------------------------------------- Error handling */

// Catch any uncaught exception from a route handler so we never leak a stack
// trace or hang the request; log the real error and return a generic 500.
app.onError((err, c) => {
  logger.error({ err }, 'Unhandled error');
  return c.json({ error: 'Internal Server Error' }, 500);
});
// Consistent JSON 404 for unmatched routes.
app.notFound((c) => c.json({ error: 'Not Found' }, 404));

/* ------------------------------------------------------------ Lifecycle */

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutting down...');
  try {
    await Promise.all([
      pool.end(),
      redisPublisher.quit(),
      redisSubscriber.quit(),
    ]);
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
