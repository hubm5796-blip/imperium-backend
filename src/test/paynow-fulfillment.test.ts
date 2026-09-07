/**
 * B-C16/B-C19 — PayNow order fulfillment contract tests.
 *
 * Layer 1 (pure): event-name normalization across PayNow's three spellings,
 * OrderDTO parsing (incl. gift lines + quantity clamping), product→dispatch
 * mapping, and the exact Redis-bus payload shapes the plugin's
 * WebPanelCommandHandler expects (player_uuid / amount / pack_name / tier /
 * subscription / crate_id / order_id / transaction_id).
 *
 * Layer 2 (orchestrator, mocked DB/Redis/PayNow): happy path dispatches,
 * webhook-retry idempotency (no double dispatch), failure → error (webhook
 * 500s so PayNow retries), gift routing to the recipient, and the signed
 * webhook route end-to-end.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/* ── module mocks ─────────────────────────────────────────────────────────── */

// vi.hoisted: the mock factories below run before this file's top-level
// consts initialize, so every reference inside them must come from here.
const {
  sendCommandWithResponseMock,
  getUuidByPaynowCustomerIdMock,
  setPaynowCustomerIdMock,
  getPaynowCustomerMock,
  upsertCachedSubscriptionMock,
  getCachedSubscriptionMock,
  fakeD1,
} = vi.hoisted(() => {
  /** Minimal D1 fake: tracks (order_id, line_key) claims, reports changes, honors DELETE. */
  function makeFakeD1() {
    const claimed = new Set<string>();
    return {
      __claimed: claimed,
      prepare(sql: string) {
        const runFor = (params: unknown[]) => ({
          run: async () => {
            if (sql.includes('INSERT INTO paynow_order_dispatches')) {
              const key = `${params[0]}|${params[1]}`;
              if (claimed.has(key)) return { meta: { changes: 0 } };
              claimed.add(key);
              return { meta: { changes: 1 } };
            }
            if (sql.includes('DELETE FROM paynow_order_dispatches')) {
              claimed.delete(`${params[0]}|${params[1]}`);
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 1 } };
          },
          // first() so the D1-backed rate limiter (shared getD1) works in the
          // route-level tests instead of failing open with a TypeError.
          first: async () => null,
        });
        return {
          bind: (...params: unknown[]) => runFor(params),
          ...runFor([]),
        };
      },
    };
  }
  return {
    sendCommandWithResponseMock: vi.fn(),
    getUuidByPaynowCustomerIdMock: vi.fn(),
    setPaynowCustomerIdMock: vi.fn(),
    getPaynowCustomerMock: vi.fn(),
    upsertCachedSubscriptionMock: vi.fn(),
    getCachedSubscriptionMock: vi.fn(),
    fakeD1: makeFakeD1(),
  };
});

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    getD1: () => fakeD1,
    getUuidByPaynowCustomerId: getUuidByPaynowCustomerIdMock,
    setPaynowCustomerId: setPaynowCustomerIdMock,
    upsertCachedSubscription: upsertCachedSubscriptionMock,
    getCachedSubscription: getCachedSubscriptionMock,
  };
});

vi.mock('../db/redis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/redis.js')>();
  return { ...actual, sendCommandWithResponse: sendCommandWithResponseMock };
});

vi.mock('../paynow/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../paynow/client.js')>();
  return { ...actual, getPaynowCustomer: getPaynowCustomerMock };
});

import { __resetEnvForTests, initEnvFromBindings } from '../env.js';
import {
  buildStoreDispatchCommand,
  normalizePaynowEventType,
  parsePaynowOrder,
  resolveStoreDispatch,
  fulfillPaynowOrder,
} from '../paynow/fulfillment.js';
import { isSubscriptionCacheStale } from '../db/pool.js';

const BUYER = '11111111-2222-4333-8444-555555555555';
const RECIPIENT = '99999999-8888-4777-8666-555555555555';
const AUREUS_50 = '588822585022619648';
const UPGRADE_IMPERATOR = '587789661796048896';
const LIFETIME_PEREGRINUS = '587751069837164544';

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
  sendCommandWithResponseMock.mockReset();
  getUuidByPaynowCustomerIdMock.mockReset();
  setPaynowCustomerIdMock.mockReset();
  getPaynowCustomerMock.mockReset();
  upsertCachedSubscriptionMock.mockReset();
  getCachedSubscriptionMock.mockReset();
  fakeD1.__claimed.clear();
});

