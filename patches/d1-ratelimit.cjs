const fs = require('fs');
const p = 'src/middleware/rateLimit.ts';
let s = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const HEADER = `import type { MiddlewareHandler } from 'hono';
import type { AppContextVariables } from '../types/index.js';
import { getD1 } from '../db/pool.js';
import { logger } from '../utils/logger.js';

type RL = { Variables: AppContextVariables };

/**
 * WORKERS-CORRECT RATE LIMITING (2026-08-22 review): the previous limiter kept
 * a per-isolate in-memory Map — on Cloudflare Workers each isolate is ephemeral
 * and per-PoP, so the effective limit was limit x isolates (effectively no
 * limit). This implementation uses the D1 binding (already bound as CACHE_DB)
 * as the shared counter store: one row per (keyPrefix, ip, windowStart), an
 * atomic UPDATE increments, a background DELETE keeps the table small.
 *
 * Failure mode: D1 unavailable -> ALLOW (fail-open, same as before — an
 * outage must not take the whole API down; the limits are abuse guards).
 */

const D1_TABLE = 'rate_limit_windows';

let schemaReady = false;
async function ensureSchema(): Promise<boolean> {
  if (schemaReady) return true;
  try {
    const d1 = getD1();
    await d1.prepare(
      \`CREATE TABLE IF NOT EXISTS \${D1_TABLE} (
         key TEXT PRIMARY KEY,
         window_start INTEGER NOT NULL,
         hits INTEGER NOT NULL DEFAULT 0
       )\`,
    ).run();
    schemaReady = true;
    return true;
  } catch (err) {
    logger.warn({ err: String(err) }, 'rateLimit: D1 schema ensure failed — failing open');
    return false;
  }
}
`;

// Replace everything up to the defaultResolveIp block (keep the IP resolver + below)
const marker = '/**\n * Default IP resolution:';
const idx = s.indexOf(marker);
if (idx === -1) { console.error('ip resolver marker missing'); process.exit(1); }
s = HEADER + '\n' + s.slice(idx);

// Replace the rateLimit() body with the D1 fixed-window implementation
const fnStart = s.indexOf('export function rateLimit(');
const fnEnd = s.indexOf('/** Default 60 req/min per IP. */');
if (fnStart === -1 || fnEnd === -1) { console.error('rateLimit fn bounds missing'); process.exit(1); }
const NEW_FN = `export function rateLimit(
  limit: number,
  windowMs: number,
  keyPrefix: string,
  resolveIp: (c: Parameters<MiddlewareHandler<RL>>[0]) => string = defaultResolveIp,
): MiddlewareHandler<RL> {
  return async (c, next) => {
    const ip = resolveIp(c);
    const t = Date.now();
    const windowStart = Math.floor(t / windowMs) * windowMs;
    const key = \`\${keyPrefix}:\${ip}:\${windowStart}\`;

    if (!(await ensureSchema())) {
      await next(); // fail-open
      return;
    }

    let hits: number;
    try {
      const d1 = getD1();
      // Atomic upsert-increment: first hit INSERTs 1, subsequent hits UPDATE +1.
      // ON CONFLICT makes it a single statement so concurrent isolates serialize
      // through D1's single-writer semantics — the whole point of moving off
      // the in-memory map.
      const res = await d1.prepare(
        \`INSERT INTO \${D1_TABLE} (key, window_start, hits) VALUES (?, ?, 1)
         ON CONFLICT(key) DO UPDATE SET hits = hits + 1
         RETURNING hits\`,
      ).bind(key, windowStart).first<{ hits: number }>();
      hits = res?.hits ?? 1;

      // Opportunistic cleanup: drop expired windows ~2% of requests.
      if (Math.random() < 0.02) {
        void d1.prepare(\`DELETE FROM \${D1_TABLE} WHERE window_start < ?\`).bind(t - windowMs).run().catch(() => undefined);
      }
    } catch (err) {
      logger.warn({ err: String(err) }, 'rateLimit: D1 op failed — failing open');
      await next();
      return;
    }

    if (hits > limit) {
      const retryAfterSec = Math.max(1, Math.ceil((windowStart + windowMs - t) / 1000));
      c.header('Retry-After', String(retryAfterSec));
      return c.json(
        { error: 'Too Many Requests', retryAfter: retryAfterSec },
        429,
      );
    }

    c.header('X-RateLimit-Limit', String(limit));
    c.header('X-RateLimit-Remaining', String(Math.max(limit - hits, 0)));
    await next();
  };
}

`;
s = s.slice(0, fnStart) + NEW_FN + s.slice(fnEnd);

fs.writeFileSync(p, s);
console.log('D1 rate limiter applied');
