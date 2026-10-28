/**
 * S2-D07 — retention instrumentation, against SEEDED data with known answers.
 *
 * The house SQLite adapter runs the real SQL (migration DDL, monotonic
 * upserts, the readers). The cohort math is pinned by hand:
 *
 *   cohort 2026-W38: 6 joiners (4 minecraft-mp, 2 direct)
 *     d1 = 2/6 (m1 + the direct joiner came back next day)
 *     d7 = 1/6 (m2 only), d30 = 1/6 (m3 only)
 *   a joiner from 2 days ago: d1 = 1, d7/d30 = null (window open — never a
 *   fabricated 0)
 *
 *   funnel (10 joiners): 6 reach rank II, 3 rank V, 2 purchase, 1 of those
 *   returns exactly on day 7 → conversions 0.6 / 0.5 / 0.666667 / 0.5, and
 *   a just-joined purchaser lands in pending_d7, not in the stage count.
 *
 * Covered: ISO week keys (incl. the 2026 long-year W53 edge), cohort math
 * (exact rates + by_source + source filter + null-while-immature), funnel
 * stages/conversions/pending, the daily sync leg (game-MySQL fold with
 * monotonic upserts and source preservation), the endpoints (gates,
 * shapes, date validation, honest 503), and migration parity.
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
    query: vi.fn(async (sql: string) => {
      if (sql.includes('luckperms_players')) return { rows: [{ primary_group: 'default' }] };
      return { rows: [] };
    }),
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
import {
  __resetRetentionSchemaForTests,
  addDays,
  computeCohorts,
  computeFunnel,
  dayKey,
  isoWeekKey,
  listSeenRows,
  loadActiveDays,
  upsertActiveDays,
  upsertSeenRows,
  type SeenRow,
} from '../analytics/retention.js';
import { parseGameTs, runAnalyticsDaily } from '../analytics/cronSync.js';

const BOT = { 'X-Bot-Token': 'test-bot-token' };
const ADMIN = { ...BOT, 'X-Staff-Role': 'admin' };
const HELPER = { ...BOT, 'X-Staff-Role': 'helper' };

const NOW = Date.parse('2026-11-01T00:00:00.000Z');
const ms = (iso: string) => Date.parse(iso);

/** The seeded join-week cohort: 4 minecraft-mp + 2 direct joiners in W38. */
const SEEN: SeenRow[] = [
  { uuid: 'm1', first_seen_ms: ms('2026-09-14T12:00:00Z'), last_seen_ms: ms('2026-09-15T12:00:00Z'), session_count: 2, total_playtime_s: 100, rank_level: 2, source: 'minecraft-mp' },
  { uuid: 'm2', first_seen_ms: ms('2026-09-14T13:00:00Z'), last_seen_ms: ms('2026-09-21T13:00:00Z'), session_count: 3, total_playtime_s: 200, rank_level: 5, source: 'minecraft-mp' },
  { uuid: 'm3', first_seen_ms: ms('2026-09-16T09:00:00Z'), last_seen_ms: ms('2026-10-16T09:00:00Z'), session_count: 5, total_playtime_s: 400, rank_level: 3, source: 'minecraft-mp' },
  { uuid: 'm4', first_seen_ms: ms('2026-09-16T10:00:00Z'), last_seen_ms: ms('2026-09-16T11:00:00Z'), session_count: 1, total_playtime_s: 30, rank_level: 1, source: 'minecraft-mp' },
  { uuid: 'd1', first_seen_ms: ms('2026-09-15T18:00:00Z'), last_seen_ms: ms('2026-09-16T18:00:00Z'), session_count: 2, total_playtime_s: 90, rank_level: 2, source: 'direct' },
  { uuid: 'd2', first_seen_ms: ms('2026-09-18T18:00:00Z'), last_seen_ms: ms('2026-09-18T19:00:00Z'), session_count: 1, total_playtime_s: 20, rank_level: 1, source: 'direct' },
];

