import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { __resetEnvForTests, initEnvFromBindings } from '../env.js';

/**
 * PayNow product validation tests. These import the REAL constants module
 * (src/paynow/constants.ts has no env dependency), replacing an earlier
 * inline-copy suite that could silently drift from the shipped logic.
 *
 * B-C17: the one-time product set must include the 10 Aureus packs and the
 * 6 rank upgrades — before the fix, cart-checkout rejected every currency-pack
 * and rank-upgrade line with HTTP 400.
 */
import {
  AUREUS_PACKS,
  RANK_UPGRADES,
  findAureusPack,
  findRankUpgrade,
  isDonorSubscriptionProduct,
  isLifetimeProduct,
  isOneTimeStoreProduct,
} from '../paynow/constants.js';

const LIFETIME_PRODUCT_IDS = new Set([
  '587751069837164544', '587751431704944640', '587751448431828992',
  '587751466760933376', '587751485048094720', '587751501867257856', '587751519030345728',
]);

const SUBSCRIPTION_PRODUCT_IDS = new Set([
  '586713857251082240', '587751422515216384', '587751440877887488',
  '587751459118911488', '587751475954851840', '587751494204264448', '587751512696950784',
]);

describe('PayNow product validation', () => {
  it('recognizes all 7 lifetime product IDs', () => {
    expect(LIFETIME_PRODUCT_IDS.size).toBe(7);
    for (const id of LIFETIME_PRODUCT_IDS) {
      expect(isLifetimeProduct(id)).toBe(true);
    }
  });

  it('recognizes all 7 subscription product IDs', () => {
    expect(SUBSCRIPTION_PRODUCT_IDS.size).toBe(7);
    for (const id of SUBSCRIPTION_PRODUCT_IDS) {
      expect(isDonorSubscriptionProduct(id)).toBe(true);
    }
  });

  it('rejects invalid product IDs', () => {
    expect(isLifetimeProduct('invalid')).toBe(false);
    expect(isDonorSubscriptionProduct('invalid')).toBe(false);
    expect(isOneTimeStoreProduct('invalid')).toBe(false);
    expect(isOneTimeStoreProduct('')).toBe(false);
  });

  it('does not confuse subscription IDs with lifetime IDs', () => {
    // Peregrinus subscription should NOT be a valid lifetime product
    expect(isLifetimeProduct('586713857251082240')).toBe(false);
    // Peregrinus lifetime should NOT be a valid subscription product
    expect(isDonorSubscriptionProduct('587751069837164544')).toBe(false);
  });
});

describe('B-C17: one-time store product set includes Aureus packs and rank upgrades', () => {
  it('all 10 Aureus pack product IDs validate as one-time products', () => {
    expect(AUREUS_PACKS.length).toBe(10);
    for (const pack of AUREUS_PACKS) {
      expect(isOneTimeStoreProduct(pack.paynowProductId), pack.paynowProductId).toBe(true);
    }
  });

  it('all 6 rank upgrade product IDs validate as one-time products', () => {
    expect(RANK_UPGRADES.length).toBe(6);
    for (const up of RANK_UPGRADES) {
      expect(isOneTimeStoreProduct(up.paynowProductId), up.paynowProductId).toBe(true);
    }
  });

  it('lifetime donor ranks still validate as one-time products', () => {
    for (const id of LIFETIME_PRODUCT_IDS) {
      expect(isOneTimeStoreProduct(id)).toBe(true);
    }
  });

  it('a subscription product does NOT validate as a one-time product', () => {
    for (const id of SUBSCRIPTION_PRODUCT_IDS) {
      expect(isOneTimeStoreProduct(id)).toBe(false);
    }
  });

  it('Aureus packs and rank upgrades are NOT giftable lifetime products (gift gate unchanged)', () => {
    for (const pack of AUREUS_PACKS) {
      expect(isLifetimeProduct(pack.paynowProductId)).toBe(false);
    }
    for (const up of RANK_UPGRADES) {
      expect(isLifetimeProduct(up.paynowProductId)).toBe(false);
    }
  });

  it('metadata lookups resolve packs and upgrades (used by webhook fulfillment)', () => {
    const pack = findAureusPack('588822585022619648');
    expect(pack).toMatchObject({ priceUsd: 50, totalAureus: 5600 });
    expect(findAureusPack('nope')).toBeNull();

    const up = findRankUpgrade('587789661796048896');
    expect(up).toMatchObject({ toTier: 'IMPERATOR' });
    expect(findRankUpgrade('nope')).toBeNull();
  });
});

