import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * S2-D02 — the delivery ledger.
 *
 * Acceptance (queue spec): a purchase writes a row; a command that never
 * executes is visible as `stale`, not as silence. The regression property:
 * on the pre-packet code there were NO ledger writes at all and the
 * GET /admin/deliveries endpoint did not exist (404) — the seeded-stale and
 * purchase-row tests below are red on that tree.
 */

/* ── the in-memory D1 (interprets exactly the SQL deliveryLedger emits) ──── */

const { getUuidByPaynowCustomerIdMock, setPaynowCustomerIdMock, getPaynowCustomerMock, sendCommandWithResponseMock } =
  vi.hoisted(() => ({
    getUuidByPaynowCustomerIdMock: vi.fn(),
    setPaynowCustomerIdMock: vi.fn(),
    getPaynowCustomerMock: vi.fn(),
    sendCommandWithResponseMock: vi.fn(),
  }));

function makeLedgerD1() {
  type Row = Record<string, unknown>;
  const rows = new Map<string, Row>();
  return {
    __rows: rows,
    prepare(sql: string) {
      const exec = (params: unknown[]) => ({
        run: async () => {
          if (sql.includes('CREATE TABLE') || sql.includes('CREATE INDEX')) return { meta: { changes: 0 } };
          // The fulfillment idempotency claim (paynow_order_dispatches):
          // each INSERT claims the line so dispatch proceeds.
          if (sql.includes('INSERT INTO paynow_order_dispatches')) return { meta: { changes: 1 } };
          if (sql.includes('DELETE FROM paynow_order_dispatches')) return { meta: { changes: 1 } };
          if (sql.startsWith('INSERT INTO store_delivery_ledger')) {
            // Placeholders only (the VALUES clause also carries literals):
            // (order_id, line_key, pretty_id, customer_name, customer_uuid,
            //  product_id, sku_label, command, queued_at, updated_at)
            const [
              order_id, line_key, pretty_id, customer_name, customer_uuid,
              product_id, sku_label, command, queued_at, updated_at,
            ] = params as string[];
            const key = `${order_id}|${line_key}`;
            const existing = rows.get(key);
            if (existing) {
              // ON CONFLICT DO UPDATE SET status='pending', executed_at=NULL,
              // failed_reason=NULL, updated_at=excluded.updated_at
              existing['status'] = 'pending';
              existing['executed_at'] = null;
              existing['failed_reason'] = null;
              existing['updated_at'] = updated_at;
            } else {
              rows.set(key, {
                order_id, line_key, pretty_id, customer_name, customer_uuid,
                product_id, sku_label, command,
                status: 'pending', queued_at, executed_at: null, failed_reason: null,
                grant_verified_at: null, grant_evidence: null,
                alerted_at: null, resolved_at: null, updated_at,
              });
            }
            return { meta: { changes: existing ? 0 : 1 } };
          }
          if (sql.startsWith('UPDATE store_delivery_ledger')) {
            const setPart = sql.slice(sql.indexOf('SET ') + 4, sql.indexOf(' WHERE '));
            const sets = [...setPart.matchAll(/(\w+) = \?/g)].map((m) => m[1]!);
            const wherePart = sql.slice(sql.indexOf(' WHERE '));
            const whereKeys = [...wherePart.matchAll(/(order_id|line_key) = \?/g)].map((m) => m[1]!);
            // Bind order: SET params..., then WHERE params in SQL order.
            const setValues = params.slice(0, sets.length);
            const whereValues = params.slice(sets.length);
            let changed = 0;
            for (const [, row] of rows) {
              const okMatch = whereKeys.every((wk, i) => row[wk] === whereValues[i]);
              if (!okMatch) continue;
              sets.forEach((col, i) => {
                row[col] = setValues[i];
              });
              changed++;
            }
            return { meta: { changes: changed } };
          }
          return { meta: { changes: 0 } };
        },
        first: async () => null,
        all: async () => {
          if (sql.includes('FROM store_delivery_ledger')) {
            const all = [...rows.values()] as Row[];
            all.sort((a, b) => (b['queued_at'] as number) - (a['queued_at'] as number));
            return { results: all };
          }
          return { results: [] };
        },
      });
      return {
        bind: (...params: unknown[]) => exec(params),
        ...exec([]),
      };
    },
  };
}

