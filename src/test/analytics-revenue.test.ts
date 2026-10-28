import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

/**
 * S2-D09 — the revenue summary, reconciled against the KNOWN historical
 * order. The queue spec pins the acceptance: "the historical total must come
 * out at exactly one completed order — pn-4hgmdwlcglc0, $149.99 (including
 * $9.81 Ohio tax), 2026-08-09, product Imperator (Lifetime). If the
 * dashboard disagrees with that, the dashboard is wrong."
 *
 * THE HONEST CAVEAT, tested as behavior: no D1 table carries monetary
 * amounts or payment statuses (d1_0001/0002/0004 inspected — subscriptions
 * carry subscription state, dispatches carry commands, the ledger carries
 * DELIVERY status). The $149.99 lives only in the PayNow Management API
 * response, so the money-side reconciliation is pinned here against that
 * API's exact order shape (fetch-mocked), and the payload's d1_ledger block
 * states amounts_stored:false while corroborating what IS stored (the
 * order's lines, SKU and delivery status). Live reconciliation against the
 * real API is a post-deploy curl — see the report, "Not verified".
 *
 * These tests run the module's REAL SQL over the house SQLite adapter for
 * the D1 block, and the pure aggregation is pinned to the exact cent.
 */

let db: DatabaseSync;

function d1FromDb() {
  return {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            run: async () => {
              const info = db.prepare(sql).run(...(params as never[]));
              return { meta: { changes: Number(info.changes) } };
            },
            first: async <T>() => (db.prepare(sql).get(...(params as never[])) as T | undefined) ?? null,
            all: async <T>() => ({ results: db.prepare(sql).all(...(params as never[])) as T[] }),
          };
        },
        run: async () => {
          const info = db.prepare(sql).run();
          return { meta: { changes: Number(info.changes) } };
        },
        first: async <T>() => (db.prepare(sql).get() as T | undefined) ?? null,
        all: async <T>() => ({ results: db.prepare(sql).all() as T[] }),
      };
    },
    batch: async (stmts: Array<{ run: () => Promise<unknown> }>) => {
      for (const stmt of stmts) await stmt.run();
      return [];
    },
  };
}

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    getD1: vi.fn(() => d1FromDb()),
    query: vi.fn(async () => ({ rows: [] })),
  };
});
vi.mock('../db/redis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/redis.js')>();
  return {
    ...actual,
    getOnlinePlayerCount: vi.fn(async () => 0),
    getCachedJson: vi.fn(async () => null),
    setCachedJson: vi.fn(async () => undefined),
    sendCommandWithResponse: vi.fn(),
  };
});

import { initD1 } from '../db/pool.js';
import { __resetEnvForTests, initEnvFromBindings } from '../env.js';
import {
  fetchStoreOrders,
  isoWeekKey,
  monthKey,
  summarizeRevenue,
  type RevenueOrder,
  type RevenueSummaryPayload,
} from '../analytics/revenue.js';

/** The store's only historical order, exactly as the work-queue spec and the
 *  delivery contract record it ($149.99 = 14999 minor units, tax included). */
const IMPERATOR_ORDER: RevenueOrder = {
  id: '590329622256685056',
  pretty_id: 'pn-4hgmdwlcglc0',
  status: 'completed',
  type: 'one_time',
  created_at: '2026-08-09T22:21:38Z',
  completed_at: '2026-08-09T22:22:04Z',
  total_amount: 14999,
  currency: 'USD',
  lines: [{ product_id: '587751519030345728', product_name: 'Imperator (Lifetime)', quantity: 1 }],
};

const posts: Array<{ url: string; body: string }> = [];
const originalFetch = globalThis.fetch;