/* ── layer 1: pure contracts ──────────────────────────────────────────────── */

describe('normalizePaynowEventType', () => {
  it('accepts all three observed spellings per event', () => {
    expect(normalizePaynowEventType('ON_ORDER_COMPLETED')).toBe('order_completed');
    expect(normalizePaynowEventType('OnOrderCompleted')).toBe('order_completed');
    expect(normalizePaynowEventType('order.completed')).toBe('order_completed');

    expect(normalizePaynowEventType('ON_SUBSCRIPTION_ACTIVATED')).toBe('subscription_activated');
    expect(normalizePaynowEventType('OnSubscriptionActivated')).toBe('subscription_activated');
    expect(normalizePaynowEventType('ON_SUBSCRIPTION_RENEWED')).toBe('subscription_renewed');
    expect(normalizePaynowEventType('ON_SUBSCRIPTION_CANCELED')).toBe('subscription_canceled');
    expect(normalizePaynowEventType('OnSubscriptionCanceled')).toBe('subscription_canceled');
  });

  it('unknown events stay unknown', () => {
    expect(normalizePaynowEventType('ON_REFUND')).toBe('unknown');
    expect(normalizePaynowEventType('')).toBe('unknown');
  });
});

describe('parsePaynowOrder (OrderDTO)', () => {
  const body = {
    id: 'ord_1',
    customer: { id: 'cus_1', minecraft: { id: BUYER, name: 'Buyer' } },
    lines: [
      { id: 'l1', product_id: AUREUS_50, quantity: 2 },
      { id: 'l2', product_id: LIFETIME_PEREGRINUS, quantity: 1, gift_to_customer: { id: 'cus_2' } },
      { id: 'l3', product_id: 'unknown-product', quantity: 999 },
    ],
  };

  it('extracts order/customer/lines including gift recipients', () => {
    const order = parsePaynowOrder(body)!;
    expect(order.orderId).toBe('ord_1');
    expect(order.customerId).toBe('cus_1');
    expect(order.customerMinecraftUuid).toBe(BUYER);
    expect(order.lines).toHaveLength(3);
    expect(order.lines[0]).toEqual({ productId: AUREUS_50, quantity: 2, giftCustomerId: null });
    expect(order.lines[1]!.giftCustomerId).toBe('cus_2');
  });

  it('clamps quantity into 1..99 and defaults missing to 1', () => {
    const order = parsePaynowOrder(body)!;
    expect(order.lines[2]!.quantity).toBe(99);
    expect(parsePaynowOrder({ id: 'o', customer_id: 'c', lines: [{ product_id: 'p' }] })!.lines[0]!.quantity).toBe(1);
  });

  it('returns null without an order id or customer', () => {
    expect(parsePaynowOrder({ customer: { id: 'cus_1' } })).toBeNull();
    expect(parsePaynowOrder({ id: 'ord_1' })).toBeNull();
  });
});

