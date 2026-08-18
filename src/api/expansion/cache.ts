// 12a expansion: stale-while-revalidate caching for public read endpoints
// (leaderboards, seasons, economy flow-summary, legion cards, shop catalog).
//
// Two layers, both fail-open:
//  1. Workers Cache API (`caches.default`) when available — the runtime's own
//     edge cache, honored per the plan doc. Absent under plain Node (dev/test),
//     so every access is guarded and skipped silently.
//  2. The existing Redis response cache (getCachedJson/setCachedJson — the same
//     mechanism /api/player/profile uses). This is the layer that actually
//     implements stale-while-revalidate semantics: entries carry `fetchedAt`,
//     fresh entries (<= 60s) are served directly, stale entries (<= 5min) are
//     served immediately while a background refresh runs, and a fetch failure
//     falls back to the newest cached value no matter its age.
import type { Context } from 'hono';
import { getCachedJson, setCachedJson } from '../../db/redis.js';
import { logger } from '../../utils/logger.js';

/** Serve responses younger than this without revalidating. */
export const SWR_FRESH_MS = 60_000;
/** Serve responses older-than-fresh but younger than this immediately, while revalidating in the background. */
export const SWR_STALE_MS = 5 * 60_000;
/** Redis TTL for cached entries — covers fresh + stale windows plus headroom for serve-stale-on-error. */
const SWR_REDIS_TTL_SECONDS = 15 * 60;

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

/** Run `p` to completion after the response is sent (waitUntil on Workers, fire-and-forget on Node). */
function afterResponse(c: Context, p: Promise<unknown>): void {
  try {
    c.executionCtx.waitUntil(p);
  } catch {
    // Not running under an ExecutionContext (Node dev/test) — fire and forget.
    void p;
  }
}

/** Minimal structural type for the Workers Cache API (`caches.default`). */
interface EdgeCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

/** The Workers Cache API, or null when unavailable (plain Node has no `caches`). */
function edgeCache(): EdgeCache | null {
  try {
    const globalCaches = (globalThis as unknown as { caches?: { default?: EdgeCache } }).caches;
    if (globalCaches && typeof globalCaches.default !== 'undefined') {
      return globalCaches.default;
    }
  } catch {
    // Some runtimes throw on access — treat as unavailable.
  }
  return null;
}

async function edgeMatch(c: Context): Promise<Response | null> {
  const cache = edgeCache();
  if (!cache) return null;
  try {
    const hit = await cache.match(c.req.raw);
    return hit ?? null;
  } catch {
    return null;
  }
}

function edgePut(c: Context, res: Response): void {
  const cache = edgeCache();
  if (!cache) return;
  // Never block or fail the response on an edge-cache write.
  afterResponse(
    c,
    cache.put(c.req.raw, res.clone()).catch(() => {
      /* cache full / uncacheable — ignore */
    }),
  );
}

/**
 * Build a JSON response for a public, cacheable GET endpoint with
 * stale-while-revalidate semantics. `fetcher` must return a JSON-serializable
 * value; it may throw, in which case the newest cached value (any age) is
 * served, and if none exists the error propagates to the caller (route) which
 * decides the failure status.
 *
 * A fetcher resolving to `undefined` means "not found": the response is a 404
 * and nothing is cached (so the moment the entity appears, it is served fresh).
 *
 * The response carries `Cache-Control: public, max-age=60, stale-while-revalidate=300`
 * so any upstream CDN/browser honors the same policy, plus an `X-Cache`
 * diagnostic header (EDGE | HIT | STALE | STALE-ERROR).
 */
export async function swrJson<T>(
  c: Context,
  cacheKey: string,
  fetcher: () => Promise<T | undefined>,
): Promise<Response> {
  // Layer 1: edge cache. A hit is at most 60s old by its own Cache-Control
  // policy, so serve it without touching Redis or Postgres at all.
  const edgeHit = await edgeMatch(c);
  if (edgeHit) {
    const res = edgeHit.clone();
    res.headers.set('X-Cache', 'EDGE');
    return res;
  }

  // Layer 2: Redis SWR.
  const entry = await getCachedJson<CacheEntry<T>>(cacheKey);
  const now = Date.now();
  const age = entry ? now - entry.fetchedAt : Number.POSITIVE_INFINITY;

  const buildResponse = (data: T, cacheState: string): Response => {
    const res = c.json(data as unknown as Record<string, unknown>);
    res.headers.set('Cache-Control', `public, max-age=${Math.floor(SWR_FRESH_MS / 1000)}, stale-while-revalidate=${Math.floor(SWR_STALE_MS / 1000)}`);
    res.headers.set('X-Cache', cacheState);
    return res;
  };

  const revalidate = async (): Promise<void> => {
    try {
      const fresh = await fetcher();
      await setCachedJson(cacheKey, { data: fresh, fetchedAt: Date.now() }, SWR_REDIS_TTL_SECONDS);
    } catch (err) {
      logger.warn({ err, cacheKey }, 'SWR background revalidation failed — stale value retained');
    }
  };

  // Fresh: serve without revalidation.
  if (entry && age <= SWR_FRESH_MS) {
    return buildResponse(entry.data, 'HIT');
  }

  // Stale but serveable: serve immediately, refresh in the background.
  if (entry && age <= SWR_STALE_MS) {
    afterResponse(c, revalidate());
    return buildResponse(entry.data, 'STALE');
  }

  // Miss (or long-stale): fetch synchronously; on failure fall back to the
  // newest cached value no matter its age (serve-stale-on-error).
  try {
    const fresh = await fetcher();
    if (fresh === undefined) {
      return c.json({ error: 'Not Found' }, 404);
    }
    afterResponse(
      c,
      setCachedJson(cacheKey, { data: fresh, fetchedAt: Date.now() }, SWR_REDIS_TTL_SECONDS),
    );
    const res = buildResponse(fresh, 'MISS');
    edgePut(c, res);
    return res;
  } catch (err) {
    if (entry) {
      logger.warn({ err, cacheKey }, 'SWR fetch failed — serving stale cache value');
      return buildResponse(entry.data, 'STALE-ERROR');
    }
    throw err;
  }
}