function initTestEnv(withPaynowKey: boolean): void {
  __resetEnvForTests();
  initEnvFromBindings({
    JWT_SECRET: 'test-jwt-secret-0123456789abcdef',
    WEBPANEL_HMAC_SECRET: 'test-hmac-secret',
    DISCORD_CLIENT_ID: '1',
    DISCORD_CLIENT_SECRET: 'x',
    BOT_API_TOKEN: 'test-bot-token',
    ...(withPaynowKey ? { PAYNOW_API_KEY: 'test-paynow-key' } : {}),
    PAYNOW_STORE_ID: 'test-store',
    PAYNOW_WEBHOOK_SECRETS: 'whsec',
    D1_RATE_LIMIT: { stub: true },
  } as unknown as Record<string, unknown>);
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  initD1(d1FromDb() as never);
  initTestEnv(true);
  posts.length = 0;
  // What IS stored for the known order (the delivery ledger — no amounts).
  db.exec(`CREATE TABLE IF NOT EXISTS store_delivery_ledger (
    order_id TEXT NOT NULL, line_key TEXT NOT NULL, pretty_id TEXT,
    customer_name TEXT, customer_uuid TEXT, product_id TEXT NOT NULL,
    sku_label TEXT, command TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    queued_at INTEGER NOT NULL, executed_at INTEGER, failed_reason TEXT,
    grant_verified_at INTEGER, grant_evidence TEXT, alerted_at INTEGER,
    resolved_at INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY (order_id, line_key))`);
  db.prepare(
    `INSERT INTO store_delivery_ledger
       (order_id, line_key, pretty_id, customer_name, customer_uuid, product_id, sku_label,
        command, status, queued_at, executed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'delivered', ?, ?, ?)`,
  ).run(
    '590329622256685056',
    '0:587751519030345728:1:ebc5b958-c3f1-41b6-87d9-93388ae70cc1',
    'pn-4hgmdwlcglc0',
    'koshr',
    'ebc5b958-c3f1-41b6-87d9-93388ae70cc1',
    '587751519030345728',
    'Imperator (Lifetime)',
    'lp user ebc5b958-c3f1-41b6-87d9-93388ae70cc1 parent add donor_imperator',
    Date.parse('2026-08-09T22:21:38Z'),
    Date.parse('2026-08-09T22:22:04Z'),
    Date.parse('2026-08-09T22:22:04Z'),
  );
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    posts.push({ url: String(url), body: init?.body ?? '' });
    return new Response(JSON.stringify([IMPERATOR_ORDER]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/* ── The reconciliation (the packet's acceptance, pinned to the cent) ────── */

describe('S2-D09: the known historical order reconciles exactly', () => {
  it('one completed order: gross $149.99 (14999 minor), August 2026, Imperator (Lifetime)', () => {
    const s = summarizeRevenue([IMPERATOR_ORDER], { granularity: 'month' });
    expect(s.totals.gross_minor).toBe(14999);
    expect(s.totals.refunds_minor).toBe(0);
    expect(s.totals.chargebacks_minor).toBe(0);
    expect(s.totals.net_minor).toBe(14999);
    expect(s.totals.orders_completed).toBe(1);
    expect(s.totals.orders_total).toBe(1);
    expect(s.totals.unattributed_minor).toBe(0);
    expect(s.periods).toHaveLength(1);
    expect(s.periods[0]!.period).toBe('2026-08'); // the order's month
    expect(s.periods[0]!.gross_minor).toBe(14999);
    expect(s.periods[0]!.net_minor).toBe(14999);
    expect(s.periods[0]!.orders_completed).toBe(1);
    expect(s.skus).toEqual([
      {
        product_id: '587751519030345728',
        label: 'Imperator (Lifetime)',
        units: 1,
        gross_minor: 14999,
        refunds_minor: 0,
        chargebacks_minor: 0,
        net_minor: 14999,
      },
    ]);
    expect(s.currencies).toEqual(['usd']);
    expect(s.unplaced).toBe(0);
  });

  it('the same order under week granularity lands in ISO week 2026-W32', () => {
    const s = summarizeRevenue([IMPERATOR_ORDER], { granularity: 'week' });
    expect(s.periods).toHaveLength(1);
    expect(s.periods[0]!.period).toBe('2026-W32');
    expect(s.periods[0]!.gross_minor).toBe(14999);
  });

  it('ISO week keys: year-boundary weeks name the year of the week\'s Thursday', () => {
    expect(isoWeekKey(Date.parse('2026-08-09T22:22:04Z'))).toBe('2026-W32');
    expect(isoWeekKey(Date.parse('2026-01-01T00:00:00Z'))).toBe('2026-W01');
    expect(isoWeekKey(Date.parse('2027-01-01T00:00:00Z'))).toBe('2026-W53'); // Friday; week belongs to 2026
    expect(monthKey(Date.parse('2026-08-09T22:22:04Z'))).toBe('2026-08');
  });

  it('from/to filter the WHOLE payload (totals included), inclusive bounds', () => {
    const july: RevenueOrder = { ...IMPERATOR_ORDER, id: 'o_july', completed_at: '2026-07-15T00:00:00Z', created_at: '2026-07-15T00:00:00Z', total_amount: 5000 };
    const s = summarizeRevenue([july, IMPERATOR_ORDER], { granularity: 'month', from: '2026-08-01', to: '2026-08-31' });
    expect(s.totals.gross_minor).toBe(14999); // July is gone entirely
    expect(s.periods.map((p) => p.period)).toEqual(['2026-08']);
    const inclusive = summarizeRevenue([july, IMPERATOR_ORDER], { granularity: 'month', from: '2026-07-15', to: '2026-08-09' });
    expect(inclusive.totals.gross_minor).toBe(19999); // both edge days count
    expect(inclusive.periods.map((p) => p.period)).toEqual(['2026-07', '2026-08']);
  });
});

/* ── Buckets, attribution, honesty ───────────────────────────────────────── */

describe('S2-D09: buckets and SKU attribution', () => {
  it('refunds and chargebacks come out of gross; unknown statuses count but never pay', () => {
    const refunded: RevenueOrder = { ...IMPERATOR_ORDER, id: 'o_r', status: 'refunded', total_amount: 5999, completed_at: '2026-09-02T00:00:00Z', created_at: '2026-09-02T00:00:00Z' };
    const chargeback: RevenueOrder = { ...IMPERATOR_ORDER, id: 'o_c', status: 'chargeback', total_amount: 2999, completed_at: '2026-09-03T00:00:00Z', created_at: '2026-09-03T00:00:00Z' };
    const created: RevenueOrder = { ...IMPERATOR_ORDER, id: 'o_x', status: 'created', total_amount: 12345, completed_at: '2026-09-04T00:00:00Z', created_at: '2026-09-04T00:00:00Z' };
    const canceled: RevenueOrder = { ...IMPERATOR_ORDER, id: 'o_y', status: 'canceled', total_amount: 999, completed_at: '2026-09-05T00:00:00Z', created_at: '2026-09-05T00:00:00Z' };
    const s = summarizeRevenue([IMPERATOR_ORDER, refunded, chargeback, created, canceled], { granularity: 'month' });
    expect(s.totals.gross_minor).toBe(14999);
    expect(s.totals.refunds_minor).toBe(5999);
    expect(s.totals.chargebacks_minor).toBe(2999);
    expect(s.totals.net_minor).toBe(14999 - 5999 - 2999);
    expect(s.totals.orders_completed).toBe(1);
    expect(s.totals.orders_refunded).toBe(1);
    expect(s.totals.orders_chargeback).toBe(1);
    expect(s.totals.orders_other).toBe(2); // created + canceled
    expect(s.totals.orders_total).toBe(5);
  });

  it('multi-line orders split per line when PayNow derives the amounts', () => {
    const multi: RevenueOrder = {
      ...IMPERATOR_ORDER,
      id: 'o_multi',
      total_amount: 10000,
      completed_at: '2026-09-10T00:00:00Z',
      created_at: '2026-09-10T00:00:00Z',
      lines: [
        { product_id: 'p_a', product_name: 'Aureus ×5600', quantity: 2, total_amount: 6000 },
        { product_id: 'p_b', product_name: 'Crate keys', quantity: 1, total_amount: 4000 },
      ],
    };
    const s = summarizeRevenue([multi], { granularity: 'month' });
    expect(s.totals.gross_minor).toBe(10000);
    expect(s.totals.unattributed_minor).toBe(0);
    expect(s.skus).toContainEqual(expect.objectContaining({ product_id: 'p_a', units: 2, gross_minor: 6000 }));
    expect(s.skus).toContainEqual(expect.objectContaining({ product_id: 'p_b', units: 1, gross_minor: 4000 }));
  });

  it('multi-line money without per-line amounts is NEVER split by guesswork — it lands in unattributed and the sums still reconcile', () => {
    const multi: RevenueOrder = {
      ...IMPERATOR_ORDER,
      id: 'o_opaque',
      total_amount: 10000,
      completed_at: '2026-09-10T00:00:00Z',
      created_at: '2026-09-10T00:00:00Z',
      lines: [
        { product_id: 'p_a', product_name: 'Aureus ×5600', quantity: 2 },
        { product_id: 'p_b', product_name: 'Crate keys', quantity: 1 },
      ],
    };
    const s = summarizeRevenue([multi], { granularity: 'month' });
    expect(s.totals.gross_minor).toBe(10000); // the money is real
    expect(s.totals.unattributed_minor).toBe(10000); // and named as unattributed
    const skuSum = s.skus.reduce((acc, k) => acc + k.gross_minor, 0);
    expect(skuSum + s.totals.unattributed_minor).toBe(s.totals.gross_minor); // reconciliation invariant
    expect(s.skus.find((k) => k.product_id === 'p_a')!.units).toBe(2); // units still counted
  });

  it('a single-line order attributes the ORDER total (tax-inclusive), not a pre-tax line amount', () => {
    // The known order including $9.81 Ohio tax: 14999, line says pre-tax 14018.
    const taxed: RevenueOrder = {
      ...IMPERATOR_ORDER,
      lines: [{ product_id: '587751519030345728', product_name: 'Imperator (Lifetime)', quantity: 1, total_amount: 14018 }],
    };
    const s = summarizeRevenue([taxed], { granularity: 'month' });
    expect(s.totals.gross_minor).toBe(14999);
    expect(s.skus[0]!.gross_minor).toBe(14999);
    expect(s.totals.unattributed_minor).toBe(0);
  });

  it('a lineless order keeps its money visible (unattributed), never dropped', () => {
    const bare: RevenueOrder = { ...IMPERATOR_ORDER, id: 'o_bare', lines: [] };
    const s = summarizeRevenue([bare], { granularity: 'month' });
    expect(s.totals.gross_minor).toBe(14999);
    expect(s.totals.unattributed_minor).toBe(14999);
    expect(s.totals.orders_completed).toBe(1);
    expect(s.skus).toEqual([]);
  });

  it('an order with no parsable anchor stays in totals and reports unplaced', () => {
    const ghost: RevenueOrder = { id: 'o_ghost', status: 'completed', total_amount: 700, created_at: null, completed_at: null };
    const s = summarizeRevenue([IMPERATOR_ORDER, ghost], { granularity: 'month' });
    expect(s.totals.gross_minor).toBe(15699); // 14999 + 700 — all time is complete
    expect(s.totals.orders_completed).toBe(2);
    expect(s.unplaced).toBe(1);
    expect(s.periods[0]!.gross_minor).toBe(14999); // the period only takes the placed one
  });
});

/* ── The API fetch layer ─────────────────────────────────────────────────── */

describe('S2-D09: the PayNow store-orders fetch', () => {
  it('hits the Management API with the store key and parses the order list', async () => {
    const res = await fetchStoreOrders();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.orders).toHaveLength(1);
      expect(res.orders[0]!.pretty_id).toBe('pn-4hgmdwlcglc0');
      expect(res.truncated).toBe(false);
    }
    expect(posts[0]!.url).toContain('/v1/stores/test-store/orders?limit=100');
  });

  it('a full page (100 orders) reports truncated instead of pretending completeness', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: `o_${i}`, status: 'completed', total_amount: 100 }))), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    const res = await fetchStoreOrders();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.truncated).toBe(true);
  });

  it('an API failure is a named reason, never an exception', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 502 })) as typeof fetch;
    const res = await fetchStoreOrders();
    expect(res).toEqual({ ok: false, reason: 'paynow_api_status_502' });
  });

  it('no store key configured is a named reason (pre-init fallback, no process env)', async () => {
    __resetEnvForTests(); // the accessor falls back to process.env — unset here
    const res = await fetchStoreOrders();
    expect(res).toEqual({ ok: false, reason: 'paynow_not_configured' });
  });
});