describe('resolveStoreDispatch + buildStoreDispatchCommand', () => {
  it('an Aureus pack maps to STORE_PURCHASE_AUREUS with the pack total as amount', () => {
    const resolved = resolveStoreDispatch(AUREUS_50)!;
    expect(resolved).toEqual({ kind: 'aureus', amount: 5600, packName: 'aureus_5600' });
    expect(buildStoreDispatchCommand(resolved, BUYER, 'ord_9')).toEqual({
      type: 'STORE_PURCHASE_AUREUS',
      payload: { player_uuid: BUYER, amount: 5600, pack_name: 'aureus_5600', order_id: 'ord_9', transaction_id: 'ord_9' },
    });
  });

  it('a rank upgrade maps to STORE_PURCHASE_RANK with the upgrade target tier', () => {
    const resolved = resolveStoreDispatch(UPGRADE_IMPERATOR)!;
    expect(resolved).toEqual({ kind: 'rank', tier: 'IMPERATOR' });
    expect(buildStoreDispatchCommand(resolved, BUYER, 'ord_9')).toEqual({
      type: 'STORE_PURCHASE_RANK',
      payload: { player_uuid: BUYER, tier: 'IMPERATOR', subscription: 'PERMANENT', order_id: 'ord_9', transaction_id: 'ord_9' },
    });
  });

  it('a lifetime donor rank maps to STORE_PURCHASE_RANK with the tier name', () => {
    const resolved = resolveStoreDispatch(LIFETIME_PEREGRINUS)!;
    expect(resolved).toEqual({ kind: 'rank', tier: 'PEREGRINUS' });
  });

  it('a crate-key bundle maps to STORE_PURCHASE_CRATE_KEY with crate_id and quantity', () => {
    // No PayNow crate-key products exist yet; prove the branch works when one is added.
    const resolved = { kind: 'crate_key', crateId: 'vote', keyAmount: 5 } as const;
    expect(buildStoreDispatchCommand(resolved, BUYER, 'ord_9')).toEqual({
      type: 'STORE_PURCHASE_CRATE_KEY',
      payload: { player_uuid: BUYER, crate_id: 'vote', quantity: 5, order_id: 'ord_9', transaction_id: 'ord_9' },
    });
  });

  it('unknown products resolve to null', () => {
    expect(resolveStoreDispatch('not-a-product')).toBeNull();
    expect(resolveStoreDispatch('586713857251082240')).toBeNull(); // subscription id is not a one-time product
  });

  /* B-C26: line.quantity must multiply stackable goods. A quantity-3 purchase
   * of a 5,600-Aureus pack paid for 16,800 — the old signature dropped the
   * quantity and delivered a single pack's worth. */
  it('B-C26: a quantity multiplier scales the Aureus amount (3x pack → 3x amount)', () => {
    const resolved = resolveStoreDispatch(AUREUS_50)!;
    expect(buildStoreDispatchCommand(resolved, BUYER, 'ord_9', 3)).toEqual({
      type: 'STORE_PURCHASE_AUREUS',
      payload: { player_uuid: BUYER, amount: 16800, pack_name: 'aureus_5600', order_id: 'ord_9', transaction_id: 'ord_9' },
    });
  });

  it('B-C26: a quantity multiplier scales the crate-key count (4x bundle of 5 → 20 keys)', () => {
    const resolved = { kind: 'crate_key', crateId: 'vote', keyAmount: 5 } as const;
    expect(buildStoreDispatchCommand(resolved, BUYER, 'ord_9', 4)).toEqual({
      type: 'STORE_PURCHASE_CRATE_KEY',
      payload: { player_uuid: BUYER, crate_id: 'vote', quantity: 20, order_id: 'ord_9', transaction_id: 'ord_9' },
    });
  });

  it('B-C26: rank grants stay single regardless of quantity (a rank is not stackable)', () => {
    const resolved = resolveStoreDispatch(UPGRADE_IMPERATOR)!;
    expect(buildStoreDispatchCommand(resolved, BUYER, 'ord_9', 3)).toEqual({
      type: 'STORE_PURCHASE_RANK',
      payload: { player_uuid: BUYER, tier: 'IMPERATOR', subscription: 'PERMANENT', order_id: 'ord_9', transaction_id: 'ord_9' },
    });
  });

  it('B-C26: omitted quantity defaults to a single unit (back-compat for direct callers)', () => {
    const resolved = resolveStoreDispatch(AUREUS_50)!;
    expect(buildStoreDispatchCommand(resolved, BUYER, 'ord_9')).toEqual({
      type: 'STORE_PURCHASE_AUREUS',
      payload: { player_uuid: BUYER, amount: 5600, pack_name: 'aureus_5600', order_id: 'ord_9', transaction_id: 'ord_9' },
    });
  });
});

/* ── layer 2: orchestrator ────────────────────────────────────────────────── */

function okResponse() {
  return { ok: true, status: 'OK', request_id: 'req_test' };
}

function aureusOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ord_test',
    customer: { id: 'cus_buyer', minecraft: { id: BUYER } },
    lines: [{ id: 'l1', product_id: AUREUS_50, quantity: 1 }],
    ...overrides,
  };
}

