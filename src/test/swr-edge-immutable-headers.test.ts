import { afterEach, describe, expect, it } from 'vitest';

/**
 * L15 (2026-11-14): responses returned by the Workers Cache API
 * (`caches.default.match`) have IMMUTABLE headers in workerd. The EDGE-hit
 * branch of swrJson used to do `hit.clone().headers.set('X-Cache', 'EDGE')`
 * — a TypeError on every real edge hit, which escaped swrJson (the edge
 * branch predates its try/catch) and hit the route's outer catch: every
 * public SWR route (seasons/current, growth snapshot, leaderboards, shop
 * catalog, legion cards) 503'd exactly when the edge cache served the
 * request, i.e. under real traffic within the 60s TTL. Observed live on
 * 2026-11-14: /api/seasons/current answered 200 once then 503 for every
 * edge-served repeat ("TypeError: Can't modify immutable headers").
 *
 * This test simulates the immutable guard (the header bag of a cached
 * response throws on mutation, exactly like workerd) and pins the contract:
 * the EDGE path must SERVE the hit with X-Cache: EDGE — rebuilding the
 * response, never mutating the matched one.
 */

/** A Headers bag that refuses mutation the way workerd's cache hits do. */
class ImmutableHeaders extends Headers {
  override set(): Headers {
    throw new TypeError("Can't modify immutable headers.");
  }
  override append(): Headers {
    throw new TypeError("Can't modify immutable headers.");
  }
}

function installImmutableEdgeCache(hitBody: string): void {
  const headers = new ImmutableHeaders({
    'content-type': 'application/json;charset=UTF-8',
    'cache-control': 'public, max-age=60, stale-while-revalidate=300',
  });
  const matched = {
    status: 200,
    statusText: 'OK',
    body: hitBody,
    headers,
    clone(): Response {
      return matched as unknown as Response;
    },
  };
  (globalThis as unknown as { caches: unknown }).caches = {
    default: {
      match: async (): Promise<Response> => matched as unknown as Response,
      put: async (): Promise<void> => {
        /* never reached in this test */
      },
    },
  };
}

afterEach(() => {
  delete (globalThis as unknown as { caches?: unknown }).caches;
});

describe('swrJson edge-cache hits (immutable headers)', () => {
  it('serves an EDGE hit with X-Cache: EDGE instead of mutating the cached response', async () => {
    const { Hono } = await import('hono');
    const { swrJson } = await import('../api/expansion/cache.js');

    installImmutableEdgeCache(JSON.stringify({ served: 'edge' }));

    const app = new Hono();
    app.get('/cached', (c) =>
      swrJson(c, 'edge:immutable:test:v1', async () => ({ served: 'fetcher' })).catch(() =>
        // The route-level failure mode the old bug produced (seasons-style
        // outer catch) — kept explicit so the regression reads as a 503.
        c.json({ error: 'Database unavailable' }, 503),
      ),
    );

    const res = await app.request('/cached');
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Cache')).toBe('EDGE');
    await expect(res.json()).resolves.toEqual({ served: 'edge' });
  });

  it('does not call any mutator on the matched response header bag', async () => {
    const { Hono } = await import('hono');
    const { swrJson } = await import('../api/expansion/cache.js');

    let mutated = false;
    const headers = new ImmutableHeaders({ 'content-type': 'application/json' });
    const originalSet = Headers.prototype.set;
    Headers.prototype.set = function spySet(
      this: Headers,
      ...args: [string, string]
    ): void {
      if (headers === (this as unknown as object)) {
        mutated = true;
      }
      originalSet.apply(this, args);
    };

    const matched = {
      status: 200,
      statusText: 'OK',
      body: JSON.stringify({ a: 1 }),
      headers,
      clone(): Response {
        return matched as unknown as Response;
      },
    };
    (globalThis as unknown as { caches: unknown }).caches = {
      default: { match: async () => matched as unknown as Response, put: async () => {} },
    };

    const app = new Hono();
    app.get('/cached', (c) => swrJson(c, 'edge:spy:test:v1', async () => ({ a: 2 })));
    const res = await app.request('/cached');
    Headers.prototype.set = originalSet;
    expect(res.status).toBe(200);
    expect(mutated).toBe(false);
  });
});