/** m1 returns day+1, m2 day+7, m3 day+30, d1 day+1 — exactly as pinned. */
const ACTIVE_DAYS: Array<{ uuid: string; day: string }> = [
  { uuid: 'm1', day: '2026-09-14' },
  { uuid: 'm1', day: '2026-09-15' },
  { uuid: 'm2', day: '2026-09-14' },
  { uuid: 'm2', day: '2026-09-21' },
  { uuid: 'm3', day: '2026-09-16' },
  { uuid: 'm3', day: '2026-10-16' },
  { uuid: 'm4', day: '2026-09-16' },
  { uuid: 'd1', day: '2026-09-15' },
  { uuid: 'd1', day: '2026-09-16' },
  { uuid: 'd2', day: '2026-09-18' },
];

let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  db = new DatabaseSync(':memory:');
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
    D1_RATE_LIMIT: { stub: true },
  } as unknown as Record<string, unknown>);
  getD1Mock.mockImplementation(() => d1FromDb());
  app = createApp();
  claimResults.clear();
  gameQueryMock.mockReset();
  gameQueryMock.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM player_stats ps')) return [];
    if (sql.includes('DISTINCT uuid, DATE')) return [];
    if (sql.includes('FROM currency_balances')) return [];
    if (sql.includes('GROUP BY reason')) return [];
    throw new Error(`unexpected gameQuery in retention test: ${sql.slice(0, 60)}`);
  });
});

async function seedCohort(): Promise<void> {
  await upsertSeenRows(
    SEEN.map((s) => ({
      uuid: s.uuid,
      firstSeenMs: s.first_seen_ms,
      lastSeenMs: s.last_seen_ms,
      sessionCount: s.session_count,
      totalPlaytimeS: s.total_playtime_s,
      rankLevel: s.rank_level,
    })),
    NOW,
  );
  await upsertActiveDays(ACTIVE_DAYS);
  // The sync leg writes 'direct' for everyone (S2-E09 has not landed); the
  // minecraft-mp attribution here mirrors the frontend half arriving later —
  // attribution is set OUTSIDE the sync (and the sync must not regress it).
  db.exec("UPDATE retention_player_seen SET source = 'minecraft-mp' WHERE uuid IN ('m1','m2','m3','m4')");
}

/* ── Date helpers ─────────────────────────────────────────────────────────── */

describe('ISO week keys', () => {
  it('anchors: 2026-09-16 is W38, Jan 1 (a Thursday) starts W01', () => {
    expect(isoWeekKey(ms('2026-09-16T12:00:00Z'))).toBe('2026-W38');
    expect(isoWeekKey(ms('2026-01-01T12:00:00Z'))).toBe('2026-W01');
    expect(isoWeekKey(ms('2026-09-14T00:00:00Z'))).toBe('2026-W38'); // Monday
    expect(isoWeekKey(ms('2026-09-20T23:00:00Z'))).toBe('2026-W38'); // Sunday
    expect(isoWeekKey(ms('2026-09-21T00:00:00Z'))).toBe('2026-W39'); // next Monday
  });

  it('the Monday before a Thursday Jan 1 already belongs to the new year (2026-W01)', () => {
    expect(isoWeekKey(ms('2025-12-29T12:00:00Z'))).toBe('2026-W01');
  });

  it('2026 is a long ISO year: Dec 30 lands in W53', () => {
    expect(isoWeekKey(ms('2026-12-30T12:00:00Z'))).toBe('2026-W53');
  });

  it('addDays/dayKey round-trip across month ends', () => {
    expect(addDays('2026-09-16', 30)).toBe('2026-10-16');
    expect(addDays('2026-01-31', 1)).toBe('2026-02-01');
    expect(dayKey(ms('2026-09-16T23:59:59Z'))).toBe('2026-09-16');
  });
});

/* ── Cohort math (pure, seeded) ───────────────────────────────────────────── */