describe('fulfillPaynowOrder', () => {
  it('dispatches a signed STORE_PURCHASE_AUREUS for an Aureus pack order', async () => {
    sendCommandWithResponseMock.mockResolvedValue(okResponse());
    const result = await fulfillPaynowOrder(aureusOrder());
    expect(result.status).toBe('ok');
    expect(result.dispatched).toBe(1);
    expect(sendCommandWithResponseMock).toHaveBeenCalledTimes(1);
    const [type, payload, timeout] = sendCommandWithResponseMock.mock.calls[0]!;
    expect(type).toBe('STORE_PURCHASE_AUREUS');
    expect(payload).toMatchObject({ player_uuid: BUYER, amount: 5600, order_id: 'ord_test', transaction_id: 'ord_test' });
    expect(timeout).toBeLessThanOrEqual(10_000); // bounded — never hangs the webhook
  });

  it('is idempotent across webhook retries — the second delivery does not re-dispatch', async () => {
    sendCommandWithResponseMock.mockResolvedValue(okResponse());
    await fulfillPaynowOrder(aureusOrder());
    const second = await fulfillPaynowOrder(aureusOrder());
    expect(second.status).toBe('ok');
    expect(second.dispatched).toBe(0);
    expect(second.skippedDuplicate).toBe(1);
    expect(sendCommandWithResponseMock).toHaveBeenCalledTimes(1);
  });

  it('a dispatch failure marks the order as error (webhook must 500 so PayNow retries)', async () => {
    sendCommandWithResponseMock.mockRejectedValue(new Error('Timed out waiting for response'));
    const result = await fulfillPaynowOrder(aureusOrder());
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/STORE_PURCHASE_AUREUS dispatch failed/);
  });

  it('a plugin-side ERROR response also marks the order as error', async () => {
    sendCommandWithResponseMock.mockResolvedValue({ ok: false, status: 'ERROR', error: 'Deposit failed' });
    const result = await fulfillPaynowOrder(aureusOrder());
    expect(result.status).toBe('error');
  });

  it('an unresolvable buyer (cache AND Management API miss) is an error, not a silent drop', async () => {
    getUuidByPaynowCustomerIdMock.mockResolvedValue(null);
    getPaynowCustomerMock.mockResolvedValue({ id: 'cus_buyer', minecraft_uuid: null });
    const result = await fulfillPaynowOrder({
      id: 'ord_test',
      customer: { id: 'cus_buyer' }, // no embedded minecraft identity
      lines: [{ product_id: AUREUS_50, quantity: 1 }],
    });
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/unresolvable customer/);
    expect(sendCommandWithResponseMock).not.toHaveBeenCalled();
  });

  it('the Management API fallback resolves and caches a missed customer (B-C23)', async () => {
    getUuidByPaynowCustomerIdMock.mockResolvedValue(null);
    getPaynowCustomerMock.mockResolvedValue({ id: 'cus_buyer', minecraft_uuid: BUYER });
    sendCommandWithResponseMock.mockResolvedValue(okResponse());
    const result = await fulfillPaynowOrder({
      id: 'ord_test',
      customer: { id: 'cus_buyer' },
      lines: [{ product_id: AUREUS_50, quantity: 1 }],
    });
    expect(result.status).toBe('ok');
    expect(setPaynowCustomerIdMock).toHaveBeenCalledWith(BUYER, 'cus_buyer');
    expect(sendCommandWithResponseMock).toHaveBeenCalledWith(
      'STORE_PURCHASE_AUREUS',
      expect.objectContaining({ player_uuid: BUYER }),
      expect.any(Number),
    );
  });

  it('B-C26: a 3x Aureus-pack order dispatches the MULTIPLIED amount, not one pack (defrauds multi-pack buyers)', async () => {
    sendCommandWithResponseMock.mockResolvedValue(okResponse());
    const result = await fulfillPaynowOrder(aureusOrder({
      lines: [{ id: 'l1', product_id: AUREUS_50, quantity: 3 }],
    }));
    expect(result.status).toBe('ok');
    expect(result.dispatched).toBe(1);
    const [type, payload] = sendCommandWithResponseMock.mock.calls[0]!;
    expect(type).toBe('STORE_PURCHASE_AUREUS');
    // $150 paid for 3x 5,600 → the payload must carry 16,800. Pre-fix this was 5,600.
    expect(payload).toMatchObject({ player_uuid: BUYER, amount: 16800, order_id: 'ord_test' });
  });

  it('gift lines deliver to the recipient, not the buyer', async () => {
    getUuidByPaynowCustomerIdMock.mockImplementation(async (customerId: string) =>
      customerId === 'cus_recipient' ? RECIPIENT : BUYER);
    sendCommandWithResponseMock.mockResolvedValue(okResponse());
    const result = await fulfillPaynowOrder(aureusOrder({
      lines: [{ id: 'l1', product_id: LIFETIME_PEREGRINUS, quantity: 1, gift_to_customer: { id: 'cus_recipient' } }],
    }));
    expect(result.status).toBe('ok');
    expect(sendCommandWithResponseMock).toHaveBeenCalledWith(
      'STORE_PURCHASE_RANK',
      expect.objectContaining({ player_uuid: RECIPIENT, tier: 'PEREGRINUS', subscription: 'PERMANENT' }),
      expect.any(Number),
    );
  });

  it('unknown product lines are skipped without failing the whole order', async () => {
    sendCommandWithResponseMock.mockResolvedValue(okResponse());
    const result = await fulfillPaynowOrder(aureusOrder({
      lines: [
        { product_id: AUREUS_50, quantity: 1 },
        { product_id: 'totally-unknown', quantity: 1 },
      ],
    }));
    expect(result.status).toBe('ok');
    expect(result.dispatched).toBe(1);
    expect(result.skippedUnknownProduct).toBe(1);
  });

  /* B-57: the claim key was productId:quantity:targetUuid with no line index,
   * so two identical cart lines collided — the second claim saw changes=0,
   * reported skippedDuplicate, and the paid line was NEVER dispatched. Both
   * halves must hold: each identical line claims its own key AND carries a
   * distinct transaction_id (the plugin's PurchaseRegistry dedupes on
   * transaction_id alone and would swallow the second line otherwise). */
  it('B-57: an order with TWO IDENTICAL lines dispatches BOTH, with the quantity each paid for', async () => {
    sendCommandWithResponseMock.mockResolvedValue(okResponse());
    const result = await fulfillPaynowOrder(aureusOrder({
      lines: [
        { id: 'l1', product_id: AUREUS_50, quantity: 2 },
        { id: 'l2', product_id: AUREUS_50, quantity: 2 },
      ],
    }));
    expect(result.status).toBe('ok');
    expect(result.dispatched).toBe(2);
    expect(result.skippedDuplicate).toBe(0);
    expect(sendCommandWithResponseMock).toHaveBeenCalledTimes(2);

    const first = sendCommandWithResponseMock.mock.calls[0]!;
    const second = sendCommandWithResponseMock.mock.calls[1]!;
    expect(first[1]).toMatchObject({ amount: 11200, transaction_id: 'ord_test' });          // 2x 5,600
    expect(second[1]).toMatchObject({ amount: 11200, transaction_id: 'ord_test:L1' });      // distinct tx id
    expect(second[1]!.order_id).toBe('ord_test');
  });

  it('B-57: line 0 keeps the bare order id as transaction_id (registry-compat with already-dispatched single-line orders)', async () => {
    sendCommandWithResponseMock.mockResolvedValue(okResponse());
    await fulfillPaynowOrder(aureusOrder({
      lines: [
        { product_id: AUREUS_50, quantity: 1 },
        { product_id: LIFETIME_PEREGRINUS, quantity: 1 },
        { product_id: AUREUS_50, quantity: 1 },
      ],
    }));
    const txIds = sendCommandWithResponseMock.mock.calls.map(([, payload]) => (payload as { transaction_id: string }).transaction_id);
    expect(txIds).toEqual(['ord_test', 'ord_test:L1', 'ord_test:L2']);
  });

  it('B-57: a RETRY of a duplicate-line order does not re-dispatch either line', async () => {
    sendCommandWithResponseMock.mockResolvedValue(okResponse());
    const body = aureusOrder({
      lines: [
        { product_id: AUREUS_50, quantity: 1 },
        { product_id: AUREUS_50, quantity: 1 },
      ],
    });
    await fulfillPaynowOrder(body);
    const retry = await fulfillPaynowOrder(body);
    expect(retry.status).toBe('ok');
    expect(retry.dispatched).toBe(0);
    expect(retry.skippedDuplicate).toBe(2);
    expect(sendCommandWithResponseMock).toHaveBeenCalledTimes(2); // only the first delivery dispatched
  });

  it('B-57: a dispatch failure on one of two identical lines releases ONLY that line\'s claim', async () => {
    // First line delivers, second fails — the retry must re-attempt the failed
    // line only (index-keyed claims make the two lines independent).
    sendCommandWithResponseMock
      .mockResolvedValueOnce(okResponse())
      .mockRejectedValueOnce(new Error('plugin hiccup'));
    const failed = await fulfillPaynowOrder(aureusOrder({
      lines: [
        { product_id: AUREUS_50, quantity: 1 },
        { product_id: AUREUS_50, quantity: 1 },
      ],
    }));
    expect(failed.status).toBe('error');

    sendCommandWithResponseMock.mockResolvedValue(okResponse());
    const retry = await fulfillPaynowOrder(aureusOrder({
      lines: [
        { product_id: AUREUS_50, quantity: 1 },
        { product_id: AUREUS_50, quantity: 1 },
      ],
    }));
    expect(retry.status).toBe('ok');
    expect(retry.dispatched).toBe(1);          // only the failed line re-dispatches
    expect(retry.skippedDuplicate).toBe(1);    // the delivered line stays claimed
  });
});

