/**
 * B-30 — referral eligibility + one-referral-per-referred-player.
 *
 * The route's comment promised "Check if the referred player already has a
 * rank higher than I (rank V …)" since it was written; the code went
 * straight to INSERT — referring an established player was pure reward
 * farming (the plugin's ReferralCompletionListener pays at rank_level 5,
 * and a player already past rank V never fires that event again). The
 * already-referred guard was also SELECT-then-INSERT with only
 * UNIQUE(referrer, referred) behind it — two referrers racing to refer the
 * SAME player both inserted.
 *
 * Post-fix contract:
 *   - eligibility read from the plugin's actual rule (rank_level >= 5 → 409):
 *     game MySQL live, Postgres mirror fallback, BOTH down → 503 refuse
 *     (never guess a player past the gate).
 *   - guarded creation: INSERT ... ON CONFLICT DO NOTHING RETURNING id;
 *     zero rows → 409 (the partial UNIQUE(referred_uuid) index makes the
 *     race structurally impossible server-side).
 *   - referred username resolves REGISTRY-ONLY ({external:false}) — a
 *     referred player must have joined (B-28's mode).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, getUuidByUsernameMock, getGameRankAndPrestigeMock, fakeD1 } = vi.hoisted(() => {
  const fakeD1 = {
    prepare() {
      const runFor = () => ({ run: async () => ({ meta: { changes: 1 } }), first: async () => ({ hits: 1 }) });
      return { bind: () => runFor(), ...runFor() };
    },
  };
  return {
    queryMock: vi.fn(),
    getUuidByUsernameMock: vi.fn(),
    getGameRankAndPrestigeMock: vi.fn(),
    fakeD1,
  };
});

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    getD1: () => fakeD1,
    query: queryMock,
    getUuidByUsername: getUuidByUsernameMock,
  };
});

vi.mock('../db/gameMysql.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/gameMysql.js')>();
  return {
    ...actual,
    getGamePlayerRankAndPrestige: getGameRankAndPrestigeMock,
  };
});

import { initEnvFromBindings, __resetEnvForTests } from '../env.js';

const REFERRER = '11111111-2222-4333-8444-555555555555';
const REFERRED = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

interface RouteState {
  pgRankRows: Array<Record<string, string>>;
  existingReferralRows: Array<Record<string, string>>;
  insertReturnsRow: boolean;
}
const state: RouteState = { pgRankRows: [], existingReferralRows: [], insertReturnsRow: true };

beforeAll(() => {
  __resetEnvForTests();
  initEnvFromBindings({
    JWT_SECRET: 'test-jwt-secret-0123456789abcdef0123456789abcdef',
    WEBPANEL_HMAC_SECRET: 'test-hmac-secret-0123456789abcdef0123456789abcdef',
    DISCORD_CLIENT_ID: 'test-client-id',
    DISCORD_CLIENT_SECRET: 'test-client-secret',
    BOT_API_TOKEN: 'bot-token-test',
    PAYNOW_API_KEY: 'test-paynow-key',
    PAYNOW_STORE_ID: 'test-store',
    PAYNOW_WEBHOOK_SECRETS: 'test-webhook-secret',
    NODE_ENV: 'test',
  } as unknown as Record<string, unknown>);
});

beforeEach(() => {
  state.pgRankRows = [];
  state.existingReferralRows = [];
  state.insertReturnsRow = true;
  getUuidByUsernameMock.mockReset().mockResolvedValue(REFERRED);
  getGameRankAndPrestigeMock.mockReset().mockResolvedValue({ rank_level: 3, prestige_level: 0 });
  queryMock.mockReset().mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT rank_level FROM player_ranks')) return { rows: state.pgRankRows };
    if (sql.includes('SELECT referrer_uuid FROM referrals')) return { rows: state.existingReferralRows };
    if (sql.includes('INSERT INTO referrals')) {
      return { rows: state.insertReturnsRow ? [{ id: '1' }] : [] };
    }
    return { rows: [] };
  });
});

async function createReferral(username = 'Newbie'): Promise<Response> {
  const { api } = await import('../api/routes.js');
  return api.request('/referrals/create', {
    method: 'POST',
    headers: {
      'x-bot-token': 'bot-token-test',
      'x-mc-uuid': REFERRER,
      'content-type': 'application/json',
      'cf-connecting-ip': '203.0.113.101',
    },
    body: JSON.stringify({ referredUsername: username }),
  });
}

describe('B-30: referral eligibility', () => {
  it('a rank-3 player is eligible: referral created with the guarded insert', async () => {
    const res = await createReferral('Newbie');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    const insert = queryMock.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO referrals'));
    expect(String(insert?.[0])).toContain('ON CONFLICT DO NOTHING');
    expect(String(insert?.[0])).toContain('RETURNING id');
  });

  it('the referred username resolves REGISTRY-ONLY (external:false)', async () => {
    await createReferral('Newbie');
    expect(getUuidByUsernameMock).toHaveBeenCalledWith('Newbie', { external: false });
  });

  it('a player already at rank V (game MySQL) is refused with 409 — no INSERT', async () => {
    getGameRankAndPrestigeMock.mockResolvedValue({ rank_level: 5, prestige_level: 2 });
    const res = await createReferral('Veteran');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error?: string }).error).toMatch(/already at or above Rank V/);
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO referrals'))).toBe(false);
  });

  it('the same rule applies via the Postgres fallback when game MySQL is down', async () => {
    getGameRankAndPrestigeMock.mockRejectedValue(new Error('game db down'));
    state.pgRankRows = [{ rank_level: '7' }];
    const res = await createReferral('Veteran');
    expect(res.status).toBe(409);
  });

  it('BOTH rank sources down → 503 refuse (never guess a player past the gate)', async () => {
    getGameRankAndPrestigeMock.mockRejectedValue(new Error('game db down'));
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT rank_level FROM player_ranks')) throw new Error('pg down');
      if (sql.includes('INSERT INTO referrals')) return { rows: [{ id: '1' }] };
      return { rows: [] };
    });
    const res = await createReferral('Someone');
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error?: string }).error).toMatch(/Cannot verify/);
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO referrals'))).toBe(false);
  });

  it('the race guard: a conflicted insert (zero RETURNING rows) answers 409, never a second referral', async () => {
    state.insertReturnsRow = false;
    state.existingReferralRows = []; // pre-check passes — the conflict IS the race
    const res = await createReferral('Contested');
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error?: string }).error).toMatch(/already been referred/);
  });

  it('self-referral and malformed usernames are rejected before any lookup', async () => {
    getUuidByUsernameMock.mockResolvedValue(REFERRER);
    const self = await createReferral('Myself');
    expect(self.status).toBe(400);
    getUuidByUsernameMock.mockClear();
    const bad = await createReferral('not a name!');
    expect(bad.status).toBe(400);
    expect(getUuidByUsernameMock).not.toHaveBeenCalled();
  });

  it('an unknown username 404s (registry-only — no Mojang probe from this route)', async () => {
    getUuidByUsernameMock.mockResolvedValue(null);
    const res = await createReferral('Ghost');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error?: string }).error).toMatch(/joined the server/);
  });
});
