// Shared Hono app construction — used by both entrypoints (src/index.ts for
// Node dev/prod, src/worker.ts for Cloudflare Workers). Neither entrypoint
// should duplicate middleware/route wiring; they only differ in how env/DB
// get initialized and how the app is actually served.
// Build-time deploy stamp (FIX: /health previously returned now() as deploy time).
const DEPLOY_VERSION = process.env.DEPLOY_VERSION ?? 'dev';
const DEPLOYED_AT = process.env.DEPLOYED_AT ?? new Date().toISOString();

import { Hono } from 'hono';
import { query } from './db/pool.js';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { api } from './api/routes.js';
import { v2Api } from './api/v2/index.js';
import { discordInteractions } from './bot/interactions.js';
import { botAdmin } from './bot/adminRegisterRoute.js';
import { bridgeApi } from './bot/bridge.js';
import { logger } from './utils/logger.js';
import { rateLimitV2 } from './middleware/rateLimitV2.js';
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
      allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization'],
      maxAge: 600,
    }),
  );

  app.use('*', secureHeaders());

  // RATE LIMITING V2 (V6 05-05): cost classes + principal dimension. Composes WITH
  // the existing per-route v1 limiters (they stay first-line caps); this layer adds
  // weighted budgets and per-account fairness. Fail-open on limiter errors is the v1
  // convention — availability over limiting.
  app.use('*', rateLimitV2());

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
  // /health (FIX 2026-08-22 review): was decorative — hardcoded version, deployedAt = now(),
  // and always-ok regardless of DB reachability. Now PROBES the database (1s budget) and
  // reports the actual deploy stamp baked at build time. Monitors should treat 503 as down.
  app.get('/health', async (c) => {
    let db: 'ok' | 'down' = 'down';
    try {
      // The raced query's late rejection (post-timeout) must be marked handled — same
      // unhandled-rejection 1101 class withTimeout now guards.
      const probe = query('SELECT 1 AS ok', []);
      probe.catch(() => {});
      await Promise.race([
        probe,
        new Promise((_, rej) => setTimeout(() => rej(new Error('db probe timeout')), 1000)),
      ]);
      db = 'ok';
    } catch {
      // fall through — db stays down
    }
    return c.json(
      {
        status: db === 'ok' ? 'ok' : 'degraded',
        db,
        version: DEPLOY_VERSION,
        deployedAt: DEPLOYED_AT,
      },
      db === 'ok' ? 200 : 503,
    );
  });

  app.route('/api', api);
  // V6 05-01: the versioned contract surface (envelope + cursors + openapi.json).
  app.route('/api/v2', v2Api);
  // V6 02-09 companion: webpanel-HMAC-gated admin surface (the Worker registers
  // its own slash commands with the live Discord secrets only it holds).
  app.route('/api/admin', botAdmin);
  // V6 02-08: the game→Discord bridge (Bearer BRIDGE_SECRET; chat + typed events).
  app.route('/bridge', bridgeApi);
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
