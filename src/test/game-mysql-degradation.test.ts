/**
 * B-11 — gameQuery degradation is explicit, not swallowed.
 *
 * gameQuery used to catch EVERY failure and return [] — callers could not
 * tell "valid empty result" from "the game database is down": the leaderboard
 * silently served the Postgres mirror, /store/subscription served null, and
 * the legion helpers' wrong column names (uuid/rank/contribution vs the
 * plugin's player_uuid/role) errored on every call, invisibly.
 *
 * Post-fix contract pinned here:
 *   1. gameQuery THROWS GameMySqlUnavailableError (cause preserved) and logs
 *      with the distinct [game-mysql] tag.
 *   2. The legion helpers query the plugin's real legion_members columns
 *      (player_uuid, role) and return the same LegionInfo/LegionMemberInfo
 *      shape the Postgres fallback produces.
 *   3. An expansion board with a Postgres fallback degrades to that fallback
 *      on outage (entries still served, from the mirror).
 *   4. The subscription cancel route AWAITs its cache write — the response
 *      cannot settle while the write is still in flight (Workers tears down
 *      un-awaited work at response time; the killed write was B-09's exact
 *      stranded-`status:'active'` shape).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ── mysql2 mock: the game pool's execute is swappable per test ───────────────
const state = vi.hoisted(() => ({
  mysqlQueries: [] as Array<{ sql: string; params: unknown[] }>,
  /** Per-test behavior: throw (outage) or return rows. */
  executeImpl: null as null | ((sql: string, params: unknown[]) => Promise<unknown[]>),
  pgQueries: [] as Array<{ sql: string; params: unknown[] }>,
  nextPgRows: [] as Array<Record<string, string>>,
}));

vi.mock('mysql2/promise', () => {
  return {
    default: {
      createPool: () => ({
        async execute(sql: string, params: unknown[]) {
          state.mysqlQueries.push({ sql, params });
          if (state.executeImpl) {
            // mysql2's execute resolves [rows, fields] — keep the tuple shape.
            const rows = await state.executeImpl(sql, params);
            return [rows, []];
          }
          throw new Error('no executeImpl configured');
        },
        async end() {},
      }),
    },
  };
});

vi.mock('pg', () => {
  return {
    Pool: class {
      constructor() {}
      on() {}
      async end() {}
      async connect() {
        return {
          async query(sql: string, params: unknown[]) {
            state.pgQueries.push({ sql, params });
            return { rows: state.nextPgRows, rowCount: state.nextPgRows.length };
          },
          release() {},
        };
      }
    },
  };
});

// ── store-path mocks for the cancel-route test ───────────────────────────────
const {
  getPaynowCustomerIdMock,
  getCachedSubscriptionMock,
  upsertCachedSubscriptionMock,
  getSubscriptionByIdMock,
  cancelSubscriptionMock,
} = vi.hoisted(() => ({
  getPaynowCustomerIdMock: vi.fn(),
  getCachedSubscriptionMock: vi.fn(),
  upsertCachedSubscriptionMock: vi.fn(),
  getSubscriptionByIdMock: vi.fn(),
  cancelSubscriptionMock: vi.fn(),
}));

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    getPaynowCustomerId: getPaynowCustomerIdMock,
    getCachedSubscription: getCachedSubscriptionMock,
    upsertCachedSubscription: upsertCachedSubscriptionMock,
  };
});

vi.mock('../paynow/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../paynow/client.js')>();
  return {
    ...actual,
    getSubscriptionById: getSubscriptionByIdMock,
    cancelSubscription: cancelSubscriptionMock,
  };
});

import { initEnvFromBindings, __resetEnvForTests } from '../env.js';
import { initPool } from '../db/pool.js';
import { gameQuery, GameMySqlUnavailableError, initGamePool, getGamePlayerLegionId, getGameLegionInfo, getGameLegionMembers } from '../db/gameMysql.js';
import { fetchExpansionBoard } from '../api/expansion/leaderboards.js';
import { logger } from '../utils/logger.js';

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
  initPool('postgresql://fake');
  initGamePool({ host: 'gamedb', port: 3306, user: 'u', password: 'p', database: 'd' });
});

beforeEach(() => {
  state.mysqlQueries.length = 0;
  state.pgQueries.length = 0;
  state.nextPgRows = [];
  state.executeImpl = null;
});