describe('computeCohorts with a known W38 cohort', () => {
  it('computes the exact d1/d7/d30 and the by_source breakdown', () => {
    const active = new Map<string, Set<string>>();
    for (const d of ACTIVE_DAYS) {
      if (!active.has(d.uuid)) active.set(d.uuid, new Set());
      active.get(d.uuid)!.add(d.day);
    }
    const cohorts = computeCohorts(SEEN, active, { nowMs: NOW });
    expect(cohorts).toHaveLength(1);
    const w38 = cohorts[0]!;
    expect(w38.join_week).toBe('2026-W38');
    expect(w38.size).toBe(6);
    expect(w38.d1).toBeCloseTo(2 / 6, 6); // m1 + d1
    expect(w38.d7).toBeCloseTo(1 / 6, 6); // m2 only
    expect(w38.d30).toBeCloseTo(1 / 6, 6); // m3 only
    expect(w38.by_source['minecraft-mp']).toEqual({
      size: 4,
      d1: expect.any(Number),
      d7: expect.any(Number),
      d30: expect.any(Number),
    });
    expect(w38.by_source['minecraft-mp']!.d1).toBeCloseTo(0.25, 6);
    expect(w38.by_source['minecraft-mp']!.d7).toBeCloseTo(0.25, 6);
    expect(w38.by_source['minecraft-mp']!.d30).toBeCloseTo(0.25, 6);
    expect(w38.by_source['direct']!.size).toBe(2);
    expect(w38.by_source['direct']!.d1).toBeCloseTo(0.5, 6);
    expect(w38.by_source['direct']!.d7).toBe(0); // matured, nobody returned → honest 0
  });

  it('an immature cohort reports null (a 2-day-old joiner has d1 but no d7/d30)', () => {
    const young: SeenRow = {
      uuid: 'y1', first_seen_ms: ms('2026-10-30T10:00:00Z'), last_seen_ms: ms('2026-10-31T10:00:00Z'),
      session_count: 2, total_playtime_s: 50, rank_level: 1, source: 'direct',
    };
    const active = new Map([[ 'y1', new Set(['2026-10-30', '2026-10-31']) ]]);
    const cohorts = computeCohorts([young], active, { nowMs: NOW });
    expect(cohorts[0]!.join_week).toBe('2026-W44');
    expect(cohorts[0]!.size).toBe(1);
    expect(cohorts[0]!.d1).toBe(1); // returned on 10-31
    expect(cohorts[0]!.d7).toBeNull(); // 11-06 hasn't happened — never a fabricated 0
    expect(cohorts[0]!.d30).toBeNull();
  });

  it('from/to bound the JOIN day, and no players means no cohorts', () => {
    const active = new Map();
    expect(computeCohorts(SEEN, active, { nowMs: NOW, from: '2026-10-01' })).toEqual([]);
    const week = computeCohorts(SEEN, active, { nowMs: NOW, from: '2026-09-14', to: '2026-09-20' });
    expect(week).toHaveLength(1);
    expect(week[0]!.size).toBe(6);
  });
});

/* ── Funnel math (pure, seeded) ───────────────────────────────────────────── */

