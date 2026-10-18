/**
 * B-C25 — guest checkout contract tests.
 *
 * The frontend's guest flow (CartDrawer, imperium-frontend f4a310f) sends the
 * bot token plus `guestUsername` in the JSON body and deliberately omits
 * X-Mc-Uuid. storeAuth used to 400 every such request with 'Missing X-Mc-Uuid
 * header' before the handler ever ran — 100% of guest purchases failed.
 *
 * These pin the post-fix gate:
 *   - resolvable Java name (player_names hit)  → checkout session created
 *   - unknown Java name                        → 400 unknown minecraft username
 *   - Bedrock .name never seen on the server   → offline v3 UUID derived the
 *     way the plugin's UuidMigrationService.offlineUuid does (MD5 of
 *     "OfflinePlayer:<name>", dot included; the algorithm is externally
 *     validated — name "Notch" yields b50ad385-829d-3141-a216-7e7d7539ba7f,
 *     the UUID seen in real offline-mode server logs)
 *   - header-less, guest-less bot traffic      → the original 400 unchanged
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getUuidByUsernameMock,
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
    getUuidByUsernameMock: vi.fn(),
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
    getUuidByUsername: getUuidByUsernameMock,
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

const JAVA_UUID = 'a25a17ce-bca1-4894-92c9-00d7ab5b7875';
// Offline v3 UUID of "OfflinePlayer:.Steve" (dot included) — the derivation
// the plugin's UuidMigrationService.offlineUuid performs; computed with the
// JDK-identical MD5/v3 algorithm externally validated on "Notch" →
// b50ad385-829d-3141-a216-7e7d7539ba7f (real offline-server log value).
const BEDROCK_STEVE_OFFLINE_UUID = 'f8a323d0-545e-3523-bec9-18ffec3a3890';
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
  getUuidByUsernameMock.mockReset();
  getPaynowCustomerIdMock.mockReset().mockResolvedValue(null);
  setPaynowCustomerIdMock.mockReset().mockResolvedValue(undefined);
  findOrCreatePaynowCustomerMock.mockReset().mockResolvedValue('cus_guest_new');
  createCheckoutSessionMock.mockReset().mockResolvedValue({ url: 'https://checkout.paynow.gg/s/test' });
});

async function postGuestCart(body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
  const { api } = await import('../api/routes.js');
  return api.request('/store/cart-checkout', {
    method: 'POST',
    headers: {
      'x-bot-token': 'bot-token-test',
      'content-type': 'application/json',
      'cf-connecting-ip': '203.0.113.77',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function guestItems(): Array<Record<string, unknown>> {
  return [{ productId: AUREUS_50, quantity: 2, subscription: false }];
}

describe('B-C25: storeAuth guest checkout via guestUsername', () => {
  it('a resolvable Java username dispatches the checkout session for the resolved UUID (was: 400 Missing X-Mc-Uuid)', async () => {
    getUuidByUsernameMock.mockResolvedValue(JAVA_UUID);
    const res = await postGuestCart({ items: guestItems(), guestUsername: 'Steve' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ url: 'https://checkout.paynow.gg/s/test' });
    expect(getUuidByUsernameMock).toHaveBeenCalledWith('Steve', { strictPlatform: true });
    expect(findOrCreatePaynowCustomerMock).toHaveBeenCalledWith(JAVA_UUID);
    expect(createCheckoutSessionMock).toHaveBeenCalledWith(expect.objectContaining({
      customerId: 'cus_guest_new',
      lines: [expect.objectContaining({ productId: AUREUS_50, quantity: 2 })],
    }));
  });

  it('an unresolvable Java username returns 400 with a clear message (never guesses an identity)', async () => {
    getUuidByUsernameMock.mockResolvedValue(null);
    const res = await postGuestCart({ items: guestItems(), guestUsername: 'NoSuchPlayer' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/unknown minecraft username "NoSuchPlayer"/);
    expect(findOrCreatePaynowCustomerMock).not.toHaveBeenCalled();
    expect(createCheckoutSessionMock).not.toHaveBeenCalled();
  });

  it('a Bedrock .name that has joined resolves via player_names (real Floodgate UUID, no derivation)', async () => {
    const floodgateUuid = '00000000-0000-0000-0009-01f2f3f4f5f6';
    getUuidByUsernameMock.mockResolvedValue(floodgateUuid);
    const res = await postGuestCart({ items: guestItems(), guestUsername: '.Steve' });
    expect(res.status).toBe(200);
    expect(findOrCreatePaynowCustomerMock).toHaveBeenCalledWith(floodgateUuid);
  });

  it('a Bedrock .name never seen derives the plugin-identical offline v3 UUID so the purchase still proceeds', async () => {
    getUuidByUsernameMock.mockResolvedValue(null); // player_names miss — no Mojang path for dot-names
    const res = await postGuestCart({ items: guestItems(), guestUsername: '.Steve' });
    expect(res.status).toBe(200);
    // Byte-identical to UUID.nameUUIDFromBytes("OfflinePlayer:.Steve") — the
    // exact value the plugin's UuidMigrationService.offlineUuid produces.
    expect(findOrCreatePaynowCustomerMock).toHaveBeenCalledWith(BEDROCK_STEVE_OFFLINE_UUID);
    expect(createCheckoutSessionMock).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cus_guest_new' }));
  });

  it('a username-resolution failure degrades to a 400, not a 500', async () => {
    getUuidByUsernameMock.mockRejectedValue(new Error('db down'));
    const res = await postGuestCart({ items: guestItems(), guestUsername: 'Steve' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/unknown minecraft username/);
  });

  it('malformed guest usernames are rejected with the same clear 400', async () => {
    for (const bad of ['!!', 'way~too*weird', 'x'.repeat(17), '.x'.repeat(9)]) {
      const res = await postGuestCart({ items: guestItems(), guestUsername: bad });
      expect(res.status, `username "${bad}"`).toBe(400);
      expect(await res.json()).toMatchObject({ error: expect.stringMatching(/unknown minecraft username/) });
    }
    expect(getUuidByUsernameMock).not.toHaveBeenCalled();
  });

  it('header-less bot traffic WITHOUT a guestUsername keeps the original 400 (no silent identity change)', async () => {
    const res = await postGuestCart({ items: guestItems() });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'Missing X-Mc-Uuid header' });
  });

  it('X-Mc-Uuid still wins when both the header and a guestUsername are present (verified path has priority)', async () => {
    getUuidByUsernameMock.mockResolvedValue(JAVA_UUID);
    const headerUuid = '11111111-2222-4333-8444-555555555555';
    const res = await postGuestCart(
      { items: guestItems(), guestUsername: 'Steve' },
      { 'x-mc-uuid': headerUuid },
    );
    expect(res.status).toBe(200);
    expect(findOrCreatePaynowCustomerMock).toHaveBeenCalledWith(headerUuid);
    expect(getUuidByUsernameMock).not.toHaveBeenCalled();
  });

  it('non-bot, non-session guests are still 401 (the guest path rides the bot token, it is not an open door)', async () => {
    const { api } = await import('../api/routes.js');
    const res = await api.request('/store/cart-checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.78' },
      body: JSON.stringify({ items: guestItems(), guestUsername: 'Steve' }),
    });
    expect(res.status).toBe(401);
  });
});