/* ── layer 3: the signed webhook route end-to-end ─────────────────────────── */

describe('POST /api/webhooks/paynow (order_completed)', () => {
  async function postWebhook(eventType: string, body: Record<string, unknown>): Promise<Response> {
    const { api } = await import('../api/routes.js');
    const rawBody = JSON.stringify({ event_type: eventType, body });
    const timestamp = Date.now();
    const { createHmac } = await import('node:crypto');
    const signature = createHmac('sha256', 'whsec_test').update(`${timestamp}.${rawBody}`).digest('base64');
    return api.request('/webhooks/paynow', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'PayNow-Signature': signature,
        'PayNow-Timestamp': String(timestamp),
        'cf-connecting-ip': '198.51.100.20',
      },
      body: rawBody,
    });
  }

  it('a valid signed ON_ORDER_COMPLETED dispatches delivery and returns 200', async () => {
    sendCommandWithResponseMock.mockResolvedValue(okResponse());
    const res = await postWebhook('ON_ORDER_COMPLETED', aureusOrder());
    expect(res.status).toBe(200);
    expect(sendCommandWithResponseMock).toHaveBeenCalledTimes(1);
    expect(sendCommandWithResponseMock.mock.calls[0]![0]).toBe('STORE_PURCHASE_AUREUS');
  });

  it('a delivery failure returns 500 so PayNow retries; the retry re-dispatches (claim rolled back), then dedupes', async () => {
    // Attempt 1: plugin offline — 500, and the failed line's claim is released
    // so the retry can re-attempt it.
    sendCommandWithResponseMock.mockRejectedValueOnce(new Error('plugin offline'));
    const failed = await postWebhook('ON_ORDER_COMPLETED', aureusOrder());
    expect(failed.status).toBe(500);
    expect(sendCommandWithResponseMock).toHaveBeenCalledTimes(1);

    // Attempt 2: plugin back — dispatches, 200.
    sendCommandWithResponseMock.mockResolvedValue(okResponse());
    const retried = await postWebhook('ON_ORDER_COMPLETED', aureusOrder());
    expect(retried.status).toBe(200);
    expect(sendCommandWithResponseMock).toHaveBeenCalledTimes(2);

    // Attempt 3: duplicate delivery of the same order — no re-dispatch.
    const duplicate = await postWebhook('ON_ORDER_COMPLETED', aureusOrder());
    expect(duplicate.status).toBe(200);
    expect(sendCommandWithResponseMock).toHaveBeenCalledTimes(2);
  });
});