describe('computeFunnel with a known cohort', () => {
  function funnelPlayers(): SeenRow[] {
    const players: SeenRow[] = [];
    for (let i = 1; i <= 10; i += 1) {
      players.push({
        uuid: `p${i}`,
        first_seen_ms: ms('2026-09-14T12:00:00Z'),
        last_seen_ms: ms('2026-09-20T12:00:00Z'),
        session_count: 2,
        total_playtime_s: 100,
        // p1..p6 reach rank II+; p1..p3 reach rank V.
        rank_level: i <= 3 ? 5 : i <= 6 ? 2 : 1,
        source: 'direct',
      });
    }
    return players;
  }

  function activeFor(returners: string[], extraDays: string[] = []): Map<string, Set<string>> {
    const active = new Map<string, Set<string>>();
    for (const p of funnelPlayers()) active.set(p.uuid, new Set([dayKey(p.first_seen_ms), ...extraDays]));
    for (const r of returners) active.get(r)!.add(addDays('2026-09-14', 7)); // 09-21
    return active;
  }

  const purchases = new Map([['p2', ms('2026-09-16T12:00:00Z')], ['p3', ms('2026-09-17T12:00:00Z')]]);

  it('stages count absolute reachers and convert stage-over-stage', () => {
    const funnel = computeFunnel(funnelPlayers(), activeFor(['p2']), purchases, { nowMs: NOW });
    expect(funnel.stages.map((s) => s.stage)).toEqual(['joined', 'rank_ii', 'rank_v', 'first_purchase', 'd7_return']);
    const [joined, rankIi, rankV, purchase, d7] = funnel.stages;
    expect(joined!.count).toBe(10);
    expect(joined!.conversion).toBeNull(); // no previous stage
    expect(rankIi!.count).toBe(6);
    expect(rankIi!.conversion).toBeCloseTo(0.6, 6);
    expect(rankV!.count).toBe(3);
    expect(rankV!.conversion).toBeCloseTo(0.5, 6);
    expect(purchase!.count).toBe(2);
    expect(purchase!.conversion).toBeCloseTo(2 / 3, 6);
    expect(d7!.count).toBe(1); // p2 only (p3 bought but did not return on day 7)
    expect(d7!.conversion).toBeCloseTo(0.5, 6);
    expect(funnel.pending_d7).toBe(0);
  });

  it('a just-joined purchaser sits in pending_d7, never in the d7 count', () => {
    const players = [
      ...funnelPlayers(),
      { uuid: 'new', first_seen_ms: ms('2026-10-28T12:00:00Z'), last_seen_ms: ms('2026-10-28T13:00:00Z'), session_count: 1, total_playtime_s: 10, rank_level: 6, source: 'direct' } as SeenRow,
    ];
    const active = activeFor([]);
    active.set('new', new Set(['2026-10-28']));
    const funnel = computeFunnel(players, active, new Map([...purchases, ['new', ms('2026-10-29T00:00:00Z')]]), { nowMs: NOW });
    // Nobody returned on day 7 in this scenario (no 09-21 presence seeded)...
    expect(funnel.stages.find((s) => s.stage === 'd7_return')!.count).toBe(0);
    // ...and 'new' cannot even be judged yet (its window closes 11-04) — it
    // is pending, not a zero.
    expect(funnel.pending_d7).toBe(1);
  });
});

/* ── The daily sync leg (game MySQL → D1) ─────────────────────────────────── */

