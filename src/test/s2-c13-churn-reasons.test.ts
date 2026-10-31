/**
 * S2-C13 (Lane D backend half, Option A — the syncRetention D1 fold) —
 * churn-reason grouping for the E06 retention dashboard.
 *
 * The plugin (Lane C, landed) writes one churn_reason_events row per session
 * end into the game MySQL with the LAST meaningful event's type. This suite
 * pins the backend half: the daily fold into a D1 table (retention_churn_
 * reasons), the id-keyed idempotency (a re-fold never double-counts), the
 * uuid-dropping privacy shape (the D1 row is day+reason only), and the
 * admin-gated reader GET /api/v2/admin/retention/churn-reasons.
 *
 * Seeded answers (one row per reason class incl. `none`, plus one UNKNOWN
 * future reason — the S2-E09 vocabulary rule: data, not a 500):
 *
 *   2026-10-27: death x1, none x2
 *   2026-10-28: death x2, permission_denied x1, purchase_failed x1,
 *               econ_refused x1, none x3, future_reason x1 (unknown)
 *
 * The house SQLite adapter runs the real DDL + SQL; gameQuery is mocked at
 * the module boundary with the seeded rows.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let db: DatabaseSync;

function d1FromDb() {
  return {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            run: async () => {
              const info = db.prepare(sql).run(...(params as never[]));
              return { meta: { changes: Number(info.changes) } };
            },
            first: async <T>() => (db.prepare(sql).get(...(params as never[])) as T | undefined) ?? null,
            all: async <T>() => ({ results: db.prepare(sql).all(...(params as never[])) as T[] }),
          };
        },
        run: async () => {
          const info = db.prepare(sql).run();
          return { meta: { changes: Number(info.changes) } };
        },
        first: async <T>() => (db.prepare(sql).get() as T | undefined) ?? null,
        all: async <T>() => ({ results: db.prepare(sql).all() as T[] }),
      };
    },
    batch: async (stmts: Array<{ run: () => Promise<unknown> }>) => {
      for (const stmt of stmts) await stmt.run();
      return [];
    },
  };
}

const { claimResults, gameQueryMock, getD1Mock } = vi.hoisted(() => ({
  claimResults: new Map<string, boolean>(),
  gameQueryMock: vi.fn(),
  getD1Mock: vi.fn(),
}));

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    getD1: getD1Mock,
    query: vi.fn(async () => ({ rows: [] })),
  };
});
vi.mock('../db/redis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/redis.js')>();
  return {
    ...actual,
    getOnlinePlayerCount: vi.fn(async () => 0),
    getCachedJson: vi.fn(async () => null),
    setCachedJson: vi.fn(async () => undefined),
  };
});
vi.mock('../bot/botdb.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../bot/botdb.js')>();
  return {
    ...actual,
    claim: vi.fn(async (key: string) => claimResults.get(key) ?? true),
    release: vi.fn(async () => undefined),
  };
});
vi.mock('../db/gameMysql.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/gameMysql.js')>();
  return { ...actual, gameQuery: gameQueryMock };
});

import { createApp } from '../app.js';
import { initEnvFromBindings, __resetEnvForTests } from '../env.js';
import { __resetRetentionSchemaForTests, listChurnReasons, upsertChurnRows } from '../analytics/retention.js';
import { runAnalyticsDaily } from '../analytics/cronSync.js';

const BOT = { 'X-Bot-Token': 'test-bot-token' };
const ADMIN = { ...BOT, 'X-Staff-Role': 'admin' };
const HELPER = { ...BOT, 'X-Staff-Role': 'helper' };

/** The seeded game-MySQL rows (ids are the plugin table's AUTO_INCREMENT). */
interface GameChurnRow {
  id: number;
  day: string;
  reason: string;
}
const SEED: GameChurnRow[] = [
  { id: 1, day: '2026-10-27', reason: 'death' },
  { id: 2, day: '2026-10-27', reason: 'none' },
  { id: 3, day: '2026-10-27', reason: 'none' },
  { id: 4, day: '2026-10-28', reason: 'death' },
  { id: 5, day: '2026-10-28', reason: 'death' },
  { id: 6, day: '2026-10-28', reason: 'permission_denied' },
  { id: 7, day: '2026-10-28', reason: 'purchase_failed' },
  { id: 8, day: '2026-10-28', reason: 'econ_refused' },
  { id: 9, day: '2026-10-28', reason: 'none' },
  { id: 10, day: '2026-10-28', reason: 'none' },
  { id: 11, day: '2026-10-28', reason: 'none' },
  { id: 12, day: '2026-10-28', reason: 'future_reason' }, // a plugin vocabulary addition this backend does not know
];

let app: ReturnType<typeof createApp>;