/* ── layer 4: B-09 — cancel-path webhook failures must 500 ────────────────── */

describe('B-09: subscription cancel-path failures are not swallowed', () => {
  async function postSubscriptionWebhook(
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<Response> {
    const { api } = await import('../api/routes.js');
    const rawBody = JSON.stringify({ event_type: eventType, data: payload });
    const timestamp = Date.now();
    const { createHmac } = await import('node:crypto');
    const signature = createHmac('sha256', 'whsec_test').update(`${timestamp}.${rawBody}`).digest('base64');
    return api.request('/webhooks/paynow', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'PayNow-Signature': signature,
        'PayNow-Timestamp': String(timestamp),
        'cf-connecting-ip': '198.51.100.21',
      },
      body: rawBody,
    });
  }

  it('a happy-path cancel writes status=canceled and 200s', async () => {
    getUuidByPaynowCustomerIdMock.mockResolvedValue(BUYER);
    upsertCachedSubscriptionMock.mockResolvedValue(undefined);
    const res = await postSubscriptionWebhook('ON_SUBSCRIPTION_CANCELED', {
      id: 'sub_1', product_id: '586713857251082240', customer_id: 'cus_buyer',
    });
    expect(res.status).toBe(200);
    expect(upsertCachedSubscriptionMock).toHaveBeenCalledWith(BUYER, 'sub_1', '586713857251082240', 'canceled');
  });

  it('a cancel with an unresolvable customer returns 500 (pre-fix: 200, cache stranded active forever)', async () => {
    getUuidByPaynowCustomerIdMock.mockResolvedValue(null);
    getPaynowCustomerMock.mockRejectedValue(new Error('404'));
    const res = await postSubscriptionWebhook('ON_SUBSCRIPTION_CANCELED', {
      id: 'sub_1', product_id: '586713857251082240', customer_id: 'cus_ghost',
    });
    expect(res.status).toBe(500);
  });

  it('a cancel whose cache write throws returns 500 so PayNow retries', async () => {
    getUuidByPaynowCustomerIdMock.mockResolvedValue(BUYER);
    upsertCachedSubscriptionMock.mockRejectedValue(new Error('D1 write failed'));
    const res = await postSubscriptionWebhook('ON_SUBSCRIPTION_CANCELED', {
      id: 'sub_1', product_id: '586713857251082240', customer_id: 'cus_buyer',
    });
    expect(res.status).toBe(500);
  });

  it('activation failures still return 200 (recurring events self-heal — unchanged semantics)', async () => {
    getUuidByPaynowCustomerIdMock.mockResolvedValue(null);
    getPaynowCustomerMock.mockRejectedValue(new Error('404'));
    const res = await postSubscriptionWebhook('ON_SUBSCRIPTION_ACTIVATED', {
      id: 'sub_1', product_id: '586713857251082240', customer_id: 'cus_ghost',
    });
    expect(res.status).toBe(200);
  });
});