describe('retention sync leg', () => {
  it('folds player state into retention_player_seen and presence days', async () => {
    gameQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM player_stats ps')) {
        return [{
          uuid: 'X'.repeat(8) + '-aaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          join_count: 14,
          last_join: '2026-10-01 10:00:00',
          last_quit: '2026-10-01 12:30:00',
          rank_level: 7,
          total_secs: 5000,
          first_seen: '2026-09-01 08:00:00',
        }];
      }
      if (sql.includes('DISTINCT uuid, DATE')) {
        return [
          { uuid: 'X'.repeat(8) + '-aaaa-bbbb-cccc-dddd-eeeeeeeeeeee', day: '2026-09-30' },
          { uuid: 'X'.repeat(8) + '-aaaa-bbbb-cccc-dddd-eeeeeeeeeeee', day: '2026-10-01' },
        ];
      }
      if (sql.includes('FROM currency_balances')) return [];
      if (sql.includes('GROUP BY reason')) return [];
      throw new Error(`unexpected gameQuery: ${sql.slice(0, 50)}`);
    });
    const report = await runAnalyticsDaily(new Date('2026-10-01T00:07:00Z')); // inside the fold window
    expect(report.retention.ran).toBe(true);
    expect(report.retention.players).toBe(1);
    expect(report.retention.days).toBe(2);

    const seen = await listSeenRows();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.first_seen_ms).toBe(Date.parse('2026-09-01T08:00:00Z')); // first_seen anchor, not last_join
    expect(seen[0]!.last_seen_ms).toBe(Date.parse('2026-10-01T12:30:00Z')); // last_quit is the latest
    expect(seen[0]!.session_count).toBe(14);
    expect(seen[0]!.total_playtime_s).toBe(5000);
    expect(seen[0]!.rank_level).toBe(7);
    expect(seen[0]!.source).toBe('direct'); // the never-null default until S2-E09
    const active = await loadActiveDays('2026-01-01', '2027-01-01');
    expect(active.get(seen[0]!.uuid)).toEqual(new Set(['2026-09-30', '2026-10-01']));
  });

  it('re-syncs are monotonic: a worse snapshot never regresses first_seen/rank/sessions/source', async () => {
    const uuid = 'X'.repeat(8) + '-aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    await upsertSeenRows([{ uuid, firstSeenMs: ms('2026-09-01T08:00:00Z'), lastSeenMs: ms('2026-10-01T12:30:00Z'), sessionCount: 14, totalPlaytimeS: 5000, rankLevel: 7 }], NOW);
    db.exec(`UPDATE retention_player_seen SET source = 'minecraft-mp' WHERE uuid = '${uuid}'`); // S2-E09 attributed it
    // A later sync reports WORSE numbers (older join anchor would be later; rank down; sessions down).
    await upsertSeenRows([{ uuid, firstSeenMs: ms('2026-09-05T08:00:00Z'), lastSeenMs: ms('2026-09-20T00:00:00Z'), sessionCount: 5, totalPlaytimeS: 100, rankLevel: 3 }], NOW);
    const seen = await listSeenRows();
    expect(seen[0]!.first_seen_ms).toBe(ms('2026-09-01T08:00:00Z')); // kept the EARLIER anchor
    expect(seen[0]!.rank_level).toBe(7); // max
    expect(seen[0]!.session_count).toBe(14); // max
    expect(seen[0]!.source).toBe('minecraft-mp'); // attribution never regressed to 'direct'
  });

  it('a game-MySQL failure reports the error and releases the claim', async () => {
    gameQueryMock.mockImplementation(async () => {
      throw new Error('game-mysql unavailable: timeout');
    });
    const report = await runAnalyticsDaily(new Date('2026-10-01T00:07:00Z')); // inside the fold window
    expect(report.retention.ran).toBe(false);
    expect(report.retention.error).toContain('timeout');
  });
});

/* ── The routes ───────────────────────────────────────────────────────────── */

describe('GET /api/v2/admin/retention/cohorts', () => {
  beforeEach(seedCohort);

  it('the fail-closed admin gate: anonymous 401, helper 403, admin 200', async () => {
    expect((await app.request('/api/v2/admin/retention/cohorts')).status).toBe(401);
    expect((await app.request('/api/v2/admin/retention/cohorts', { headers: HELPER })).status).toBe(403);
    expect((await app.request('/api/v2/admin/retention/cohorts', { headers: ADMIN })).status).toBe(200);
  });

  it('serves the seeded cohort with the exact pinned numbers', async () => {
    const res = await app.request('/api/v2/admin/retention/cohorts', { headers: ADMIN });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { cohorts: Array<Record<string, unknown>> };
    expect(json.cohorts).toHaveLength(1);
    const w38 = json.cohorts[0]!;
    expect(w38.join_week).toBe('2026-W38');
    expect(w38.size).toBe(6);
    expect(w38.d1).toBeCloseTo(2 / 6, 6);
    expect(w38.d7).toBeCloseTo(1 / 6, 6);
    expect(w38.d30).toBeCloseTo(1 / 6, 6);
    expect(w38.by_source).toMatchObject({ 'minecraft-mp': { size: 4 }, direct: { size: 2 } });
  });

  it('?source= slices the SQL level (minecraft-mp only → size 4)', async () => {
    const res = await app.request('/api/v2/admin/retention/cohorts?source=minecraft-mp', { headers: ADMIN });
    const json = (await res.json()) as { cohorts: Array<{ size: number; by_source: Record<string, unknown> }> };
    expect(json.cohorts[0]!.size).toBe(4);
    expect(Object.keys(json.cohorts[0]!.by_source)).toEqual(['minecraft-mp']);
  });

  it('from/to bound the join window and junk dates are 400', async () => {
    const october = await app.request('/api/v2/admin/retention/cohorts?from=2026-10-01', { headers: ADMIN });
    expect(((await october.json()) as { cohorts: unknown[] }).cohorts).toEqual([]); // W38 joiners excluded
    expect((await app.request('/api/v2/admin/retention/cohorts?from=nonsense', { headers: ADMIN })).status).toBe(400);
    expect((await app.request('/api/v2/admin/retention/cohorts?to=2026-13-99', { headers: ADMIN })).status).toBe(400);
  });

  it('a D1 outage answers 503, never a hang', async () => {
    getD1Mock.mockImplementation(() => {
      throw new Error('d1 down');
    });
    const res = await app.request('/api/v2/admin/retention/cohorts', { headers: ADMIN });
    expect(res.status).toBe(503);
  });
});

