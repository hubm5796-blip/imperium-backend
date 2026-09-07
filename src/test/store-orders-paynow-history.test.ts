/**
 * bC10 — the store-orders surfaces claimed a "unified" web_shop + paynow
 * history but only ever queried web_queue, so every real-money purchase
 * (lifetime ranks, upgrades, Aureus packs) vanished from the player's order
 * history after checkout. These tests pin the merge:
 *
 *  - paynow/history.ts (the shared helper): Management API list + dispatch-
 *    ledger evidence → status mapping ('delivered' only with ledger proof),
 *    label derivation, and quiet degradation on every upstream failure.
 *  - GET /api/shop/orders (the route the frontend proxy actually calls):
 *    merged newest-first response; PayNow outage degrades to web rows only.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, getPaynowCustomerIdMock, listCustomerOrdersMock, fakeD1 } = vi.hoisted(() => {
  /** D1 fake: answers the dispatch-ledger SELECT ... IN (...) with canned rows. */
  function makeFakeD1() {
    let ledgerRows: { order_id: string; delivered_at: string }[] = [];
    return {
      __setLedger(rows: { order_id: string; delivered_at: string }[]) {
        ledgerRows = rows;
      },
      prepare(sql: string) {
        return {
          bind: (...params: string[]) => ({
            all: async () => {
              if (sql.includes('FROM paynow_order_dispatches')) {
                return { results: ledgerRows.filter((r) => params.includes(r.order_id)) };
              }
              return { results: [] };
            },
            // rate-limiter shape (shared getD1) so route-level tests work.
            first: async () => null,
            run: async () => ({ meta: { changes: 1 } }),
          }),
          first: async () => null,
          run: async () => ({ meta: { changes: 1 } }),
        };
      },
    };
  }
  return {
    queryMock: vi.fn(),
    getPaynowCustomerIdMock: vi.fn(),
    listCustomerOrdersMock: vi.fn(),
    fakeD1: makeFakeD1(),
  };
});

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    query: queryMock,
    getPaynowCustomerId: getPaynowCustomerIdMock,
    getD1: () => fakeD1,
  };
});

vi.mock('../paynow/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../paynow/client.js')>();
  return { ...actual, listCustomerOrders: listCustomerOrdersMock };
});

import { __resetEnvForTests, initEnvFromBindings } from '../env.js';
import {
  __resetPaynowHistoryMemoForTests,
  getPaynowOrdersForUuid,
} from '../paynow/history.js';

const UUID = '11111111-2222-4333-8444-555555555555';
const AUREUS_50 = '588822585022619648'; // constants.ts fixture: 5,600 Aureus

beforeAll(() => {
  __resetEnvForTests();
  initEnvFromBindings({
    JWT_SECRET: 'test-jwt-secret-0123456789abcdef',
    DISCORD_CLIENT_ID: '1',
    DISCORD_CLIENT_SECRET: 'x',
    WEBPANEL_HMAC_SECRET: 'test-hmac-secret',
    PAYNOW_API_KEY: 'pk_test',
    PAYNOW_STORE_ID: '1',
    PAYNOW_WEBHOOK_SECRETS: 'whsec_test',
    BOT_API_TOKEN: 'bot-token-test',
  });
});

beforeEach(() => {
  queryMock.mockReset();
  getPaynowCustomerIdMock.mockReset();
  listCustomerOrdersMock.mockReset();
  fakeD1.__setLedger([]);
  __resetPaynowHistoryMemoForTests();
});

