/**
 * B-31 — referral code generation: crypto randomness + RETURNING retry.
 *
 * Codes were drawn from Math.random (the predictable-PRNG class the repo
 * already replaced in generateLinkCode), and the insert loop only retried on
 * THROWN errors — the UNIQUE(code) collision was swallowed by ON CONFLICT DO
 * NOTHING, so the route returned the colliding code as the caller's own:
 * two players "owning" one code, redemptions attributed to the other row.
 *
 * Post-fix contract:
 *   - codes are 6 chars over the unambiguous alphabet, drawn without
 *     Math.random (crypto.randomBytes modulo selection);
 *   - INSERT ... ON CONFLICT DO NOTHING RETURNING code — the response is the
 *     RETURNED row, never a locally generated string;
 *   - zero rows = collision → regenerate and retry (bounded at 10), then 500.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, fakeD1 } = vi.hoisted(() => {
  const fakeD1 = {
    prepare() {
      const runFor = () => ({ run: async () => ({ meta: { changes: 1 } }), first: async () => ({ hits: 1 }) });
      return { bind: () => runFor(), ...runFor() };
    },
  };
  return {
    queryMock: vi.fn(),
    fakeD1,
  };
});

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    getD1: () => fakeD1,
    query: queryMock,
  };
});

import { initEnvFromBindings, __resetEnvForTests } from '../env.js';

const UUID = 'a25a17ce-bca1-4894-92c9-00d7ab5b7875';
const ALPHABET = new Set('ABCDEFGHJKLMNPQRSTUVWXYZ23456789'.split(''));

const state = { existingRows: [] as Array<Record<string, unknown>>, insertReturnsRow: true };

beforeAll(() => {
  __resetEnvForTests();
  initEnvFromBindings({
    JWT_SECRET: 'test-jwt-secret-0123456789abcdef',
    WEBPANEL_HMAC_SECRET: 'test-hmac-secret',
    DISCORD_CLIENT_ID: '1',
    DISCORD_CLIENT_SECRET: 'x',
    BOT_API_TOKEN: 'bot-token-test',
    PAYNOW_API_KEY: 'pk_test',
    PAYNOW_STORE_ID: '1',
    PAYNOW_WEBHOOK_SECRETS: 'whsec_test',
    NODE_ENV: 'test',
  } as unknown as Record<string, string>);
});

beforeEach(() => {
  state.existingRows = [];
  state.insertReturnsRow = true;
  queryMock.mockReset().mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes('SELECT code, is_custom')) return { rows: state.existingRows };
    if (sql.includes('INSERT INTO referral_codes')) {
      return { rows: state.insertReturnsRow ? [{ code: String(params[1]) }] : [] };
    }
    return { rows: [] };
  });
});

async function mine(): Promise<Response> {
  const { api } = await import('../api/routes.js');
  return api.request('/refcode/mine', {
    headers: { 'x-bot-token': 'bot-token-test', 'x-mc-uuid': UUID, 'cf-connecting-ip': '203.0.113.102' },
  });
}

function insertCalls(): Array<{ sql: string; params: unknown[] }> {
  return queryMock.mock.calls
    .filter((call) => String(call[0]).includes('INSERT INTO referral_codes'))
    .map((call) => ({ sql: String(call[0]), params: (call[1] ?? []) as unknown[] }));
}

describe('B-31: refcode generation', () => {
  it('generates a 6-char code over the unambiguous alphabet — from crypto, not Math.random', async () => {
    // Rig Math.random to its max: a Math.random-based generator would
    // deterministically produce '999999' (chars[31] for every position).
    // (The D1 limiter also calls Math.random for cleanup sampling — that call
    // is fine; only the generated code must not follow the rigged value.)
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    const res = await mine();
    randomSpy.mockRestore();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toHaveLength(6);
    expect(body.code).not.toBe('999999');
    for (const ch of body.code!) expect(ALPHABET.has(ch), `char "${ch}"`).toBe(true);
  });

  it('the insert is compare-and-insert: ON CONFLICT DO NOTHING + RETURNING code', async () => {
    await mine();
    const insert = insertCalls()[0]!;
    expect(insert.sql).toContain('ON CONFLICT DO NOTHING');
    expect(insert.sql).toContain('RETURNING code');
  });

  it('a swallowed collision (zero RETURNING rows) regenerates instead of returning the other player\'s code', async () => {
    let calls = 0;
    queryMock.mockImplementation(async (sql: string, params: unknown[]) => {
      if (sql.includes('INSERT INTO referral_codes')) {
        calls++;
        return { rows: calls === 1 ? [] : [{ code: String(params[1]) }] }; // first collides, second lands
      }
      if (sql.includes('SELECT code, is_custom')) return { rows: [] };
      return { rows: [] };
    });
    const res = await mine();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toHaveLength(6);
    // Two distinct codes were tried.
    const tried = insertCalls().map((c) => c.params[1]);
    expect(tried).toHaveLength(2);
    expect(tried[0]).not.toBe(tried[1]);
  });

  it('persistent collisions exhaust at 10 attempts and 500', async () => {
    state.insertReturnsRow = false;
    const res = await mine();
    expect(res.status).toBe(500);
    expect(insertCalls()).toHaveLength(10);
  });

  it('an existing code is returned as-is with no insert', async () => {
    state.existingRows = [{ code: 'MYCODE', is_custom: true, total_redemptions: '7' }];
    const res = await mine();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ code: 'MYCODE', isCustom: true, redemptions: 7 });
    expect(insertCalls()).toHaveLength(0);
  });
});
