import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * V6 outage-bridge tests for swrJson (2026-08-20 live incident: leaderboards
 * 503'd for 20+ hours because the serve-stale-on-error fallback expired with
 * the 15-minute Redis TTL). Contracts:
 *   1. After a successful fetch, a failing fetcher + EMPTY Redis still serves
 *      the last-good value (isolate memory leg of the bridge).
 *   2. When neither Redis nor memory has anything, the error propagates.
 *   3. A day-old last-good value is refused (stale data has a shelf life).
 */

vi.mock('../db/redis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/redis.js')>();
  return {
    ...actual,
    getCachedJson: vi.fn(async () => null),
    setCachedJson: vi.fn(async () => undefined),
  };
});

import { Hono } from 'hono';
import type { Context } from 'hono';
import { swrJson } from '../api/expansion/cache.js';
import { getCachedJson } from '../db/redis.js';

let app: Hono;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCachedJson).mockResolvedValue(null);
  app = new Hono();
});

describe('swrJson outage bridge', () => {
  it('serves the isolate last-good value when the DB fails and Redis is empty', async () => {
    let fetcherThrows = false;
    app.get('/thing', (c) =>
      swrJson(c as unknown as Context, 'bridge:test:1', async () => {
        if (fetcherThrows) throw new Error('connection terminated');
        return { value: 42 };
      }),
    );

    const ok = await app.request('/thing');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ value: 42 });

    fetcherThrows = true;
    const bridged = await app.request('/thing');
    expect(bridged.status).toBe(200); // NOT a 503 — the bridge serves
    expect(await bridged.json()).toEqual({ value: 42 });
    expect(bridged.headers.get('X-Cache')).toBe('STALE-ERROR');
  });

  it('propagates the error when there is nothing good to serve', async () => {
    app.get('/thing', (c) =>
      swrJson(c as unknown as Context, 'bridge:test:2', async () => {
        throw new Error('connection terminated');
      }),
    );
    const res = await app.request('/thing');
    expect(res.status).toBe(500);
  });

  it('serves a Redis-cached value past its stale window when the fetcher fails', async () => {
    // Redis holds a 30-minute-old entry (long-stale), DB is down.
    vi.mocked(getCachedJson).mockResolvedValue({ data: { value: 'old' }, fetchedAt: Date.now() - 30 * 60_000 });
    app.get('/thing', (c) =>
      swrJson(c as unknown as Context, 'bridge:test:3', async () => {
        throw new Error('connection terminated');
      }),
    );
    const res = await app.request('/thing');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ value: 'old' });
    expect(res.headers.get('X-Cache')).toBe('STALE-ERROR');
  });
});
