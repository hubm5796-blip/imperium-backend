import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B-25/bC13 — rateLimitV2 durability:
 *   1. Counters live in D1, not a per-isolate Map: TWO middleware instances
 *      (isolates) sharing the D1 binding see each other's charges — the
 *      in-memory version reset per isolate ("effectively no limit").
 *   2. Budgets come from the env module (bindings-first), not process.env.
 *   3. inferClass knows the /api/v2 residents (they used to fall to 'std').
 *   4. Machine principals hash the token — distinct integrations get distinct
 *      fairness buckets; the raw token never appears in a key.
 *   5. Over-budget → 429 with scope + Retry-After; D1 failure → fail-open.
 */

const { table, d1Broken } = vi.hoisted(() => ({
  table: new Map<string, { window_start: number; cost: number }>(),
  d1Broken: { value: false },
}));

interface FakeStmt {
  sql: string;
  params: unknown[];
}

function exec(sql: string, params: unknown[]): boolean {
  if (/^CREATE TABLE/i.test(sql)) return true;
  if (/^DELETE FROM/i.test(sql)) {
    const cutoff = params[0] as number;
    for (const [k, v] of table) if (v.window_start < cutoff) table.delete(k);
    return true;
  }
  const insert = /^INSERT INTO rate_limit_v2_windows/i.test(sql);
  if (insert) {
    const [key, windowStart, cost] = params as [string, number, number];
    const existing = table.get(key);
    const newCost = (existing?.cost ?? 0) + Number(cost);
    table.set(key, { window_start: Number(windowStart), cost: newCost });
    (exec as unknown as { lastReturn?: unknown }).lastReturn = [{ cost: newCost }];
    return true;
  }
  return false;
}

function fakeD1() {
  if (d1Broken.value) throw new Error('D1 down');
  return {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            sql,
            params,
            async run() {
              return { meta: { changes: exec(sql, params) ? 1 : 0 } };
            },
            async first<T>() {
              exec(sql, params);
              return (((exec as unknown as { lastReturn?: unknown }).lastReturn as T[] | undefined)?.[0] ?? null) as T | null;
            },
          };
        },
        async run() {
          return { meta: { changes: exec(sql, []) ? 1 : 0 } };
        },
      };
    },
    async batch(stmts: Array<{ sql: string; params: unknown[] }>) {
      const out: Array<{ meta: { changes: number }; results: Array<{ cost: number }> }> = [];
      for (const s of stmts) {
        const isInsert = /^INSERT INTO rate_limit_v2_windows/i.test(s.sql);
        if (isInsert) {
          exec(s.sql, s.params);
          out.push({
            meta: { changes: 1 },
            results: ((exec as unknown as { lastReturn?: Array<{ cost: number }> }).lastReturn ?? []) as Array<{ cost: number }>,
          });
        } else {
          exec(s.sql, s.params);
          out.push({ meta: { changes: 0 }, results: [] });
        }
      }
      return out;
    },
  };
}

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    getD1: vi.fn(() => fakeD1()),
  };
});

import { Hono } from 'hono';
import { inferClass, principalOf, rateLimitV2 } from '../middleware/rateLimitV2.js';
import { __resetEnvForTests, initEnvFromBindings, env } from '../env.js';
import { getD1 } from '../db/pool.js';
import type { Context } from 'hono';

function ctxWithHeaders(headers: Record<string, string>): Context {
  return {
    req: { header: (name: string) => headers[name.toLowerCase()] },
    var: {},
  } as unknown as Context;
}

beforeAll(() => {
  __resetEnvForTests();
  initEnvFromBindings({
    JWT_SECRET: 'test-jwt-secret-0123456789abcdef',
    DISCORD_CLIENT_ID: '1',
    DISCORD_CLIENT_SECRET: 'x',
    WEBPANEL_HMAC_SECRET: 'hmac',
    PAYNOW_API_KEY: 'pk',
    PAYNOW_STORE_ID: '1',
    PAYNOW_WEBHOOK_SECRETS: 'whsec',
    RL_V2_IP_BUDGET: '10',
    RL_V2_PRINCIPAL_BUDGET: '20',
  } as unknown as Record<string, unknown>);
});

beforeEach(() => {
  table.clear();
  d1Broken.value = false;
});

