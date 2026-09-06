/**
 * B-C18 — /api/refcode/redeem must enforce ONE redemption per account per
 * LIFETIME. The old duplicate check was `WHERE redeemer_uuid = $1 AND
 * code_used = $2` (one redemption PER CODE), so a single alt could farm every
 * referral code on the server for a reward each — an unbounded economy dupe.
 *
 * Postgres is mocked at the module boundary (db/pool.js `query`); the fake
 * answers the route's actual SQL so the flow runs end-to-end.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn();

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return { ...actual, query: queryMock };
});

import { __resetEnvForTests, initEnvFromBindings } from '../env.js';

const REDEEMER = '11111111-2222-4333-8444-555555555555';
const OWNER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/** Fake `query` results keyed by recognizable SQL fragments. */
function primeQuery(opts: { alreadyRedeemed: boolean }): void {
  queryMock.mockImplementation(async (text: string, _params: unknown[]) => {
    if (text.includes('FROM referral_codes WHERE code =')) {
      return { rows: [{ uuid: OWNER, username: 'Owner' }], rowCount: 1 };
    }
    if (text.includes('FROM referral_redemptions WHERE redeemer_uuid')) {
      return { rows: opts.alreadyRedeemed ? [{ '?column?': 1 }] : [], rowCount: opts.alreadyRedeemed ? 1 : 0 };
    }
    if (text.includes('INSERT INTO referral_redemptions')) {
      return { rows: [{ total_redemptions: 1 }], rowCount: 1 };
    }
    throw new Error(`unexpected query in test: ${text}`);
  });
}

async function redeem(code: string): Promise<Response> {
  const { api } = await import('../api/routes.js');
  return api.request('/refcode/redeem', {
    method: 'POST',
    headers: {
      'x-bot-token': 'bot-token-test',
      'x-mc-uuid': REDEEMER,
      'content-type': 'application/json',
      'cf-connecting-ip': '198.51.100.7',
    },
    body: JSON.stringify({ code }),
  });
}

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
});

describe('POST /api/refcode/redeem (B-C18: one redemption per lifetime)', () => {
  it('a redeemer with ANY prior redemption is rejected — even for a DIFFERENT code', async () => {
    primeQuery({ alreadyRedeemed: true });
    const res = await redeem('OTHERCODE');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('You have already redeemed a referral code.');

    // The duplicate-check SQL must be lifetime-scoped: no `code_used` predicate.
    const alreadyCall = queryMock.mock.calls.find(([t]) =>
      String(t).includes('FROM referral_redemptions WHERE redeemer_uuid'),
    )!;
    expect(String(alreadyCall[0])).not.toMatch(/code_used\s*=/);
    expect(alreadyCall[1]).toEqual([REDEEMER]);
  });

  it('a fresh redeemer succeeds and the reward ledger row is written', async () => {
    primeQuery({ alreadyRedeemed: false });
    const res = await redeem('GOODCODE');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; ownerUuid?: string };
    expect(body.ok).toBe(true);
    expect(body.ownerUuid).toBe(OWNER);

    const insertCall = queryMock.mock.calls.find(([t]) =>
      String(t).includes('INSERT INTO referral_redemptions'),
    )!;
    expect(insertCall).toBeTruthy();
  });

  it('rejects redeeming your own code regardless of the lifetime guard', async () => {
    primeQuery({ alreadyRedeemed: false });
    const { api } = await import('../api/routes.js');
    const res = await api.request('/refcode/redeem', {
      method: 'POST',
      headers: {
        'x-bot-token': 'bot-token-test',
        'x-mc-uuid': OWNER, // the owner themselves
        'content-type': 'application/json',
        'cf-connecting-ip': '198.51.100.8',
      },
      body: JSON.stringify({ code: 'GOODCODE' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/own code/i);
  });
});
