// Shared Hono app construction — used by both entrypoints (src/index.ts for
// Node dev/prod, src/worker.ts for Cloudflare Workers). Neither entrypoint
// should duplicate middleware/route wiring; they only differ in how env/DB
// get initialized and how the app is actually served.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { api } from './api/routes.js';
import { discordInteractions } from './bot/interactions.js';
import { logger } from './utils/logger.js';
import { alertError } from './utils/errorAlerts.js';
import type { AppContextVariables } from './types/index.js';

export function createApp() {
  const app = new Hono<{ Variables: AppContextVariables }>();

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

  app.get('/', (c) =>
    c.json({ name: 'ImperiumMC API', status: 'ok', version: '1.0.0' }),
  );
  app.get('/health', (c) => c.json({ status: 'ok' }));

  app.route('/api', api);
  // Discord's Interactions Endpoint URL — configured in the Discord
  // Developer Portal to point at https://api.imperiummc.net/discord/interactions.
  app.route('/discord/interactions', discordInteractions);

  // Catch any uncaught exception from a route handler so we never leak a stack
  // trace or hang the request; log the real error and return a generic 500.
  app.onError((err, c) => {
    logger.error({ err, method: c.req.method, path: c.req.path }, 'Unhandled error');
    alertError(
      'unhandled',
      `${c.req.method} ${c.req.path} — ${err instanceof Error ? `${err.message} | ${(err.stack ?? '').split('\n')[1] ?? ''}` : String(err)}`,
    );
    return c.json({ error: 'Internal Server Error' }, 500);
  });
  // Consistent JSON 404 for unmatched routes.
  app.notFound((c) => c.json({ error: 'Not Found' }, 404));

  return app;
}
