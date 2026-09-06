/**
 * B-14 remainder — single-item /store/checkout product allowlist.
 *
 * The cart route validates every line against the PayNow product allowlist
 * (commit a382bf9), but the single-item checkout route kept a presence-only
 * `productId` check and passed the caller's `subscription` flag through
 * verbatim — hidden/test/foreign product ids reached PayNow unvalidated, and
 * a mismatched subscription flag produced paid-but-undelivered orders.
 *
 * These pin the post-fix gate at the route level (same harness shape as
 * guest-checkout.test.ts):
 *   - valid subscription product + subscription:true → 200, dispatched
 *   - valid one-time product + subscription:false    → 200, dispatched
 *   - subscription flag on a one-time product        → 400, never dispatched
 *   - subscription:false on a subscription product   → 400, never dispatched
 *   - unknown/foreign product id                     → 400, never dispatched
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getPaynowCustomerIdMock,
  setPaynowCustomerIdMock,
  findOrCreatePaynowCustomerMock,
  createCheckoutSessionMock,
  fakeD1,
} = vi.hoisted(() => {
  /** Minimal D1 fake so the D1-backed rate limiter works (see paynow-fulfillment.test.ts). */
  const fakeD1 = {
    prepare() {
      const runFor = () => ({ run: async () => ({ meta: { changes: 1 } }), first: async () => null });
      return { bind: () => runFor(), ...runFor() };
    },
  };
  return {
    getPaynowCustomerIdMock: vi.fn(),
    setPaynowCustomerIdMock: vi.fn(),
    findOrCreatePaynowCustomerMock: vi.fn(),
    createCheckoutSessionMock: vi.fn(),
    fakeD1,
  };
});

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    getD1: () => fakeD1,
    getPaynowCustomerId: getPaynowCustomerIdMock,
    setPaynowCustomerId: setPaynowCustomerIdMock,
    upsertCachedSubscription: vi.fn(),
    getCachedSubscription: vi.fn(),
  };
});

vi.mock('../paynow/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../paynow/client.js')>();
  return {
    ...actual,
    findOrCreatePaynowCustomer: findOrCreatePaynowCustomerMock,
    createCheckoutSession: createCheckoutSessionMock,
  };
});

import { __resetEnvForTests, initEnvFromBindings } from '../env.js';

const UUID = 'a25a17ce-bca1-4894-92c9-00d7ab5b7875';
const PEREGRINUS_SUB = '586713857251082240';
const PEREGRINUS_LIFETIME = '587751069837164544';
const AUREUS_50 = '588822585022619648';

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
  getPaynowCustomerIdMock.mockReset().mockResolvedValue('cus_test');
  setPaynowCustomerIdMock.mockReset().mockResolvedValue(undefined);
  findOrCreatePaynowCustomerMock.mockReset().mockResolvedValue('cus_test');
  createCheckoutSessionMock.mockReset().mockResolvedValue({ url: 'https://checkout.paynow.gg/s/test' });
});

async function postCheckout(body: Record<string, unknown>): Promise<Response> {
  const { api } = await import('../api/routes.js');
  return api.request('/store/checkout', {
    method: 'POST',
    headers: {
      'x-bot-token': 'bot-token-test',
      'x-mc-uuid': UUID,
      'content-type': 'application/json',
      'cf-connecting-ip': '203.0.113.90',
    },
    body: JSON.stringify(body),
  });
}

describe('B-14: single-item /store/checkout product allowlist', () => {
  it('a valid subscription product with subscription:true dispatches the checkout session', async () => {
    const res = await postCheckout({ productId: PEREGRINUS_SUB, subscription: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ url: 'https://checkout.paynow.gg/s/test' });
    expect(createCheckoutSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      productId: PEREGRINUS_SUB,
      subscription: true,
    }));
  });

  it('a valid one-time product (lifetime rank) with subscription:false dispatches', async () => {
    const res = await postCheckout({ productId: PEREGRINUS_LIFETIME, subscription: false });
    expect(res.status).toBe(200);
    expect(createCheckoutSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      productId: PEREGRINUS_LIFETIME,
      subscription: false,
    }));
  });

  it('a valid one-time Aureus pack with no subscription flag dispatches', async () => {
    const res = await postCheckout({ productId: AUREUS_50 });
    expect(res.status).toBe(200);
    expect(createCheckoutSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      productId: AUREUS_50,
      subscription: false,
    }));
  });

  it('subscription:true on a one-time product is rejected before PayNow is called', async () => {
    const res = await postCheckout({ productId: AUREUS_50, subscription: true });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toMatch(/not a valid subscription/i);
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it('subscription:false (or absent) on a subscription product is rejected', async () => {
    for (const subscription of [false, undefined]) {
      createCheckoutSessionMock.mockClear();
      const res = await postCheckout({ productId: PEREGRINUS_SUB, subscription });
      expect(res.status, `subscription=${String(subscription)}`).toBe(400);
      expect(((await res.json()) as { error?: string }).error).toMatch(/not a valid one-time purchase/i);
      expect(createCheckoutSessionMock).not.toHaveBeenCalled();
    }
  });

  it('unknown/foreign product ids are rejected on both flag settings', async () => {
    for (const productId of ['not-a-real-product', '999999999999999999', '']) {
      for (const subscription of [true, false]) {
        createCheckoutSessionMock.mockClear();
        const res = await postCheckout({ productId, subscription });
        expect(res.status, `productId="${productId}" subscription=${String(subscription)}`).toBe(400);
        expect(createCheckoutSessionMock).not.toHaveBeenCalled();
      }
    }
  });

  it('a truthy non-boolean subscription value is treated as absent, not as a subscription', async () => {
    // "yes" must NOT reach PayNow as subscription:true on a subscription product.
    const res = await postCheckout({ productId: PEREGRINUS_SUB, subscription: 'yes' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toMatch(/not a valid one-time purchase/i);
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });
});