/* ── The route: gate, validation, payload ────────────────────────────────── */

describe('GET /api/v2/admin/revenue/summary', () => {
  let app: ReturnType<typeof import('../app.js').createApp>;

  beforeEach(async () => {
    const { createApp } = await import('../app.js');
    app = createApp();
  });

  const BOT = { 'X-Bot-Token': 'test-bot-token' };
  const ADMIN = { ...BOT, 'X-Staff-Role': 'admin' };
  const HELPER = { ...BOT, 'X-Staff-Role': 'helper' };

  it('the fail-closed admin gate: anonymous 401, helper 403, admin 200', async () => {
    expect((await app.request('/api/v2/admin/revenue/summary')).status).toBe(401);
    expect((await app.request('/api/v2/admin/revenue/summary', { headers: HELPER })).status).toBe(403);
    expect((await app.request('/api/v2/admin/revenue/summary', { headers: ADMIN })).status).toBe(200);
  });

  it('junk granularity and dates are 400s, never silent defaults', async () => {
    expect((await app.request('/api/v2/admin/revenue/summary?granularity=day', { headers: ADMIN })).status).toBe(400);
    expect((await app.request('/api/v2/admin/revenue/summary?from=08/09/2026', { headers: ADMIN })).status).toBe(400);
    expect((await app.request('/api/v2/admin/revenue/summary?to=2026-13-99', { headers: ADMIN })).status).toBe(400);
  });

  it('serves the reconciled payload: money from the API, D1 block labeled amounts_stored=false', async () => {
    const res = await app.request('/api/v2/admin/revenue/summary?granularity=month', { headers: ADMIN });
    expect(res.status).toBe(200);
    const json = (await res.json()) as RevenueSummaryPayload;
    expect(json.granularity).toBe('month');
    expect(json.money.available).toBe(true);
    expect(json.money.summary!.totals.gross_minor).toBe(14999); // THE reconciliation number
    expect(json.money.summary!.periods[0]!.period).toBe('2026-08');
    expect(json.money.summary!.totals.orders_completed).toBe(1);
    // What IS stored corroborates the order — and states it carries no amounts.
    expect(json.d1_ledger.amounts_stored).toBe(false);
    expect(json.d1_ledger.orders).toBe(1);
    expect(json.d1_ledger.lines).toBe(1);
    expect(json.d1_ledger.by_status).toEqual({ delivered: 1 });
    expect(json.d1_ledger.by_sku[0]!.sku_label).toBe('Imperator (Lifetime)');
    expect(json.d1_ledger.by_sku[0]!.orders).toBe(1);
  });

  it('a PayNow API outage serves the named gap next to the still-truthful D1 block — never fabricated zeros', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    const res = await app.request('/api/v2/admin/revenue/summary', { headers: ADMIN });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      money: { available: boolean; unavailable_reason?: string; summary: unknown };
      d1_ledger: { orders: number };
    };
    expect(json.money.available).toBe(false);
    expect(json.money.unavailable_reason).toBe('paynow_api_status_500');
    expect(json.money.summary).toBeNull();
    expect(json.d1_ledger.orders).toBe(1); // the stored half is still served
  });
});
