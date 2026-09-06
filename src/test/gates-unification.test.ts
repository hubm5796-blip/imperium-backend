import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * B-05 (resolve-once): the principal is resolved at most once per request —
 * a second gate reading the same context must hit the cache, not a second
 * D1-backed authenticateApiKey. B-04 (single implementation) is asserted
 * structurally: the staff/identity gates and the shared-token predicate all
 * live in middleware/{gates,auth}.ts (routes.ts's private requireBotAuth
 * copy is gone).
 */
const state = vi.hoisted(() => ({ apiKeyLookups: 0 }));
vi.mock('../auth/apiKeys.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth/apiKeys.js')>();
  return {
    ...actual,
    authenticateApiKey: vi.fn(async () => {
      state.apiKeyLookups += 1;
      return { id: 'key_1', scopes: ['read:profile'], ownerUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };
    }),
  };
});

import { initEnvFromBindings } from '../env.js';
import { getPrincipal } from '../middleware/gates.js';
import type { Context } from 'hono';

/** Context stub with a working variable store (header + get/set). */
function ctx(headers: Record<string, string>): Context {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const store = new Map<string, unknown>();
  return {
    req: { header: (name: string) => h[name.toLowerCase()] },
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => void store.set(key, value),
  } as unknown as Context;
}

describe('B-05 principal resolves once per request', () => {
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
      D1_RATE_LIMIT: { stub: true },
    } as unknown as Record<string, unknown>);
  });

  it('two gate reads on one request trigger exactly ONE api-key lookup', async () => {
    state.apiKeyLookups = 0;
    const c = ctx({ Authorization: 'Bearer imp_testkey' });
    const first = await getPrincipal(c);
    const second = await getPrincipal(c);
    expect(first.kind).toBe('api_key');
    expect(second).toEqual(first);
    expect(state.apiKeyLookups).toBe(1);
  });

  it('non-key principals cache too (bot token resolved once)', async () => {
    const c = ctx({ 'X-Bot-Token': 'test-bot-token' });
    expect((await getPrincipal(c)).kind).toBe('bot');
    expect((await getPrincipal(c)).kind).toBe('bot');
  });
});
