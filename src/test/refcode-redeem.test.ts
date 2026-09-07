/**
 * B-C18/B-58 — /api/refcode/redeem must enforce ONE redemption per account per
 * LIFETIME. The old duplicate check was `WHERE redeemer_uuid = $1 AND
 * code_used = $2` (one redemption PER CODE), so a single alt could farm every
 * referral code on the server for a reward each. B-58 additionally closes the
 * check-then-insert race: the guard is the INSERT itself (`ON CONFLICT
 * (redeemer_uuid) DO NOTHING`), so two concurrent redeems cannot both insert —
 * the database arbitrates, the loser reads inserted=0 and gets the 400, and
 * the owner's total_redemptions only bumps when the insert actually happened.
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

/**
 * Fake `query` results keyed by recognizable SQL fragments. `inserted` simulates
 * the database's ON CONFLICT arbitration: 1 = this call won the insert,
 * 0 = a redemption already exists for the redeemer (duplicate racer or re-hit).
 */
function primeQuery(opts: { inserted: 0 | 1; bumped?: 0 | 1 }): void {
  queryMock.mockImplementation(async (text: string, _params: unknown[]) => {
    if (text.includes('FROM referral_codes WHERE code =')) {
      return { rows: [{ uuid: OWNER, username: 'Owner' }], rowCount: 1 };
    }
    if (text.includes('INSERT INTO referral_redemptions')) {
      return { rows: [{ inserted: opts.inserted, bumped: opts.bumped ?? 1 }] , rowCount: 1 };
    }
    throw new Error(`unexpected query in test: ${text}`);
  });
}

async function redeem(code: string, uuid: string = REDEEMER): Promise<Response> {
  const { api } = await import('../api/routes.js');
  return api.request('/refcode/redeem', {
    method: 'POST',
    headers: {
      'x-bot-token': 'bot-token-test',
      'x-mc-uuid': uuid,
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
  it('the guard is the INSERT: ON CONFLICT (redeemer_uuid) DO NOTHING, lifetime-scoped, with the counter gated on the insert', async () => {
    primeQuery({ inserted: 1 });
    await redeem('GOODCODE');

    const guardCall = queryMock.mock.calls.find(([t]) =>
      String(t).includes('INSERT INTO referral_redemptions'),
    )!;
    expect(guardCall).toBeTruthy();
    const sql = String(guardCall[0]);
    // Lifetime-scoped conflict target — NOT (redeemer_uuid, code_used), which
    // is the per-code loophole the original B-C18 finding described.
    expect(sql).toMatch(/ON CONFLICT \(redeemer_uuid\) DO NOTHING/);
    expect(sql).not.toMatch(/ON CONFLICT \(redeemer_uuid,\s*code_used\)/);
    // B-58: the owner's counter only bumps when the insert actually happened —
    // a losing racer must not inflate total_redemptions.
    expect(sql).toMatch(/WHERE code = \$2 AND EXISTS \(SELECT 1 FROM ins\)/);
    expect(guardCall[1]).toEqual([REDEEMER, 'GOODCODE', OWNER]);
  });

  it('a lost insert race (inserted=0) is rejected — even for a DIFFERENT code', async () => {
    primeQuery({ inserted: 0 });
    const res = await redeem('OTHERCODE');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('You have already redeemed a referral code.');
  });

  it('a fresh redeemer succeeds and the reward ledger row is written', async () => {
    primeQuery({ inserted: 1 });
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

  it('B-58 concurrent redeem: both racers run the statement, the DB arbitrates, exactly one 200s', async () => {
    // Simulate two in-flight redeems of two different codes: the pre-fix
    // SELECT-then-INSERT let both pass the check and both insert. With the
    // insert as the guard, the second racer's ON CONFLICT no-ops → inserted=0
    // → 400, and only the winner's redemption is recorded.
    primeQuery({ inserted: 1 });
    const first = await redeem('CODEAAA');
    expect(first.status).toBe(200);

    primeQuery({ inserted: 0 }); // the database arbitrated against the second racer
    const second = await redeem('CODEBBB');
    expect(second.status).toBe(400);
  });

  it('a redemption whose counter bump misses (owner row gone) still succeeds — the ledger row is the source of truth', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      primeQuery({ inserted: 1, bumped: 0 });
      const res = await redeem('GOODCODE');
      expect(res.status).toBe(200); // redemption recorded; error logged, client must not retry (a retry would hit the duplicate 400)
    } finally {
      errSpy.mockRestore();
    }
  });

  it('rejects redeeming your own code regardless of the lifetime guard', async () => {
    primeQuery({ inserted: 1 });
    const res = await redeem('GOODCODE', OWNER); // the owner themselves
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/own code/i);
    // The guard statement never ran — the own-code check short-circuits first.
    expect(queryMock.mock.calls.some(([t]) => String(t).includes('INSERT INTO referral_redemptions'))).toBe(false);
  });
});