describe('B-C17: POST /api/store/cart-checkout accepts Aureus pack lines', () => {
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

  async function postCart(items: Array<Record<string, unknown>>): Promise<Response> {
    const { api } = await import('../api/routes.js');
    return api.request('/store/cart-checkout', {
      method: 'POST',
      headers: {
        'x-bot-token': 'bot-token-test',
        'x-mc-uuid': 'a25a17ce-bca1-4894-92c9-00d7ab5b7875',
        'content-type': 'application/json',
        'cf-connecting-ip': '203.0.113.11',
      },
      body: JSON.stringify({ items }),
    });
  }

  // Hermetic: stub the outbound PayNow call so the passing-validation cases end
  // at a deterministic 502 instead of hitting the real api.paynow.gg with a
  // fake key (validation runs BEFORE any customer/checkout resolution).
  const originalFetch = globalThis.fetch;
  beforeAll(() => {
    globalThis.fetch = (async () => new Response('{"message":"stubbed"}', { status: 401 })) as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it('an Aureus pack line passes product validation (fails LATER at customer resolution, not with 400)', async () => {
    // Pre-fix this returned 400 "product is not a valid lifetime purchase".
    // Post-fix the line passes validation; without a DB the route then fails at
    // customer resolution with 500 — proving the validation gate is no longer
    // what rejects it. (mocking the whole PayNow+DB stack would test the mock,
    // not the gate.)
    const res = await postCart([{ productId: '588822585022619648', quantity: 1, subscription: false }]);
    expect(res.status).not.toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).not.toMatch(/not a valid (lifetime|one-time) purchase/);
  });

  it('a rank upgrade line passes product validation too', async () => {
    const res = await postCart([{ productId: '587789607240728576', quantity: 1, subscription: false }]);
    expect(res.status).not.toBe(400);
  });

  it('an unknown product is still rejected with 400', async () => {
    const res = await postCart([{ productId: '000000000000000000', quantity: 1, subscription: false }]);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/not a valid one-time purchase/);
  });

  it('a subscription line with a non-subscription product is still rejected with 400', async () => {
    const res = await postCart([{ productId: '588822585022619648', quantity: 1, subscription: true }]);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/not a valid subscription/);
  });
});

describe('UUID validation (storeAuth)', () => {
  const UUID_REGEX = /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/;
  const BEDROCK_REGEX = /^\.[a-zA-Z0-9_]{3,16}$/;

  it('accepts standard dashed UUIDs', () => {
    expect(UUID_REGEX.test('a25a17ce-bca1-4894-92c9-00d7ab5b7875')).toBe(true);
  });

  it('accepts UUIDs without dashes', () => {
    expect(UUID_REGEX.test('a25a17cebca1489492c900d7ab5b7875')).toBe(true);
  });

  it('rejects malformed UUIDs', () => {
    expect(UUID_REGEX.test('not-a-uuid')).toBe(false);
    expect(UUID_REGEX.test('')).toBe(false);
    expect(UUID_REGEX.test('758038921442492639')).toBe(false); // Discord snowflake
  });

  it('accepts Bedrock prefixed names', () => {
    expect(BEDROCK_REGEX.test('.player')).toBe(true);
    expect(BEDROCK_REGEX.test('.ImperiumMC')).toBe(true);
  });

  it('rejects non-prefixed names for Bedrock check', () => {
    expect(BEDROCK_REGEX.test('player')).toBe(false);
  });
});
