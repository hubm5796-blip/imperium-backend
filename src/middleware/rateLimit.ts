import type { MiddlewareHandler } from 'hono';
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
      `CREATE TABLE IF NOT EXISTS ${D1_TABLE} (
         key TEXT PRIMARY KEY,
         window_start INTEGER NOT NULL,
         hits INTEGER NOT NULL DEFAULT 0
       )`,
    ).run();
    schemaReady = true;
    return true;
  } catch (err) {
    logger.warn({ err: String(err) }, 'rateLimit: D1 schema ensure failed — failing open');
    return false;
  }
}

/**
 * Default IP resolution: `CF-Connecting-IP` is set by Cloudflare's edge and
 * cannot be spoofed by the client — Cloudflare strips any client-supplied
 * value for this header before it reaches the origin. `X-Forwarded-For`/
 * `X-Real-IP`, by contrast, are plain client-controlled headers unless a
 * trusted proxy in front of this server is known to overwrite them; trusting
 * the first hop of an unauthenticated X-Forwarded-For lets an attacker claim
 * a fresh IP on every request and bypass rate limiting entirely. Prefer the
 * Cloudflare header; only fall back to the spoofable ones as a weaker
 * heuristic when it's absent (e.g. local dev, or a non-Cloudflare deploy —
 * in which case rate limiting is only as strong as whatever sits in front of
 * this process actually sanitizing those headers).
 */
function defaultResolveIp(c: { req: { header: (name: string) => string | undefined } }): string {
  return (
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    'unknown'
  );
}

/**
 * Build a sliding-window rate limiter middleware.
 *
 * @param limit      Max requests allowed in the window.
 * @param windowMs   Window duration in milliseconds.
 * @param keyPrefix  Namespaces the counter so different limits don't collide
 *                   (e.g. "auth" vs "global").
 * @param resolveIp  Optional override for how the caller's IP is determined.
 *                    Only pass a custom resolver for routes that themselves
 *                    verify the header it trusts is authentic (e.g. a
 *                    bot/service-auth-gated route trusting a header only its
 *                    known caller sets) — never widen trust on a publicly
 *                    reachable route, that just re-opens the spoofing gap
 *                    the default resolver exists to close.
 */
export function rateLimit(
  limit: number,
  windowMs: number,
  keyPrefix: string,
  resolveIp: (c: Parameters<MiddlewareHandler<RL>>[0]) => string = defaultResolveIp,
): MiddlewareHandler<RL> {
  return async (c, next) => {
    const ip = resolveIp(c);
    const t = Date.now();
    const windowStart = Math.floor(t / windowMs) * windowMs;
    const key = `${keyPrefix}:${ip}:${windowStart}`;

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
        `INSERT INTO ${D1_TABLE} (key, window_start, hits) VALUES (?, ?, 1)
         ON CONFLICT(key) DO UPDATE SET hits = hits + 1
         RETURNING hits`,
      ).bind(key, windowStart).first<{ hits: number }>();
      hits = res?.hits ?? 1;

      // Opportunistic cleanup: drop expired windows ~2% of requests.
      if (Math.random() < 0.02) {
        void d1.prepare(`DELETE FROM ${D1_TABLE} WHERE window_start < ?`).bind(t - windowMs).run().catch(() => undefined);
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

/** Default 60 req/min per IP. */
export const globalRateLimit = rateLimit(60, 60_000, 'global');

/** Stricter 10 req/min for auth endpoints. */
export const authRateLimit = rateLimit(10, 60_000, 'auth');

/**
 * Very strict limit for the in-game login-code verification endpoint: a
 * 6-digit code is only a 1,000,000-value keyspace, so this endpoint needs
 * tighter protection than a normal auth route to keep brute-force guessing
 * infeasible within a code's 15-minute lifetime.
 */
export const webcodeRateLimit = rateLimit(8, 5 * 60_000, 'webcode');

/* ------------------------------------------------- 12a expansion classes */

/**
 * Explicit read-class limiter for the public expansion read endpoints
 * (leaderboards, seasons, economy flow-summary, legion cards, shop catalog).
 * Same numbers as globalRateLimit but namespaced separately so the read class
 * keeps its documented 60/min contract even if the global default changes.
 */
export const readRateLimit = rateLimit(60, 60_000, 'read');

/** Write-class limiter for expansion write endpoints (vote callbacks): 10/min. */
export const writeRateLimit = rateLimit(10, 60_000, 'write');

/** Stricter limiter for shop order placement (spends currency in-game): 5/min. */
export const shopWriteRateLimit = rateLimit(5, 60_000, 'shop');

/**
 * V6 04-03 public profile reads: 30/min per IP. Tighter than the read class
 * because the endpoint is name-keyed and unauthenticated — this is the bound
 * on username-enumeration scraping (404s still consume budget).
 */
export const publicProfileRateLimit = rateLimit(30, 60_000, 'public-profile');