/* ── module mocks (fulfillment's collaborators) ──────────────────────────── */

vi.mock('../db/redis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/redis.js')>();
  return { ...actual, sendCommandWithResponse: sendCommandWithResponseMock };
});
vi.mock('../paynow/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../paynow/client.js')>();
  return { ...actual, getPaynowCustomer: getPaynowCustomerMock };
});

import { initD1 } from '../db/pool.js';
import { __resetEnvForTests, initEnvFromBindings } from '../env.js';
import { fulfillPaynowOrder } from '../paynow/fulfillment.js';
import {
  STALE_AFTER_MS,
  effectiveStatus,
  ledgerLineExecuted,
  ledgerLineFailed,
  ledgerLineQueued,
} from '../db/deliveryLedger.js';

const BUYER = '11111111-2222-4333-8444-555555555555';
const AUREUS_50 = '588822585022619648';
const LIFETIME_PEREGRINUS = '587751069837164544';
const STAFF = { 'X-Staff-Token': 'stafftok', 'X-Staff-Actor': 'LedgerLarry' };

let d1 = makeLedgerD1();
let app: ReturnType<typeof import('../app.js').createApp>;

function okResponse() {
  return { ok: true, status: 'OK', request_id: 'req_test' };
}

function aureusOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ord_ledger',
    pretty_id: 'pn-ledger1',
    customer: { id: 'cus_buyer', minecraft: { id: BUYER, name: 'LedgerLarry' } },
    lines: [{ id: 'l1', product_id: AUREUS_50, quantity: 1 }],
    ...overrides,
  };
}

beforeAll(async () => {
  __resetEnvForTests();
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
    STAFF_ACTOR_TOKEN_MAP: 'stafftok:LedgerLarry:helper',
    D1_RATE_LIMIT: { stub: true },
  } as unknown as Record<string, unknown>);
  const { createApp } = await import('../app.js');
  app = createApp();
});

beforeEach(() => {
  d1 = makeLedgerD1();
  initD1(d1 as never);
  sendCommandWithResponseMock.mockReset();
  getUuidByPaynowCustomerIdMock.mockReset();
  setPaynowCustomerIdMock.mockReset();
  getPaynowCustomerMock.mockReset();
  getUuidByPaynowCustomerIdMock.mockResolvedValue(BUYER);
});

/* ── the purchase writes a row (fulfillment → ledger) ────────────────────── */

describe('S2-D02: a purchase writes a ledger row', () => {
  it('a fulfilled order leaves a delivered row with the command as sent', async () => {
    sendCommandWithResponseMock.mockResolvedValue(okResponse());
    const result = await fulfillPaynowOrder(aureusOrder());
    expect(result.status).toBe('ok');

    const rows = [...d1.__rows.values()];
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row['order_id']).toBe('ord_ledger');
    expect(row['status']).toBe('delivered');
    expect(row['executed_at']).not.toBeNull();
    expect(row['customer_uuid']).toBe(BUYER);
    expect(row['customer_name']).toBe('LedgerLarry');
    expect(row['pretty_id']).toBe('pn-ledger1');
    expect(row['sku_label']).toBe('Aureus ×5600');
    expect(String(row['command'])).toContain('STORE_PURCHASE_AUREUS');
    expect(String(row['command'])).toContain(BUYER);
  });

  it('a failed dispatch leaves a failed row with the reason', async () => {
    sendCommandWithResponseMock.mockRejectedValue(new Error('plugin offline'));
    const result = await fulfillPaynowOrder(aureusOrder());
    expect(result.status).toBe('error');
    const row = [...d1.__rows.values()][0]!;
    expect(row['status']).toBe('failed');
    expect(String(row['failed_reason'])).toContain('plugin offline');
    expect(row['executed_at']).toBeNull();
  });

  it('a PayNow retry of a failed line re-queues it, then delivers it', async () => {
    sendCommandWithResponseMock.mockRejectedValueOnce(new Error('plugin offline'));
    await fulfillPaynowOrder(aureusOrder());
    sendCommandWithResponseMock.mockResolvedValue(okResponse());
    const retry = await fulfillPaynowOrder(aureusOrder());
    expect(retry.status).toBe('ok');
    const rows = [...d1.__rows.values()];
    expect(rows).toHaveLength(1); // same line row, updated — not duplicated
    expect(rows[0]!['status']).toBe('delivered');
    expect(rows[0]!['executed_at']).not.toBeNull();
  });

  it('a rank grant writes its tier as the sku label', async () => {
    sendCommandWithResponseMock.mockResolvedValue(okResponse());
    await fulfillPaynowOrder(aureusOrder({ lines: [{ id: 'l1', product_id: LIFETIME_PEREGRINUS, quantity: 1 }] }));
    const row = [...d1.__rows.values()][0]!;
    expect(row['sku_label']).toBe('PEREGRINUS (lifetime)');
    expect(String(row['command'])).toContain('STORE_PURCHASE_RANK');
  });

  it('ledger failures never fail the fulfillment (enrichment discipline)', async () => {
    // Break the ledger (no D1) — the delivery must still succeed.
    initD1({
      prepare: () => {
        throw new Error('D1 gone');
      },
    } as never);
    sendCommandWithResponseMock.mockResolvedValue(okResponse());
    const result = await fulfillPaynowOrder(aureusOrder());
    expect(result.status).toBe('ok');
    expect(result.dispatched).toBe(1);
  });
});