/* ── layer 4b: B-C28 — subscription events use the Management-API fallback ── */

describe('B-C28: subscription webhook resolves cache-missed customers via the Management API', () => {
  async function postSubscriptionWebhook(
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<Response> {
    const { api } = await import('../api/routes.js');
    const rawBody = JSON.stringify({ event_type: eventType, data: payload });
    const timestamp = Date.now();
    const { createHmac } = await import('node:crypto');
    const signature = createHmac('sha256', 'whsec_test').update(`${timestamp}.${rawBody}`).digest('base64');
    return api.request('/webhooks/paynow', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'PayNow-Signature': signature,
        'PayNow-Timestamp': String(timestamp),
        'cf-connecting-ip': '198.51.100.23',
      },
      body: rawBody,
    });
  }

  it('a CANCEL for an unknown customer resolves via the Management API, writes canceled, and caches the link', async () => {
    // Pre-fix this path called getUuidByPaynowCustomerId directly: cache miss →
    // 500 forever, PayNow retried into the same wall (the fallback existed but
    // was never wired into the subscription handlers).
    getUuidByPaynowCustomerIdMock.mockResolvedValue(null);
    getPaynowCustomerMock.mockResolvedValue({ id: 'cus_ghost', minecraft_uuid: BUYER });
    upsertCachedSubscriptionMock.mockResolvedValue(undefined);
    const res = await postSubscriptionWebhook('ON_SUBSCRIPTION_CANCELED', {
      id: 'sub_9', product_id: '586713857251082240', customer_id: 'cus_ghost',
    });
    expect(res.status).toBe(200);
    expect(getPaynowCustomerMock).toHaveBeenCalledWith('cus_ghost');
    expect(setPaynowCustomerIdMock).toHaveBeenCalledWith(BUYER, 'cus_ghost');
    expect(upsertCachedSubscriptionMock).toHaveBeenCalledWith(BUYER, 'sub_9', '586713857251082240', 'canceled');
  });

  it('an ACTIVATION for an unknown customer self-heals the same way (cache written, status updated)', async () => {
    getUuidByPaynowCustomerIdMock.mockResolvedValue(null);
    getPaynowCustomerMock.mockResolvedValue({ id: 'cus_ghost', minecraft_uuid: BUYER });
    upsertCachedSubscriptionMock.mockResolvedValue(undefined);
    const res = await postSubscriptionWebhook('ON_SUBSCRIPTION_ACTIVATED', {
      id: 'sub_10', product_id: '586713857251082240', customer_id: 'cus_ghost',
    });
    expect(res.status).toBe(200);
    expect(setPaynowCustomerIdMock).toHaveBeenCalledWith(BUYER, 'cus_ghost');
    expect(upsertCachedSubscriptionMock).toHaveBeenCalledWith(BUYER, 'sub_10', '586713857251082240', 'active');
  });

  it('a cancel that misses EVERYWHERE (cache + Management API) still 500s so PayNow retries (B-09 semantics kept)', async () => {
    getUuidByPaynowCustomerIdMock.mockResolvedValue(null);
    getPaynowCustomerMock.mockRejectedValue(new Error('404'));
    const res = await postSubscriptionWebhook('ON_SUBSCRIPTION_CANCELED', {
      id: 'sub_11', product_id: '586713857251082240', customer_id: 'cus_vapor',
    });
    expect(res.status).toBe(500);
  });
});

