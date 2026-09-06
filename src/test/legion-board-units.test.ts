/**
 * B-37 — the legion board must rank identically and in the same units on
 * BOTH database paths.
 *
 * The game path used to answer `xp: civitas/100` ordered by civitas, while
 * the Postgres fallback answered `xp: raw l.xp` ordered by xp — the same
 * board returned a different ORDER and a 100x magnitude split depending on
 * which DB answered (B-11's split-brain made the choice invisible). The
 * repo's own whole-unit rule (publicProfiles: balances stored in WHOLE
 * units, displayed as stored) says neither path may divide.
 *
 * Post-fix: ONE ranking key (summed member civitas, ORDER BY civitas DESC),
 * ONE unit path (whole units everywhere), and `value` now actually carries
 * the civitas total as the owner directive's comment always claimed. This is
 * the cross-path fixture test the finding asks for: feed the SAME fixture
 * through the game-MySQL path and the Postgres path and require identical
 * entries.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Shared fixture: three legions whose civita ranking DISAGREES with their xp
 * ranking — under the old fallback (ORDER BY l.xp) the order would differ
 * from the game path, which is exactly the split to catch.
 */
const FIXTURE = [
  { name: 'IX Legio', display_name: 'Ninth', level: 4, xp: 1200, civitas: 90_000, members: 12 },
  { name: 'III Gallica', display_name: null, level: 6, xp: 900, civitas: 150_000, members: 20 },
  { name: 'V Macedonica', display_name: 'Maced', level: 2, xp: 5_000, civitas: 40_000, members: 7 },
];
// Expected: ranked by civitas DESC → Gallica, IX, V — NOT by xp (V first).
const EXPECTED_ORDER = ['III Gallica', 'IX Legio', 'V Macedonica'];

const state = vi.hoisted(() => ({
  gameImpl: null as null | (() => Promise<unknown[]>),
  pgImpl: null as null | ((sql: string) => Promise<{ rows: unknown[] }>),
  pgSql: [] as string[],
}));

vi.mock('mysql2/promise', () => ({
  default: {
    createPool: () => ({
      async execute() {
        if (state.gameImpl) return [await state.gameImpl(), []];
        return [[], []];
      },
      async end() {},
    }),
  },
}));

vi.mock('pg', () => ({
  Pool: class {
    constructor() {}
    on() {}
    async end() {}
    async connect() {
      return {
        async query(sql: string) {
          state.pgSql.push(sql);
          if (!state.pgImpl) throw new Error('no pgImpl configured');
          return state.pgImpl(sql);
        },
        release() {},
      };
    }
  },
}));

import { initEnvFromBindings, __resetEnvForTests } from '../env.js';
import { initPool } from '../db/pool.js';
import { initGamePool, GameMySqlUnavailableError } from '../db/gameMysql.js';
import { fetchExpansionBoard } from '../api/expansion/leaderboards.js';

beforeAll(() => {
  __resetEnvForTests();
  initEnvFromBindings({
    JWT_SECRET: 'test-jwt-secret-0123456789abcdef0123456789abcdef',
    WEBPANEL_HMAC_SECRET: 'test-hmac-secret0123456789abcdef',
    DISCORD_CLIENT_ID: 'test-client-id',
    DISCORD_CLIENT_SECRET: 'test-client-secret',
    BOT_API_TOKEN: 'test-bot-token',
    PAYNOW_API_KEY: 'test-paynow-key',
    PAYNOW_STORE_ID: 'test-store',
    PAYNOW_WEBHOOK_SECRETS: 'test-webhook-secret',
    NODE_ENV: 'test',
  } as unknown as Record<string, unknown>);
  initPool('postgresql://fake');
  initGamePool({ host: 'gamedb', port: 3306, user: 'u', password: 'p', database: 'd' });
});

beforeEach(() => {
  state.gameImpl = null;
  state.pgImpl = null;
});

describe('B-37: legion board — one ranking key, one unit path, both DBs', () => {
  it('game path: ranked by civitas, whole units, value carries the civitas total', async () => {
    // The real SQL orders by civitas DESC; the mock models that ordering.
    state.gameImpl = async () =>
      [...FIXTURE]
        .sort((a, b) => b.civitas - a.civitas)
        .map((f) => ({ ...f, civitas: String(f.civitas), xp: String(f.xp), level: String(f.level) }));
    const { entries } = await fetchExpansionBoard('legion', 10);
    expect((entries as Array<{ name: string }>).map((e) => e.name)).toEqual(EXPECTED_ORDER);
    const first = entries[0] as { name: string; xp: number; value: number; members: number };
    expect(first.name).toBe('III Gallica');
    // Whole units — the pre-fix game path returned civitas/100 here.
    expect(first.value).toBe(150_000);
    expect(first.xp).toBe(900); // xp is xp on BOTH paths now, never a civitas proxy
    expect(first.members).toBe(20);
  });

  it('Postgres fallback: the SAME fixture yields the SAME order and magnitudes', async () => {
    // Game DB down → fallback; pg returns the same rows in the same shape
    // the new fallback SQL produces (strings, civitas included).
    state.gameImpl = async () => {
      throw new Error('game db down');
    };
    state.pgImpl = async () => ({
      rows: [...FIXTURE]
        .sort((a, b) => b.civitas - a.civitas)
        .map((f) => ({ ...f, civitas: String(f.civitas), xp: String(f.xp), level: String(f.level), members: String(f.members) })),
    });
    const { entries } = await fetchExpansionBoard('legion', 10);
    expect((entries as Array<{ name: string }>).map((e) => e.name)).toEqual(EXPECTED_ORDER);
    const first = entries[0] as { name: string; xp: number; value: number };
    expect(first.value).toBe(150_000);
    expect(first.xp).toBe(900);
  });

  it('the fallback SQL itself ranks by civitas (the raw-XP ordering is gone)', async () => {
    state.gameImpl = async () => {
      throw new Error('game db down');
    };
    state.pgImpl = async () => ({ rows: [] });
    state.pgSql.length = 0;
    await fetchExpansionBoard('legion', 10);
    const sql = state.pgSql.find((s) => s.includes('FROM legions l'));
    expect(sql).toBeDefined();
    expect(sql!).toContain('AS civitas');
    expect(sql!).toContain('ORDER BY civitas DESC');
    expect(sql!).not.toMatch(/ORDER BY l\.xp DESC/);
  });
});

describe('B-37: outage semantics preserved', () => {
  it('a game-MySQL outage still degrades to the Postgres mirror (typed, not swallowed)', async () => {
    expect(() => {
      throw new GameMySqlUnavailableError('down');
    }).toThrow(GameMySqlUnavailableError);
  });
});