describe('GET /api/v2/admin/retention/funnel', () => {
  beforeEach(async () => {
    // The 10-joiner funnel cohort + one just-joined purchaser (pending_d7).
    await upsertSeenRows(
      Array.from({ length: 10 }, (_, i) => ({
        uuid: `p${i + 1}`,
        firstSeenMs: ms('2026-09-14T12:00:00Z'),
        lastSeenMs: ms('2026-09-20T12:00:00Z'),
        sessionCount: 2,
        totalPlaytimeS: 100,
        rankLevel: i < 3 ? 5 : i < 6 ? 2 : 1,
      })).concat([{
        uuid: 'new', firstSeenMs: ms('2026-10-28T12:00:00Z'), lastSeenMs: ms('2026-10-28T13:00:00Z'),
        sessionCount: 1, totalPlaytimeS: 10, rankLevel: 6,
      }]),
      NOW,
    );
    const days: Array<{ uuid: string; day: string }> = [];
    for (let i = 1; i <= 10; i += 1) days.push({ uuid: `p${i}`, day: '2026-09-14' });
    days.push({ uuid: 'p2', day: '2026-09-21' }); // the one day-7 returner
    days.push({ uuid: 'new', day: '2026-10-28' });
    await upsertActiveDays(days);
    // Purchases: the delivery ledger's own customer evidence (D1 truth).
    db.exec(`CREATE TABLE IF NOT EXISTS store_delivery_ledger (
      order_id TEXT NOT NULL, line_key TEXT NOT NULL, customer_uuid TEXT, queued_at INTEGER NOT NULL,
      PRIMARY KEY (order_id, line_key))`);
    const ins = db.prepare('INSERT INTO store_delivery_ledger (order_id, line_key, customer_uuid, queued_at) VALUES (?, ?, ?, ?)');
    ins.run('o1', '0:x:1:p2', 'p2', ms('2026-09-16T12:00:00Z'));
    ins.run('o2', '0:x:1:p3', 'p3', ms('2026-09-17T12:00:00Z'));
    ins.run('o3', '0:x:1:new', 'new', ms('2026-10-29T00:00:00Z'));
    ins.run('o4', '0:x:1:np', 'p7', 0); // a rank-I player bought — below rank_v, must NOT count
  });

  it('the fail-closed admin gate: anonymous 401, helper 403, admin 200', async () => {
    expect((await app.request('/api/v2/admin/retention/funnel')).status).toBe(401);
    expect((await app.request('/api/v2/admin/retention/funnel', { headers: HELPER })).status).toBe(403);
    expect((await app.request('/api/v2/admin/retention/funnel', { headers: ADMIN })).status).toBe(200);
  });

  it('serves the exact pinned stages, conversions, and pending_d7', async () => {
    const res = await app.request('/api/v2/admin/retention/funnel', { headers: ADMIN });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      stages: Array<{ stage: string; count: number; conversion: number | null }>;
      pending_d7: number;
    };
    expect(json.stages.map((s) => s.stage)).toEqual(['joined', 'rank_ii', 'rank_v', 'first_purchase', 'd7_return']);
    const [joined, rankIi, rankV, purchase, d7] = json.stages;
    expect(joined!.count).toBe(11); // 10 + the pending 'new' joiner
    expect(rankIi!.count).toBe(7); // 6 + 'new'
    expect(rankIi!.conversion).toBeCloseTo(7 / 11, 6);
    expect(rankV!.count).toBe(4); // 3 + 'new'
    expect(rankV!.conversion).toBeCloseTo(4 / 7, 6);
    expect(purchase!.count).toBe(3); // p2, p3, new (p7's purchase is below rank_v)
    expect(purchase!.conversion).toBeCloseTo(3 / 4, 6);
    expect(d7!.count).toBe(1); // p2 only
    expect(d7!.conversion).toBeCloseTo(1 / 3, 6);
    expect(json.pending_d7).toBe(1); // 'new' (window closes 11-04)
  });

  it('?source= slices, junk dates 400, and a D1 outage 503s', async () => {
    const direct = await app.request('/api/v2/admin/retention/funnel?source=direct', { headers: ADMIN });
    const json = (await direct.json()) as { stages: Array<{ stage: string; count: number }> };
    expect(json.stages[0]!.count).toBe(11); // everything is 'direct' until S2-E09 attribution

    expect((await app.request('/api/v2/admin/retention/funnel?from=oops', { headers: ADMIN })).status).toBe(400);

    getD1Mock.mockImplementation(() => {
      throw new Error('d1 down');
    });
    expect((await app.request('/api/v2/admin/retention/funnel', { headers: ADMIN })).status).toBe(503);
  });
});