/** Route the leg's game queries: the churn seed + empty everything else. */
function mockGame(churn: GameChurnRow[] | Error): void {
  gameQueryMock.mockReset();
  gameQueryMock.mockImplementation(async (sql: string, params: unknown[]) => {
    if (sql.includes('FROM churn_reason_events')) {
      if (churn instanceof Error) throw churn;
      return churn.map((r) => ({ id: r.id, day: r.day, reason: r.reason }));
    }
    if (sql.includes('FROM player_stats ps')) return [];
    if (sql.includes('DISTINCT uuid, DATE')) return [];
    if (sql.includes('FROM currency_balances')) return [];
    if (sql.includes('GROUP BY reason')) return [];
    void params;
    throw new Error(`unexpected gameQuery in churn test: ${sql.slice(0, 60)}`);
  });
}

beforeEach(async () => {
  db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS rate_limit_windows (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, hits INTEGER NOT NULL DEFAULT 0)');
  db.exec('CREATE TABLE IF NOT EXISTS rate_limit_v2_windows (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, cost INTEGER NOT NULL DEFAULT 0)');
  __resetRetentionSchemaForTests();
  __resetEnvForTests();
  initEnvFromBindings({
    JWT_SECRET: 'test-jwt-secret-0123456789abcdef',
    WEBPANEL_HMAC_SECRET: 'test-hmac-secret',
    DISCORD_CLIENT_ID: '1',
    DISCORD_CLIENT_SECRET: 'x',
    BOT_API_TOKEN: 'test-bot-token',
    PAYNOW_API_KEY: 'pk',
    PAYNOW_STORE_ID: '1',
    PAYNOW_WEBHOOK_SECRETS: 'whsec',
  } as unknown as Record<string, unknown>);
  getD1Mock.mockImplementation(() => d1FromDb());
  app = createApp();
  claimResults.clear();
  mockGame(SEED);
});

/* ── The fold ─────────────────────────────────────────────────────────────── */

