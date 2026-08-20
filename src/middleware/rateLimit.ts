import type { MiddlewareHandler } from 'hono';
import type { AppContextVariables } from '../types/index.js';

type RL = { Variables: AppContextVariables };

interface SlidingWindow {
  /** Sorted (oldest first) timestamps of requests in the window. */
  hits: number[];
}

/** Global in-memory map of IP -> sliding window per limit-name. */
const buckets = new Map<string, Map<string, SlidingWindow>>();

/** M4: once the map grows past this, sweep idle buckets on the next request. */
const SWEEP_THRESHOLD = 10_000;

/**
 * M4: Drop every bucket whose newest hit predates `now - 60s`. Bounds memory
 * growth: a spoofed-IP storm (or just many distinct clients) can otherwise seed
 * one bucket per request and they never get freed. Returns the count removed.
 */
function sweepIdle(now: number): number {
  let removed = 0;
  for (const [bucketKey, perLimit] of buckets) {
    let newest = 0;
    for (const w of perLimit.values()) {
      if (w.hits.length > 0) {
        const tail = w.hits[w.hits.length - 1] as number;
        if (tail > newest) newest = tail;
      }
    }
    if (newest === 0 || newest <= now - 60_000) {
      buckets.delete(bucketKey);
      removed++;
    }
  }
  return removed;
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
  const now = () => Date.now();

  return async (c, next) => {
    const ip = resolveIp(c);

    // M4: opportunistically evict idle buckets once the map gets large. This
    // runs only past the threshold so it's free in the common case.
    if (buckets.size > SWEEP_THRESHOLD) {
      sweepIdle(Date.now());
    }

    const bucketKey = `${keyPrefix}:${ip}`;
    let bucket = buckets.get(bucketKey);
    if (!bucket) {
      bucket = new Map<string, SlidingWindow>();
      buckets.set(bucketKey, bucket);
    }
    let window = bucket.get(keyPrefix);
    if (!window) {
      window = { hits: [] };
      bucket.set(keyPrefix, window);
    }

    const t = now();
    const cutoff = t - windowMs;

    // Drop timestamps that have aged out of the window.
    while (window.hits.length > 0 && (window.hits[0] as number) <= cutoff) {
      window.hits.shift();
    }

    if (window.hits.length >= limit) {
      const retryAfterSec = Math.ceil((windowMs - (t - (window.hits[0] as number))) / 1000);
      c.header('Retry-After', String(Math.max(retryAfterSec, 1)));
      return c.json(
        { error: 'Too Many Requests', retryAfter: Math.max(retryAfterSec, 1) },
        429,
      );
    }

    window.hits.push(t);
    c.header('X-RateLimit-Limit', String(limit));
    c.header(
      'X-RateLimit-Remaining',
      String(Math.max(limit - window.hits.length, 0)),
    );
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