/* ── layer 5: B-09 — stale subscription cache rows fall through to live ───── */

describe('B-09: isSubscriptionCacheStale + GET /store/subscription staleness', () => {
  const NOW = Date.parse('2026-09-05T12:00:00Z');

  it('fresh rows are trusted, old/missing/garbage rows are stale', () => {
    expect(isSubscriptionCacheStale('2026-09-01 10:00:00', NOW)).toBe(false);      // 4 days
    expect(isSubscriptionCacheStale('2026-07-01 10:00:00', NOW)).toBe(true);       // ~66 days
    expect(isSubscriptionCacheStale(null, NOW)).toBe(true);
    expect(isSubscriptionCacheStale('not-a-date', NOW)).toBe(true);
  });

  function d1DateString(msAgo: number): string {
    const d = new Date(NOW - msAgo);
    return d.toISOString().slice(0, 19).replace('T', ' ');
  }

  async function getSubscription(): Promise<Response> {
    const { api } = await import('../api/routes.js');
    return api.request('/store/subscription', {
      headers: {
        'x-bot-token': 'bot-token-test',
        'x-mc-uuid': BUYER,
        'cf-connecting-ip': '198.51.100.22',
      },
    });
  }

  it('a FRESH cached row is served without a PayNow round trip', async () => {
    getCachedSubscriptionMock.mockResolvedValue({
      uuid: BUYER, subscription_id: 'sub_1', product_id: '586713857251082240',
      status: 'active', updated_at: d1DateString(3 * 24 * 3600 * 1000),
    });
    const fetchCalls: unknown[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (...args: unknown[]) => {
      fetchCalls.push(args);
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      const res = await getSubscription();
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ subscriptionId: 'sub_1', status: 'active' });
      expect(fetchCalls).toHaveLength(0); // cache hit — no live call
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('a STALE cached row is not served as fact — the route falls through to live PayNow', async () => {
    getCachedSubscriptionMock.mockResolvedValue({
      uuid: BUYER, subscription_id: 'sub_1', product_id: '586713857251082240',
      status: 'active', updated_at: d1DateString(60 * 24 * 3600 * 1000), // 60 days stale
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('gateway down', { status: 502 })) as typeof fetch;
    try {
      const res = await getSubscription();
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status?: string; subscription?: unknown; available?: boolean };
      // The stale 'active' status must NOT be echoed; live lookup failed →
      // explicit unavailable marker instead of a confident lie.
      expect(body.status).toBeUndefined();
      expect(body).toMatchObject({ subscription: null, available: false });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