describe('getPaynowOrdersForUuid (bC10 merge helper)', () => {
  it('maps a completed order WITH ledger rows to delivered, using the ledger timestamp as processedAt', async () => {
    getPaynowCustomerIdMock.mockResolvedValue('cus_1');
    listCustomerOrdersMock.mockResolvedValue([
      {
        id: 'ord_1',
        status: 'completed',
        created_at: '2026-09-01T10:00:00Z',
        completed_at: '2026-09-01T10:01:00Z',
        lines: [{ product_id: AUREUS_50, product_name: 'Aureus Pack 50', quantity: 2 }],
      },
    ]);
    fakeD1.__setLedger([{ order_id: 'ord_1', delivered_at: '2026-09-01 10:02:00' }]);

    const orders = await getPaynowOrdersForUuid(UUID, 20);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({
      kind: 'paynow',
      id: 'ord_1',
      status: 'delivered', // ledger-proven in-game delivery
      quantity: 2,
      createdAt: '2026-09-01T10:00:00Z',
    });
    expect(orders[0]!.deliveredAt).toBe('2026-09-01 10:02:00');
  });

  it('a completed order WITHOUT ledger evidence is complete — never a fabricated delivered', async () => {
    getPaynowCustomerIdMock.mockResolvedValue('cus_1');
    listCustomerOrdersMock.mockResolvedValue([
      {
        id: 'ord_2',
        status: 'completed',
        created_at: '2026-08-01T10:00:00Z',
        completed_at: '2026-08-01T10:01:00Z',
        lines: [{ product_id: AUREUS_50, quantity: 1 }],
      },
    ]);
    const orders = await getPaynowOrdersForUuid(UUID, 20);
    expect(orders[0]!.status).toBe('complete'); // paid per PayNow — no delivery claim
    expect(orders[0]!.deliveredAt).toBeNull();
    expect(orders[0]!.processedAt).toBe('2026-08-01T10:01:00Z'); // falls back to completed_at
  });

  it('created → pending; canceled/refunded pass through lowercase (no invented mapping)', async () => {
    getPaynowCustomerIdMock.mockResolvedValue('cus_1');
    listCustomerOrdersMock.mockResolvedValue([
      { id: 'a', status: 'created', created_at: '2026-09-03T00:00:00Z', lines: [] },
      { id: 'b', status: 'refunded', created_at: '2026-09-02T00:00:00Z', lines: [] },
    ]);
    const orders = await getPaynowOrdersForUuid(UUID, 20);
    const byId = Object.fromEntries(orders.map((o) => [o.id, o.status]));
    expect(byId).toEqual({ a: 'pending', b: 'refunded' });
  });

  it('prefers PayNow product_name; falls back to the local catalog label; multi-line orders say so', async () => {
    getPaynowCustomerIdMock.mockResolvedValue('cus_1');
    listCustomerOrdersMock.mockResolvedValue([
      {
        id: 'ord_named',
        status: 'completed',
        created_at: '2026-09-01T00:00:00Z',
        lines: [{ product_id: 'x', product_name: 'Imperial Pack', quantity: 1 }],
      },
      {
        id: 'ord_local',
        status: 'completed',
        created_at: '2026-09-01T00:00:00Z',
        lines: [{ product_id: AUREUS_50, quantity: 1 }], // no product_name — local mapping
      },
      {
        id: 'ord_multi',
        status: 'completed',
        created_at: '2026-09-01T00:00:00Z',
        lines: [
          { product_id: AUREUS_50, quantity: 1 },
          { product_id: 'other', product_name: 'Second thing', quantity: 1 },
        ],
      },
    ]);
    const orders = await getPaynowOrdersForUuid(UUID, 20);
    const byId = Object.fromEntries(orders.map((o) => [o.id, o.sku]));
    expect(byId.ord_named).toBe('Imperial Pack');
    expect(byId.ord_local).toBe('Aureus ×5600');
    expect(byId.ord_multi).toBe('Aureus ×5600 (+1 more)');
  });

  it('degrades quietly: no linked customer → []; Management API failure → []; customer-lookup failure → []', async () => {
    getPaynowCustomerIdMock.mockResolvedValue(null);
    expect(await getPaynowOrdersForUuid(UUID, 20)).toEqual([]);

    __resetPaynowHistoryMemoForTests();
    getPaynowCustomerIdMock.mockResolvedValue('cus_1');
    listCustomerOrdersMock.mockRejectedValue(new Error('504 gateway timeout'));
    expect(await getPaynowOrdersForUuid(UUID, 20)).toEqual([]);

    __resetPaynowHistoryMemoForTests();
    getPaynowCustomerIdMock.mockRejectedValue(new Error('postgres down'));
    expect(await getPaynowOrdersForUuid(UUID, 20)).toEqual([]);
  });
});

describe('GET /api/shop/orders (the surface the frontend proxy calls)', () => {
  function primeWebQueue(createdIso: string): void {
    queryMock.mockImplementation(async () => ({
      rows: [
        {
          id: 7,
          request_id: 'req_web_7',
          sku: 'aureus_small',
          quantity: 1,
          status: 'delivered',
          created_at: new Date(createdIso),
          processed_at: new Date(createdIso),
          payload: { totalPrice: 5000 },
        },
      ],
      rowCount: 1,
    }));
  }

  async function getOrders(): Promise<Response> {
    const { webshopApi } = await import('../api/expansion/webshop.js');
    return webshopApi.request('/shop/orders?uuid=' + UUID + '&limit=20', {
      headers: {
        'x-bot-token': 'bot-token-test',
        'cf-connecting-ip': '198.51.100.30',
      },
    });
  }

  it('merges web_shop and paynow rows newest-first in one list', async () => {
    primeWebQueue('2026-09-02T12:00:00Z'); // web row is NEWER
    getPaynowCustomerIdMock.mockResolvedValue('cus_1');
    listCustomerOrdersMock.mockResolvedValue([
      {
        id: 'ord_old',
        status: 'completed',
        created_at: '2026-09-01T00:00:00Z', // paynow row is OLDER
        completed_at: '2026-09-01T00:05:00Z',
        lines: [{ product_id: AUREUS_50, product_name: 'Aureus 50', quantity: 1 }],
      },
    ]);
    fakeD1.__setLedger([{ order_id: 'ord_old', delivered_at: '2026-09-01 00:06:00' }]);

    const res = await getOrders();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orders: { kind: string; id?: string; createdAt: string }[] };
    expect(body.orders).toHaveLength(2);
    expect(body.orders.map((o) => o.kind)).toEqual(['web_shop', 'paynow']); // newest first
    expect(Date.parse(body.orders[0]!.createdAt)).toBeGreaterThanOrEqual(Date.parse(body.orders[1]!.createdAt));
  });

  it('bC10 regression: a PayNow outage degrades to web rows only — never a 503', async () => {
    primeWebQueue('2026-09-02T12:00:00Z');
    getPaynowCustomerIdMock.mockResolvedValue('cus_1');
    listCustomerOrdersMock.mockRejectedValue(new Error('PayNow down'));

    const res = await getOrders();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orders: { kind: string }[] };
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0]!.kind).toBe('web_shop');
  });

  it('a player with no PayNow linkage sees their web rows untouched', async () => {
    primeWebQueue('2026-09-02T12:00:00Z');
    getPaynowCustomerIdMock.mockResolvedValue(null);

    const res = await getOrders();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orders: { kind: string; sku: string }[] };
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0]).toMatchObject({ kind: 'web_shop', sku: 'aureus_small' });
  });
});