describe('cronSync churn fold (syncRetention rider)', () => {
  it('folds the seeded rows into retention_churn_reasons with exact counts', async () => {
    const report = await runAnalyticsDaily(new Date('2026-10-29T00:07:00Z'));
    expect(report.retention.ran).toBe(true);
    expect(report.retention.churn_events).toBe(12);
    const rows = db.prepare('SELECT id, day, reason FROM retention_churn_reasons ORDER BY id').all() as unknown as GameChurnRow[];
    expect(rows).toEqual(SEED);
  });

  it('queries the game MySQL with a 30-day window bound (the player-fold window)', async () => {
    await runAnalyticsDaily(new Date('2026-10-29T00:07:00Z'));
    const call = gameQueryMock.mock.calls.find((c) => String(c[0]).includes('FROM churn_reason_events'));
    expect(call, 'the fold must query churn_reason_events').toBeTruthy();
    expect(call![1]).toEqual(['2026-09-29 00:07:00']); // now - 30d, MySQL datetime
  });

  it('a re-fold never double-counts (id-keyed INSERT OR IGNORE)', async () => {
    await runAnalyticsDaily(new Date('2026-10-29T00:07:00Z'));
    const second = await runAnalyticsDaily(new Date('2026-10-30T00:07:00Z'));
    expect(second.retention.ran).toBe(true);
    expect(second.retention.churn_events).toBe(0); // all 12 ids already folded
    const grouped = await listChurnReasons('2026-10-01', '2026-10-31');
    expect(grouped.reasons.find((r) => r.reason === 'none')!.count).toBe(5);
    expect(grouped.reasons.find((r) => r.reason === 'death')!.count).toBe(3);
  });

  it('a missing game table (backend deployed first) skips the churn rider without failing the leg', async () => {
    mockGame(new Error("Table 'game.churn_reason_events' doesn't exist"));
    const report = await runAnalyticsDaily(new Date('2026-10-29T00:07:00Z'));
    expect(report.retention.ran).toBe(true); // the retention fold still ran
    expect(report.retention.churn_events).toBe(0);
    expect(report.retention.churn_error).toBeUndefined(); // expected transitional state, not an error
  });

  it('an unrelated churn-fold failure is reported (churn_error) but does not kill the retention leg', async () => {
    mockGame(new Error('game-mysql unavailable: connection lost'));
    const report = await runAnalyticsDaily(new Date('2026-10-29T00:07:00Z'));
    expect(report.retention.ran).toBe(true);
    expect(report.retention.churn_error).toContain('connection lost');
  });

  it('stores NO player identifiers — the D1 row is (id, day, reason) only', async () => {
    await runAnalyticsDaily(new Date('2026-10-29T00:07:00Z'));
    const cols = (db.prepare("SELECT name FROM pragma_table_info('retention_churn_reasons') ORDER BY cid").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(['id', 'day', 'reason']);
    expect(cols.some((c) => c.includes('uuid'))).toBe(false);
  });
});

/* ── The reader (pure SQL over D1) ────────────────────────────────────────── */

describe('listChurnReasons', () => {
  beforeEach(async () => {
    await upsertChurnRows(SEED.map(({ id, day, reason }) => ({ id, day, reason })));
  });

  it('groups by reason (count desc) and by day with by_reason maps', async () => {
    const out = await listChurnReasons('2026-10-27', '2026-10-28');
    expect(out.reasons).toEqual([
      { reason: 'none', count: 5 },
      { reason: 'death', count: 3 },
      { reason: 'econ_refused', count: 1 },
      { reason: 'future_reason', count: 1 }, // unknown vocabulary passes through as data
      { reason: 'permission_denied', count: 1 },
      { reason: 'purchase_failed', count: 1 },
    ]);
    expect(out.days).toEqual([
      { day: '2026-10-27', by_reason: { death: 1, none: 2 } },
      {
        day: '2026-10-28',
        by_reason: { death: 2, econ_refused: 1, future_reason: 1, none: 3, permission_denied: 1, purchase_failed: 1 },
      },
    ]);
  });

  it('an empty window answers empty arrays, not an error', async () => {
    const out = await listChurnReasons('2026-01-01', '2026-01-02');
    expect(out).toEqual({ reasons: [], days: [] });
  });
});

/* ── The route ────────────────────────────────────────────────────────────── */

describe('GET /api/v2/admin/retention/churn-reasons', () => {
  beforeEach(async () => {
    await upsertChurnRows(SEED.map(({ id, day, reason }) => ({ id, day, reason })));
  });

  it('the fail-closed admin gate: anonymous 401, helper 403, admin 200', async () => {
    expect((await app.request('/api/v2/admin/retention/churn-reasons')).status).toBe(401);
    expect((await app.request('/api/v2/admin/retention/churn-reasons', { headers: HELPER })).status).toBe(403);
    expect((await app.request('/api/v2/admin/retention/churn-reasons', { headers: ADMIN })).status).toBe(200);
  });

  it('serves the exact grouped shape (reasons + days) for the window', async () => {
    const res = await app.request('/api/v2/admin/retention/churn-reasons?from=2026-10-27&to=2026-10-28', { headers: ADMIN });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      reasons: Array<{ reason: string; count: number }>;
      days: Array<{ day: string; by_reason: Record<string, number> }>;
    };
    expect(json.reasons.find((r) => r.reason === 'none')).toEqual({ reason: 'none', count: 5 });
    expect(json.days).toHaveLength(2);
    expect(json.days[0]!.by_reason).toEqual({ death: 1, none: 2 });
    // Unknown reason vocabulary passes through as data, never a 500.
    expect(json.reasons.find((r) => r.reason === 'future_reason')).toEqual({ reason: 'future_reason', count: 1 });
  });

  it('junk from/to dates are 400 exactly like the other retention reads', async () => {
    expect((await app.request('/api/v2/admin/retention/churn-reasons?from=nonsense', { headers: ADMIN })).status).toBe(400);
    expect((await app.request('/api/v2/admin/retention/churn-reasons?to=2026-13-99', { headers: ADMIN })).status).toBe(400);
  });

  it('a D1 outage answers 503, never a hang', async () => {
    getD1Mock.mockImplementation(() => {
      throw new Error('d1 down');
    });
    expect((await app.request('/api/v2/admin/retention/churn-reasons', { headers: ADMIN })).status).toBe(503);
  });
});

/* ── Migration parity (the D07/D08 pattern) ───────────────────────────────── */

describe('d1_0010 migration parity (retention_churn_reasons)', () => {
  it('the lazy-ensure DDL matches the migration file column-for-column', async () => {
    await upsertChurnRows([{ id: 1, day: '2026-10-28', reason: 'none' }]); // triggers the lazy ensure
    const migration = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations', 'd1_0010_retention_churn.sql'),
      'utf8',
    );
    const block = migration.slice(migration.indexOf('CREATE TABLE IF NOT EXISTS retention_churn_reasons'));
    const cols = [...block.slice(0, block.indexOf(');')).matchAll(/^\s{2}(\w+)\s/gm)]
      .map((m) => m[1]!)
      .filter((name) => !['PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN', 'CONSTRAINT'].includes(name));
    const dbCols = (
      db.prepare("SELECT name FROM pragma_table_info('retention_churn_reasons') ORDER BY cid").all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toEqual(dbCols);
    expect(cols).toEqual(['id', 'day', 'reason']);
  });
});
