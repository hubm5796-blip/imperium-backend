import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * V6 02-07 route tests for GET /api/v2/member?discord_id= — the role-sync
 * aggregate. Contracts:
 *   1. Bot-gated: no X-Bot-Token → 401 (a browser must not enumerate links).
 *   2. Donor activity: an expired donor_ranks row reports donor.active=false
 *      (the sync engine then strips the role), permanent rows active=true.
 *   3. 404 for unlinked ids (distinct from 503 backend-down).
 */

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    query: vi.fn(),
  };
});

vi.mock('../db/redis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/redis.js')>();
  return {
    ...actual,
    getCachedJson: vi.fn(async () => null),
    setCachedJson: vi.fn(async () => undefined),
  };
});

import { createApp } from '../app.js';
import { initEnvFromBindings } from '../env.js';
import { query as queryMock } from '../db/pool.js';

const DISCORD_ID = '123456789012345678';
const TEST_UUID = 'a25a17ce-bca1-4894-92c9-00d7ab5b7875';
const BOT_TOKEN = 'test-bot-token';

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  initEnvFromBindings({
    JWT_SECRET: 'unit-test-jwt-secret-0123456789abcdef0123',
    WEBPANEL_HMAC_SECRET: 'unit-test-webpanel-secret-0123456789abcdef',
    DISCORD_CLIENT_ID: 'test-client-id',
    DISCORD_CLIENT_SECRET: 'test-client-secret',
    BOT_API_TOKEN: BOT_TOKEN,
    PAYNOW_API_KEY: 'test-paynow-key',
    PAYNOW_STORE_ID: 'test-store',
    PAYNOW_WEBHOOK_SECRETS: 'test-webhook-secret',
    NODE_ENV: 'test',
  } as never);
  app = createApp();
});

beforeEach(() => {
  vi.clearAllMocks();
});

function stubMemberRow(overrides: Record<string, unknown> = {}) {
  (queryMock as ReturnType<typeof vi.fn>).mockResolvedValue({
    rows: [
      {
        uuid: TEST_UUID,
        discord_id: DISCORD_ID,
        username: 'Maximus',
        rank_level: '7',
        prestige_level: '3',
        donor_tier: 'CONSUL',
        donor_type: 'PERMANENT',
        donor_expires: null,
        ...overrides,
      },
    ],
  });
}

describe('GET /api/v2/member', () => {
  it('rejects callers without the bot token', async () => {
    const res = await app.request(`/api/v2/member?discord_id=${DISCORD_ID}`);
    expect(res.status).toBe(401);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns the role-sync aggregate for a linked member', async () => {
    stubMemberRow();
    const res = await app.request(`/api/v2/member?discord_id=${DISCORD_ID}`, {
      headers: { 'X-Bot-Token': BOT_TOKEN },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.uuid).toBe(TEST_UUID);
    expect(body.username).toBe('Maximus');
    expect(body.rank).toBe(7);
    expect(body.prestigeLevel).toBe(3);
    expect(body.donor).toEqual({
      tier: 'CONSUL',
      type: 'PERMANENT',
      active: true,
      expiresAt: null,
    });
  });

  it('marks an expired subscription inactive so roles get stripped', async () => {
    stubMemberRow({ donor_type: 'MONTHLY', donor_expires: new Date(Date.now() - 86_400_000) });
    const res = await app.request(`/api/v2/member?discord_id=${DISCORD_ID}`, {
      headers: { 'X-Bot-Token': BOT_TOKEN },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { donor: { active: boolean } | null };
    expect(body.donor).not.toBeNull();
    expect(body.donor!.active).toBe(false);
  });

  it('reports donor:null for a member with no donor row', async () => {
    stubMemberRow({ donor_tier: null, donor_type: null, donor_expires: null });
    const res = await app.request(`/api/v2/member?discord_id=${DISCORD_ID}`, {
      headers: { 'X-Bot-Token': BOT_TOKEN },
    });
    const body = (await res.json()) as { donor: unknown };
    expect(body.donor).toBeNull();
  });

  it('404s for an unlinked discord id (distinct from backend-down)', async () => {
    (queryMock as ReturnType<typeof vi.fn>).mockResolvedValue({ rows: [] });
    const res = await app.request(`/api/v2/member?discord_id=${DISCORD_ID}`, {
      headers: { 'X-Bot-Token': BOT_TOKEN },
    });
    expect(res.status).toBe(404);
  });

  it('503s when the registry read fails', async () => {
    (queryMock as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('connection terminated'));
    const res = await app.request(`/api/v2/member?discord_id=${DISCORD_ID}`, {
      headers: { 'X-Bot-Token': BOT_TOKEN },
    });
    expect(res.status).toBe(503);
  });

  it('400s on malformed discord ids', async () => {
    for (const bad of ['', 'abc', '123', 'x'.repeat(30)]) {
      const res = await app.request(`/api/v2/member?discord_id=${encodeURIComponent(bad)}`, {
        headers: { 'X-Bot-Token': BOT_TOKEN },
      });
      expect(res.status).toBe(400);
    }
  });
});
