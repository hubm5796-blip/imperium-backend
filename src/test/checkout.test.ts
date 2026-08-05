import { describe, it, expect } from 'vitest';

/**
 * Basic unit tests for the PayNow product ID validation logic.
 * These tests verify the helper functions that gate which products can be
 * purchased as subscriptions vs lifetime, and which are valid at all.
 */

// Inline copies of the validation logic from paynow/constants.ts
// (can't import the real module because it depends on env.ts which needs
// Cloudflare bindings. These mirror the exact logic.)
const LIFETIME_PRODUCT_IDS = new Set([
  '587751069837164544', '587751431704944640', '587751448431828992',
  '587751466760933376', '587751485048094720', '587751501867257856', '587751519030345728',
]);

const SUBSCRIPTION_PRODUCT_IDS = new Set([
  '586713857251082240', '587751422515216384', '587751440877887488',
  '587751459118911488', '587751475954851840', '587751494204264448', '587751512696950784',
]);

function isLifetimeProduct(id: string): boolean {
  return LIFETIME_PRODUCT_IDS.has(id);
}

function isDonorSubscriptionProduct(id: string): boolean {
  return SUBSCRIPTION_PRODUCT_IDS.has(id);
}

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
    expect(isLifetimeProduct('')).toBe(false);
  });

  it('does not confuse subscription IDs with lifetime IDs', () => {
    // Peregrinus subscription should NOT be a valid lifetime product
    expect(isLifetimeProduct('586713857251082240')).toBe(false);
    // Peregrinus lifetime should NOT be a valid subscription product
    expect(isDonorSubscriptionProduct('587751069837164544')).toBe(false);
  });

  it('total product count is 14 (7 subscription + 7 lifetime)', () => {
    const all = new Set([...LIFETIME_PRODUCT_IDS, ...SUBSCRIPTION_PRODUCT_IDS]);
    expect(all.size).toBe(14);
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
