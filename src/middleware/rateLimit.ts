import type { MiddlewareHandler } from 'hono';
import type { AppContextVariables } from '../types/index.js';
import { env } from '../env.js';

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
 * M4: Drop every bucket whose newest hit predates `now - windowMs`. This bounds
 * memory growth: a spoofed-IP storm can otherwise seed one bucket per request
 * and they never get freed otherwise. Returns the count removed (for logging).
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
    // No hits, or every hit is older than the largest supported window (1 min).
    if (newest === 0 || newest <= now - 60_000) {
      buckets.delete(bucketKey);
      removed++;
    }
  }
  return removed;
}

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
    // H1: X-Forwarded-For / X-Real-IP are client-controlled. Only trust them
    // when an explicit TRUST_PROXY=true is set (i.e. the deployment sits behind
    // a known reverse proxy that overwrites these headers). Otherwise key on the
    // raw TCP socket remote address, which cannot be spoofed by the client.
    let ip: string;
    if (env.trustProxy) {
      ip =
        c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
        c.req.header('x-real-ip') ??
        'unknown';
    } else {
      // @hono/node-server exposes the underlying Node request via c.env.incoming.
      const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } })
        .incoming;
      ip = incoming?.socket?.remoteAddress ?? 'unknown';
    }

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