/* ── Helpers + migration parity ───────────────────────────────────────────── */

describe('parseGameTs', () => {
  it('accepts the wire shapes the game MySQL produces (string, ISO, epoch)', () => {
    expect(parseGameTs('2026-09-01 08:00:00')).toBe(Date.parse('2026-09-01T08:00:00Z'));
    expect(parseGameTs('2026-09-01T08:00:00Z')).toBe(Date.parse('2026-09-01T08:00:00Z'));
    expect(parseGameTs(1_700_000_000)).toBe(1_700_000_000_000); // epoch seconds
    expect(parseGameTs(new Date('2026-09-01T08:00:00Z'))).toBe(Date.parse('2026-09-01T08:00:00Z'));
    expect(parseGameTs(null)).toBeNull();
    expect(parseGameTs('')).toBeNull();
    expect(parseGameTs('not a timestamp')).toBeNull();
  });
});

describe('d1_0006 migration parity (retention tables)', () => {
  it('both retention tables match the migration DDL column-for-column', async () => {
    await listSeenRows(); // triggers lazy ensure
    const migration = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations', 'd1_0006_analytics.sql'),
      'utf8',
    );
    const colsOf = (table: string): string[] => {
      const block = migration.slice(migration.indexOf(`CREATE TABLE IF NOT EXISTS ${table}`));
      return [
        ...block
          .slice(0, block.indexOf(');'))
          .matchAll(/^\s{2}(\w+)\s/gm),
      ]
        .map((m) => m[1]!)
        .filter((name) => !['PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN', 'CONSTRAINT'].includes(name));
    };
    for (const table of ['retention_player_seen', 'retention_player_days']) {
      const dbCols = (
        db.prepare(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`).all() as { name: string }[]
      ).map((c) => c.name);
      expect(colsOf(table)).toEqual(dbCols);
    }
    // The binding rule: source defaults to 'direct' and is NOT NULL.
    const src = db.prepare("SELECT \"notnull\" AS n, dflt_value AS d FROM pragma_table_info('retention_player_seen') WHERE name = 'source'").get() as { n: number; d: string };
    expect(src.n).toBe(1);
    expect(String(src.d).replace(/'/g, '')).toBe('direct');
  });
});