/* ── the reader endpoint ─────────────────────────────────────────────────── */

describe('GET /api/v2/admin/deliveries', () => {
  async function seed(overrides: Partial<Parameters<typeof ledgerLineQueued>[0]> = {}, queuedAt?: number) {
    await ledgerLineQueued({
      orderId: 'ord_a',
      lineKey: '0:p1:1:u1',
      prettyId: 'pn-1',
      customerName: 'BuyerBeth',
      customerUuid: BUYER,
      productId: 'p1',
      skuLabel: 'Aureus ×5600',
      command: 'STORE_PURCHASE_AUREUS {"player_uuid":"u1"}',
      queuedAt,
      ...overrides,
    });
  }

  it('is staff-gated: 401 unauthenticated, 403 for the bare shared token', async () => {
    expect((await app.request('/api/v2/admin/deliveries')).status).toBe(401);
    // The shared bot token authenticates but confers NO staff role (S2-D01) —
    // the unmapped service principal is refused, never defaulted in.
    expect(
      (await app.request('/api/v2/admin/deliveries', { headers: { 'X-Bot-Token': 'test-bot-token' } })).status,
    ).toBe(403);
  });

  it('a staff token reads the ledger; items carry the contract shape', async () => {
    await seed();
    await ledgerLineExecuted('ord_a', '0:p1:1:u1', 1_700_000_000_000);
    const res = await app.request('/api/v2/admin/deliveries', { headers: STAFF });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<Record<string, unknown>>; next_cursor: string | null };
    expect(body.items).toHaveLength(1);
    const item = body.items[0]!;
    expect(item.order_id).toBe('ord_a');
    expect(item.pretty_id).toBe('pn-1');
    expect(item.customer).toEqual({ name: 'BuyerBeth', uuid: BUYER });
    expect(item.product_id).toBe('p1');
    expect(item.sku_label).toBe('Aureus ×5600');
    expect(item.commands_issued).toEqual(['STORE_PURCHASE_AUREUS {"player_uuid":"u1"}']);
    expect(item.executed_at).toEqual([new Date(1_700_000_000_000).toISOString()]);
    expect(item.status).toBe('delivered');
    expect(item.grant_verified_at).toBeNull(); // no in-game verifier yet — honest null
  });

  it('a line queued >24h unexecuted reads STALE — and the status filter honors it', async () => {
    const old = Date.now() - STALE_AFTER_MS - 60_000;
    await seed({ orderId: 'ord_stale' }, old);
    await seed({ orderId: 'ord_fresh' }, Date.now());

    const all = (await app.request('/api/v2/admin/deliveries', { headers: STAFF })) as Response;
    const allBody = (await all.json()) as { items: Array<Record<string, unknown>> };
    const byOrder = new Map(allBody.items.map((i) => [i.order_id, i.status]));
    expect(byOrder.get('ord_stale')).toBe('stale'); // silence would be the old failure mode
    expect(byOrder.get('ord_fresh')).toBe('pending');

    const staleOnly = await app.request('/api/v2/admin/deliveries?status=stale', { headers: STAFF });
    const staleBody = (await staleOnly.json()) as { items: Array<{ order_id: string }> };
    expect(staleBody.items.map((i) => i.order_id)).toEqual(['ord_stale']);

    const pendingOnly = await app.request('/api/v2/admin/deliveries?status=pending', { headers: STAFF });
    const pendingBody = (await pendingOnly.json()) as { items: Array<{ order_id: string }> };
    expect(pendingBody.items.map((i) => i.order_id)).toEqual(['ord_fresh']);
  });

  it('date (from/to) and product_id filters apply', async () => {
    const t0 = Date.parse('2026-08-01T00:00:00Z');
    await seed({ orderId: 'ord_aug', productId: 'p_aug' }, t0);
    await seed({ orderId: 'ord_oct', productId: 'p_oct' }, Date.parse('2026-10-01T00:00:00Z'));

    const fromSep = await app.request('/api/v2/admin/deliveries?from=2026-09-01', { headers: STAFF });
    expect(((await fromSep.json()) as { items: Array<{ order_id: string }> }).items.map((i) => i.order_id)).toEqual(['ord_oct']);

    const toSep = await app.request('/api/v2/admin/deliveries?to=2026-09-01', { headers: STAFF });
    expect(((await toSep.json()) as { items: Array<{ order_id: string }> }).items.map((i) => i.order_id)).toEqual(['ord_aug']);

    const byProd = await app.request('/api/v2/admin/deliveries?product_id=p_aug', { headers: STAFF });
    expect(((await byProd.json()) as { items: Array<{ order_id: string }> }).items.map((i) => i.order_id)).toEqual(['ord_aug']);
  });

  it('pagination: limit + next_cursor walk the full item list; invalid input 400s', async () => {
    for (let i = 0; i < 3; i++) {
      await seed({ orderId: `ord_${i}`, lineKey: `0:p${i}:1:u` }, Date.parse('2026-10-02T00:00:00Z') + i);
    }
    const page1 = await app.request('/api/v2/admin/deliveries?limit=2', { headers: STAFF });
    const body1 = (await page1.json()) as { items: Array<{ order_id: string }>; next_cursor: string | null };
    expect(body1.items).toHaveLength(2);
    expect(body1.next_cursor).toBeTruthy();

    const page2 = await app.request(`/api/v2/admin/deliveries?limit=2&cursor=${body1.next_cursor}`, { headers: STAFF });
    const body2 = (await page2.json()) as { items: Array<{ order_id: string }>; next_cursor: string | null };
    expect(body2.items).toHaveLength(1);
    expect(body2.next_cursor).toBeNull();

    const ids = [...body1.items, ...body2.items].map((i) => i.order_id).sort();
    expect(ids).toEqual(['ord_0', 'ord_1', 'ord_2']);

    expect((await app.request('/api/v2/admin/deliveries?status=bogus', { headers: STAFF })).status).toBe(400);
    expect((await app.request('/api/v2/admin/deliveries?cursor=%%%', { headers: STAFF })).status).toBe(400);
  });

  it('a failed dispatch is filterable as failed', async () => {
    await seed({ orderId: 'ord_fail' });
    await ledgerLineFailed('ord_fail', '0:p1:1:u1', 'rejected: Deposit failed');
    const res = await app.request('/api/v2/admin/deliveries?status=failed', { headers: STAFF });
    const body = (await res.json()) as { items: Array<{ order_id: string; status: string }> };
    expect(body.items.map((i) => i.order_id)).toEqual(['ord_fail']);
    expect(body.items[0]!.status).toBe('failed');
  });
});

/* ── pure status semantics ───────────────────────────────────────────────── */

describe('effectiveStatus', () => {
  const now = 1_000_000_000_000;
  it('pending inside 24h stays pending; past 24h reads stale', () => {
    expect(effectiveStatus({ status: 'pending', queued_at: now - 1000 }, now)).toBe('pending');
    expect(effectiveStatus({ status: 'pending', queued_at: now - STALE_AFTER_MS - 1 }, now)).toBe('stale');
  });
  it('terminal statuses pass through', () => {
    expect(effectiveStatus({ status: 'delivered', queued_at: now - STALE_AFTER_MS - 1 }, now)).toBe('delivered');
    expect(effectiveStatus({ status: 'failed', queued_at: now - 1000 }, now)).toBe('failed');
  });
});