describe('B-25 inferClass knows the v2 residents', () => {
  it('classifies v2 paths that used to fall through to std', () => {
    expect(inferClass('GET', '/api/v2/events/stream')).toBe('free');
    expect(inferClass('GET', '/api/v2/ping')).toBe('cheap');
    expect(inferClass('GET', '/api/v2/openapi.json')).toBe('cheap');
    expect(inferClass('GET', '/api/v2/public/player/SomeOne')).toBe('heavy');
    expect(inferClass('GET', '/api/v2/community/gallery')).toBe('std');
    expect(inferClass('POST', '/api/v2/anything')).toBe('write');
    expect(inferClass('GET', '/api/leaderboards/denarius')).toBe('cheap');
  });
});

describe('B-25 machine principals', () => {
  it('distinct tokens get distinct hashed buckets; the raw token is never in the key', () => {
    const a = principalOf(ctxWithHeaders({ 'x-bot-token': 'integration-token-one' }));
    const b = principalOf(ctxWithHeaders({ 'x-bot-token': 'integration-token-two' }));
    expect(a).toMatch(/^machine:[0-9a-f]{16}$/);
    expect(b).toMatch(/^machine:[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain('integration-token-one');
  });

  it('a session uuid principals as session:<uuid>', () => {
    const c = ctxWithHeaders({});
    (c.var as unknown as { mcUuid?: string }).mcUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    expect(principalOf(c)).toBe('session:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  });
});

describe('B-25 budgets are bindings-first', () => {
  it('the env module carries the configured budgets (not process.env defaults)', () => {
    expect(env.rlV2IpBudget).toBe(10);
    expect(env.rlV2PrincipalBudget).toBe(20);
  });
});

describe('B-25 D1-shared counters across isolates', () => {
  function makeApp(): Hono {
    const app = new Hono();
    app.use('*', rateLimitV2());
    app.post('/api/v2/thing', (c) => c.json({ ok: true }));
    app.get('/api/v2/thing', (c) => c.json({ ok: true }));
    return app;
  }

  it('charges accumulate across separate middleware instances (isolates)', async () => {
    const isolateA = makeApp();
    const isolateB = makeApp();
    const headers = { 'cf-connecting-ip': '198.51.100.9', 'content-type': 'application/json' };

    // write class costs 10; IP budget 10 → first POST passes everywhere.
    const a1 = await isolateA.request('/api/v2/thing', { method: 'POST', headers });
    expect(a1.status).toBe(200);
    // A SECOND isolate must see isolate A's charge in D1 and refuse — the
    // in-memory version reset per isolate and let everything through.
    const b1 = await isolateB.request('/api/v2/thing', { method: 'POST', headers });
    expect(b1.status).toBe(429);
    const body = (await b1.json()) as { scope: string; class: string };
    expect(body.scope).toBe('ip');
    expect(body.class).toBe('write');
    expect(b1.headers.get('Retry-After')).toBe('60');
  });

  it('free-class requests cost nothing and never touch D1', async () => {
    const app = makeApp();
    app.get('/api/v2/events/stream', (c) => c.json({ ok: true }));
    const before = (getD1 as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    const res = await app.request('/api/v2/events/stream', {
      headers: { 'cf-connecting-ip': '198.51.100.10' },
    });
    expect(res.status).toBe(200);
    expect((getD1 as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before);
  });

  it('D1 failure fails open (availability over limiting)', async () => {
    const app = makeApp();
    d1Broken.value = true;
    const res = await app.request('/api/v2/thing', {
      method: 'POST',
      headers: { 'cf-connecting-ip': '198.51.100.11', 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
  });

  it('different principals under one IP split fairly: principal budget exhausted on its own', async () => {
    const app = makeApp();
    // GET = std = 2 cost; principal budget 20 → 10 reads by ONE token, then
    // the principal scope trips while the ip bucket (10) also trips at 5
    // reads. Use distinct IPs to isolate the principal dimension.
    const headers = { 'x-bot-token': 'token-x' };
    let principalTrip = false;
    for (let i = 0; i < 12; i++) {
      const res = await app.request('/api/v2/thing', {
        headers: { ...headers, 'cf-connecting-ip': `198.51.100.${20 + i}` },
      });
      if (res.status === 429) {
        const body = (await res.json()) as { scope: string };
        expect(body.scope).toBe('principal');
        principalTrip = true;
        break;
      }
    }
    expect(principalTrip).toBe(true);
  });
});