describe('B-11 (1): gameQuery throws a typed error instead of swallowing', () => {
  it('an outage rejects with GameMySqlUnavailableError carrying the cause — never []', async () => {
    const transportError = new Error('wire handshake failed');
    state.executeImpl = async () => {
      throw transportError;
    };
    const rejection = gameQuery('SELECT 1 AS one');
    await expect(rejection).rejects.toBeInstanceOf(GameMySqlUnavailableError);
    const err = await rejection.catch((e: unknown) => e);
    expect((err as GameMySqlUnavailableError).cause).toBe(transportError);
    expect((err as GameMySqlUnavailableError).name).toBe('GameMySqlUnavailableError');
  });

  it('the failure is logged under the distinct [game-mysql] tag', async () => {
    state.executeImpl = async () => {
      throw new Error('connection refused');
    };
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      await gameQuery('SELECT COUNT(*) AS n FROM player_names').catch(() => {});
      // Assert BEFORE mockRestore — restore clears the recorded calls.
      const tagged = spy.mock.calls.some(([, msg]) => String(msg).includes('[game-mysql]'));
      expect(tagged).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('a healthy empty result is still a plain [] (empty ≠ outage)', async () => {
    state.executeImpl = async () => [];
    await expect(gameQuery('SELECT * FROM empty_table')).resolves.toEqual([]);
  });
});

describe('B-11 (2): legion helpers reconcile to the plugin schema + one response shape', () => {
  it('getGamePlayerLegionId queries player_uuid, not uuid', async () => {
    state.executeImpl = async () => [{ legion_name: 'IX Legio' }];
    await expect(getGamePlayerLegionId('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).resolves.toBe('IX Legio');
    const sql = state.mysqlQueries[0]!.sql;
    expect(sql).toContain('WHERE player_uuid = ?');
    expect(sql).not.toMatch(/WHERE uuid = \?/);
  });

  it('getGameLegionMembers selects player_uuid/role (never rank/contribution) and maps to the fallback shape', async () => {
    state.executeImpl = async () => [
      { player_uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', role: 'LEGATUS', username: 'Marcus' },
      { player_uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee2', role: 'TIRO', username: null },
    ];
    const members = await getGameLegionMembers('IX Legio');
    const sql = state.mysqlQueries[0]!.sql;
    expect(sql).toContain('m.player_uuid, m.role');
    expect(sql).not.toContain('rank,');
    expect(sql).not.toContain('contribution');
    // Same shape as pool.ts LegionMemberInfo — whichever DB answers /player/legion,
    // the response is identical.
    expect(members).toEqual([
      { uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', username: 'Marcus', role: 'LEGATUS' },
      { uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee2', username: null, role: 'TIRO' },
    ]);
  });

  it('getGameLegionInfo returns the LegionInfo shape (camelCase, numeric), not a raw row', async () => {
    state.executeImpl = async () => [
      { name: 'IX Legio', display_name: null, level: '4', owner_uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', xp: '1250', max_members: '25' },
    ];
    const info = await getGameLegionInfo('IX Legio');
    expect(info).toEqual({
      name: 'IX Legio',
      displayName: null,
      level: 4,
      ownerUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      xp: 1250,
      maxMembers: 25,
    });
  });
});

describe('B-11 (3): expansion board with a Postgres fallback degrades to it on outage', () => {
  it('rank board: game outage → Postgres mirror answers (entries served, not an empty 200)', async () => {
    state.executeImpl = async () => {
      throw new Error('game db down');
    };
    state.nextPgRows = [
      { uuid: 'aaaaaaaa-0000-0000-0000-000000000001', rank_level: '9', rank_name: 'IX', rank_progress: '40', username: 'Alpha' },
      { uuid: 'aaaaaaaa-0000-0000-0000-000000000002', rank_level: '5', rank_name: 'V', rank_progress: '10', username: 'Beta' },
    ];
    const { entries } = await fetchExpansionBoard('rank', 10);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ rank: 1, username: 'Alpha', value: 9 });
    // The Postgres mirror query actually ran.
    expect(state.pgQueries.some((q) => q.sql.includes('FROM player_ranks pr'))).toBe(true);
  });

  it('a healthy game read still wins without touching Postgres', async () => {
    state.executeImpl = async () => [
      { uuid: 'aaaaaaaa-0000-0000-0000-000000000003', rank_level: '7', rank_name: 'VII', rank_progress: '1', username: 'Gamma' },
    ];
    const { entries } = await fetchExpansionBoard('rank', 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ username: 'Gamma' });
    expect(state.pgQueries.length).toBe(0);
  });
});

describe('B-11 (4): the cancel route awaits its cache write', () => {
  const UUID = 'a25a17ce-bca1-4894-92c9-00d7ab5b7875';

  beforeEach(() => {
    getPaynowCustomerIdMock.mockReset().mockResolvedValue('cus_test');
    getCachedSubscriptionMock.mockReset().mockResolvedValue({
      subscription_id: 'sub_123', product_id: '586713857251082240', status: 'active', updated_at: new Date().toISOString(),
    });
    getSubscriptionByIdMock.mockReset().mockResolvedValue({ id: 'sub_123', customer_id: 'cus_test', status: 'active' });
    cancelSubscriptionMock.mockReset().mockResolvedValue(undefined);
  });

  it('the response cannot settle while the canceled-state cache write is in flight', async () => {
    let releaseWrite!: () => void;
    const writeInFlight = new Promise<void>((resolve) => { releaseWrite = resolve; });
    upsertCachedSubscriptionMock.mockReset().mockImplementation(() => writeInFlight);

    const { api } = await import('../api/routes.js');
    const responsePromise: Promise<Response> = Promise.resolve(
      api.request('/store/subscription/cancel', {
        method: 'POST',
        headers: { 'x-bot-token': 'bot-token-test', 'x-mc-uuid': UUID, 'cf-connecting-ip': '203.0.113.99' },
      }),
    );

    // Let the route reach the write. If the write were fire-and-forget
    // (dbWriteBestEffort), the response would settle while writeInFlight is
    // still pending — that torn write was the stranded status:'active' bug.
    await new Promise((r) => setTimeout(r, 30));
    expect(upsertCachedSubscriptionMock).toHaveBeenCalled();
    let settled = false;
    void responsePromise.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);

    releaseWrite();
    const res = await responsePromise;
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: 'canceled' });
    expect(upsertCachedSubscriptionMock).toHaveBeenCalledWith(UUID, 'sub_123', '586713857251082240', 'canceled');
  });

  it('a failed cache write does not fail the cancel (PayNow already canceled — the source of truth stands)', async () => {
    upsertCachedSubscriptionMock.mockReset().mockRejectedValue(new Error('pg down'));
    const { api } = await import('../api/routes.js');
    const res = await api.request('/store/subscription/cancel', {
      method: 'POST',
      headers: { 'x-bot-token': 'bot-token-test', 'x-mc-uuid': UUID, 'cf-connecting-ip': '203.0.113.99' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: 'canceled' });
  });
});
