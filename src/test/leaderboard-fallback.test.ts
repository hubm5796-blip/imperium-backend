import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B-55: the Postgres playtime fallback joined player_names to ITSELF
 * (`ON pl.uuid = pl.uuid` — always true), fanning every playtime row out
 * against near-all name rows and garbling page contents + nextCursor. The
 * game-MySQL path usually wins and gameQuery swallows fallback errors, so
 * it bit exactly when the fallback was needed. The fake pg client both
 * (a) proves the emitted SQL joins on pl.uuid = pn.uuid — this assertion
 * fails on the pre-fix code — and (b) feeds two playtime rows through the
 * fallback mapping (2 players → 2 entries, one name each).
 */
const state = vi.hoisted(() => ({
  pgQueries: [] as Array<{ sql: string; params: unknown[] }>,
  nextRows: [] as Array<Record<string, string>>,
}));
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
            return { rows: state.nextRows, rowCount: state.nextRows.length };
          },
          release() {},
        };
      }
    },
  };
});
vi.mock('../db/gameMysql.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/gameMysql.js')>();
  return {
    ...actual,
    gameQuery: vi.fn(async () => {
      throw new Error('game MySQL unavailable — forcing the Postgres fallback');
    }),
  };
});

import { initEnvFromBindings } from '../env.js';
import { initPool, getLeaderboardPage } from '../db/pool.js';

describe('B-55 playtime fallback join', () => {
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
    } as unknown as Record<string, unknown>);
    initPool('postgresql://fake');
  });

  beforeEach(() => {
    state.pgQueries.length = 0;
    state.nextRows = [];
  });

  it('the fallback SQL joins player_names ON pl.uuid = pn.uuid (fails on the tautology)', async () => {
    await getLeaderboardPage('playtime', 10, null);
    const playtimeQuery = state.pgQueries.find((q) => q.sql.includes('FROM player_playtime pl'));
    expect(playtimeQuery).toBeDefined();
    expect(playtimeQuery!.sql).toContain('LEFT JOIN player_names pn ON pl.uuid = pn.uuid');
    expect(playtimeQuery!.sql).not.toContain('pl.uuid = pl.uuid');
  });

  it('2 players → 2 mapped entries with their own names (no fan-out in the mapping)', async () => {
    state.nextRows = [
      { uuid: 'aaaaaaaa-0000-0000-0000-000000000001', total_secs: '9000', name: 'Alpha' },
      { uuid: 'aaaaaaaa-0000-0000-0000-000000000002', total_secs: '8000', name: 'Beta' },
    ];
    const page = await getLeaderboardPage('playtime', 10, null);
    expect(page.rows).toHaveLength(2);
    expect(page.rows[0]).toMatchObject({ uuid: 'aaaaaaaa-0000-0000-0000-000000000001', name: 'Alpha', value: 9000 });
    expect(page.rows[1]).toMatchObject({ uuid: 'aaaaaaaa-0000-0000-0000-000000000002', name: 'Beta', value: 8000 });
    expect(page.nextCursor).toBeNull();
  });
});
