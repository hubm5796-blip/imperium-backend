import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * B-51: /auth/exchange has its own limiter namespace — exhausting the
 * webcode brute-force budget (the shared 'webcode' prefix they previously
 * shared) must NOT lock the OAuth callback handoff out.
 * B-26 companion: both limits are enforced through the real D1 counter
 * store (in-memory fake implementing the exact statements rateLimit uses).
 */
vi.mock('../db/redis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/redis.js')>();
  return {
    ...actual,
    consumeSessionCode: vi.fn(async () => null),
    consumeLoginCode: vi.fn(async () => null),
  };
});

import { createApp } from '../app.js';
import { initEnvFromBindings } from '../env.js';
import { initD1 } from '../db/pool.js';

/** In-memory D1 implementing the rate_limit_windows upsert the limiter uses. */
function makeRateD1() {
  const windows = new Map<string, number>();
  return {
    windows,
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            first: async () => {
              if (sql.includes('RETURNING hits')) {
                const key = String(params[0]);
                const hits = (windows.get(key) ?? 0) + 1;
                windows.set(key, hits);
                return { hits };
              }
              return null;
            },
            run: async () => ({ meta: { changes: 1 } }),
          };
        },
        run: async () => ({ meta: { changes: 1 } }),
      };
    },
  };
}

let app: ReturnType<typeof createApp>;
let d1: ReturnType<typeof makeRateD1>;

describe('B-51 webcode/exchange limiter split', () => {
  beforeAll(() => {
    initEnvFromBindings({
      JWT_SECRET: 'test-jwt-secret-0123456789abcdef0123456789abcdef',
      WEBPANEL_HMAC_SECRET: 'test-hmac-secret-0123456789abcdef0123456789abcdef',
      DISCORD_CLIENT_ID: 'test-client-id',
      DISCORD_CLIENT_SECRET: 'test-client-secret',
      BOT_API_TOKEN: 'test-bot-token',
      PAYNOW_API_KEY: 'test-paynow-key',
      PAYNOW_STORE_ID: 'test-store',
      PAYNOW_WEBHOOK_SECRETS: 'test-webhook-secret',
      NODE_ENV: 'test',
    } as unknown as Record<string, unknown>);
    d1 = makeRateD1();
    initD1(d1 as never);
    app = createApp();
  });

  it('exhausting the webcode budget leaves /auth/exchange untouched', async () => {
    // Burn the entire webcode budget (8/5min) with bad codes...
    for (let i = 0; i < 8; i++) {
      const res = await app.request('/api/auth/webcode/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Bot-Token': 'test-bot-token' },
        body: JSON.stringify({ code: '000000' }),
      });
      expect(res.status).toBe(404); // consumed by the limiter, rejected by the (mocked) store
    }
    // ...the 9th webcode attempt is now rate-limited...
    const ninth = await app.request('/api/auth/webcode/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bot-Token': 'test-bot-token' },
      body: JSON.stringify({ code: '000000' }),
    });
    expect(ninth.status).toBe(429);
    // ...but the OAuth handoff exchange still works (own 'exchange' bucket).
    const exchange = await app.request('/api/auth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
      body: JSON.stringify({ code: 'whatever-handoff-code' }),
    });
    expect(exchange.status).toBe(404); // invalid code — NOT 429
  });

  it('the exchange limiter has its own bound (10/min)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await app.request('/api/auth/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.10' },
        body: JSON.stringify({ code: 'x' }),
      });
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 429)).toHaveLength(1);
    expect(statuses[10]).toBe(429);
    // Distinct namespaces in the counter store.
    expect([...d1.windows.keys()].some((k) => k.startsWith('webcode:'))).toBe(true);
    expect([...d1.windows.keys()].some((k) => k.startsWith('exchange:'))).toBe(true);
  });
});
