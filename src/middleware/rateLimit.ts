import type { MiddlewareHandler } from 'hono';
import type { AppContextVariables } from '../types/index.js';

type RL = { Variables: AppContextVariables };

interface SlidingWindow {
  /** Sorted (oldest first) timestamps of requests in the window. */
  hits: number[];
}

/** Global in-memory map of IP -> sliding window per limit-name. */
const buckets = new Map<string, Map<string, SlidingWindow>>();

/**
 * Build a sliding-window rate limiter middleware.
 *
 * @param limit      Max requests allowed in the window.
 * @param windowMs   Window duration in milliseconds.
 * @param keyPrefix  Namespaces the counter so different limits don't collide
 *                   (e.g. "auth" vs "global").
 */
export function rateLimit(
  limit: number,
  windowMs: number,
  keyPrefix: string,
): MiddlewareHandler<RL> {
  const now = () => Date.now();

  return async (c, next) => {
    const ip =
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
      c.req.header('x-real-ip') ??
      'unknown';

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
