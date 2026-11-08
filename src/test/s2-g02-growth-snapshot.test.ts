/**
 * S2-G02 (Lane growth) — the PUBLIC growth snapshot: GET
 * /api/v2/growth/snapshot.json + buildGrowthSnapshot + the CCU peak series
 * (src/analytics/ccu.ts).
 *
 * What these tests pin, in honesty order:
 *   - ANONYMOUS 200: the route publishes counts/rates with no auth, and the
 *     body contains NO player-identifying data — seeded uuids must not
 *     appear anywhere in the response text (the leak pin).
 *   - Pre-launch honesty: an empty fold answers joins_7d {total: 0, []} and
 *     d1_cohort null; ccu_peak_7d null until a sample exists; NOTHING is
 *     fabricated (the queue row's acceptance rule).
 *   - Shape: exact field list/order, windows stated on the payload, top-5
 *     clamp with the deterministic tie-break (count desc, source asc).
 *   - Season clock: 0 before the anchor, whole-day floor after (pinned
 *     against injected instants, not wall-clock, so the pins never rot).
 *   - Cache contract: Cache-Control public max-age=60 swr=300 + X-Cache
 *     (the leaderboards SWR doctrine), MISS then HIT.
 *   - Degradation: every CCU source dead -> ccu_now null + marker, 200; D1
 *     dead -> joins null + marker, 200 (one source never takes the page down).
 *   - The sampler: running MAX upsert (a lower sample never lowers the peak),
 *     sample count, null-count ticks record nothing, hourly prune.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

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

const { redisOnline, pgOnline, mysqlOnline, getCachedJson, setCachedJson, getD1Mock } = vi.hoisted(() => ({
  /** The three online-count sources, mockable per test (null = source down). */
  redisOnline: { count: 12 },
  pgOnline: { count: 5, fail: false },
  mysqlOnline: { count: 2, fail: false },
  getCachedJson: vi.fn(async () => null as unknown),
  setCachedJson: vi.fn(async () => undefined),
  getD1Mock: vi.fn(),
}));

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    getD1: getD1Mock,
    query: vi.fn(async (sql: string) => {
      if (sql.includes('online_players')) {
        if (pgOnline.fail) throw new Error('pg down (simulated)');
        return { rows: [{ n: pgOnline.count }] };
      }
      return { rows: [] };
    }),
  };
});
vi.mock('../db/gameMysql.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/gameMysql.js')>();
  return {
    ...actual,
    gameQuery: vi.fn(async (sql: string) => {
      if (sql.includes('online_players')) {
        if (mysqlOnline.fail) throw new Error('mysql down (simulated)');
        return [{ n: mysqlOnline.count }];
      }
      return [];
    }),
  };
});
vi.mock('../db/redis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/redis.js')>();
  return {
    ...actual,
    getOnlinePlayerCount: vi.fn(async () => redisOnline.count),
    getCachedJson,
    setCachedJson,
  };
});

import { createApp } from '../app.js';
import { initEnvFromBindings, __resetEnvForTests } from '../env.js';
import { __resetRetentionSchemaForTests, addDays, dayKey, upsertActiveDays, upsertSeenRows } from '../analytics/retention.js';
import { __resetCcuSchemaForTests, ensureCcuSchema, readCcuPeak7d, readCcuNow, sampleCcuPeak } from '../analytics/ccu.js';
import { buildGrowthSnapshot, SEASON_2_START_AT_MS } from '../analytics/growth.js';

const DAY = 86_400_000;
const NOW = Date.now();

// Distinct uuids — the leak pin greps the response text for these.
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const E = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const F = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const G = 'gggggggg-gggg-4ggg-8ggg-gggggggggggg';
const I = 'iiiiiiii-iiii-4iii-8iii-iiiiiiiiiiii';
const OUTSIDE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS rate_limit_windows (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, hits INTEGER NOT NULL DEFAULT 0)');
  db.exec('CREATE TABLE IF NOT EXISTS rate_limit_v2_windows (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, cost INTEGER NOT NULL DEFAULT 0)');
  __resetRetentionSchemaForTests();
  __resetCcuSchemaForTests();
  redisOnline.count = 12;
  pgOnline.count = 5;
  pgOnline.fail = false;
  mysqlOnline.count = 2;
  mysqlOnline.fail = false;
  getCachedJson.mockReset().mockResolvedValue(null);
  setCachedJson.mockReset().mockResolvedValue(undefined);
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
    NODE_ENV: 'test',
    D1_RATE_LIMIT: { stub: true },
  } as unknown as Record<string, unknown>);
  getD1Mock.mockImplementation(() => d1FromDb());
  app = createApp();
});

interface SeedRow {
  uuid: string;
  backDays: number;
  source: string;
  /** Active on join day + join day +1 (a d1 hit) or join day only (a miss). */
  d1Hit: boolean;
}

/**
 * Seed the fold. Joins sit at NOW-1/2/3d — all inside BOTH snapshot windows
 * (today-6..today for joins, today-7..today-1 for the cohort) with a full
 * day of cushion on each side, so a midnight straddle between seeding and
 * the request cannot move membership. NOW-1d is always dayKey "yesterday".
 */
async function seedFold(rows: SeedRow[]): Promise<void> {
  await upsertSeenRows(
    rows.map((r) => ({
      uuid: r.uuid,
      firstSeenMs: NOW - r.backDays * DAY,
      lastSeenMs: NOW - r.backDays * DAY,
      sessionCount: 1,
      totalPlaytimeS: 60,
      rankLevel: 1,
      source: r.source,
    })),
    NOW,
  );
  await upsertActiveDays(
    rows.flatMap((r) => {
      const d0 = dayKey(NOW - r.backDays * DAY);
      return r.d1Hit ? [{ uuid: r.uuid, day: d0 }, { uuid: r.uuid, day: addDays(d0, 1) }] : [{ uuid: r.uuid, day: d0 }];
    }),
  );
}

const FULL_FOLD: SeedRow[] = [
  { uuid: A, backDays: 3, source: 'vote-mcs', d1Hit: false },
  { uuid: B, backDays: 3, source: 'vote-mcs', d1Hit: true },
  { uuid: C, backDays: 2, source: 'direct', d1Hit: true },
  { uuid: E, backDays: 2, source: 'site', d1Hit: false },
  { uuid: F, backDays: 2, source: 'wiki', d1Hit: true },
  { uuid: G, backDays: 1, source: 'launcher', d1Hit: true },
  { uuid: I, backDays: 2, source: 'forums', d1Hit: false },
  { uuid: OUTSIDE, backDays: 40, source: 'direct', d1Hit: true }, // outside both windows
];

async function seedPeakToday(peak: number): Promise<void> {
  await ensureCcuSchema();
  db.prepare('INSERT INTO ccu_daily_peak (day, peak, samples, updated_at) VALUES (?, ?, 1, ?)').run(dayKey(NOW), peak, NOW);
}

const getSnapshot = () => app.request('/api/v2/growth/snapshot.json', { headers: {} });

/* ── The route: anonymous access, shape, leakage, cache ───────────────────── */

describe('GET /api/v2/growth/snapshot.json — the public surface', () => {
  it('is anonymous-OK (no bot token, no staff role) and serves the pinned shape/order', async () => {
    await seedFold(FULL_FOLD);
    await seedPeakToday(21);
    const res = await getSnapshot();
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(json)).toEqual([
      'date',
      'generated_at',
      'season_days_elapsed',
      'season_starts_at',
      'ccu_now',
      'ccu_peak_7d',
      'joins_7d',
      'd1_cohort',
      'sources',
    ]);
  });

  it('carries the SWR cache contract headers (the leaderboards doctrine)', async () => {
    await seedFold(FULL_FOLD);
    const res = await getSnapshot();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60, stale-while-revalidate=300');
    expect(res.headers.get('X-Cache')).toBe('MISS');
    // A fresh Redis cache entry serves HIT with the SAME public policy.
    getCachedJson.mockResolvedValueOnce({
      data: { date: '2026-11-07', ccu_now: 0 },
      fetchedAt: Date.now(),
    });
    const hit = await getSnapshot();
    expect(hit.headers.get('X-Cache')).toBe('HIT');
    expect(hit.headers.get('Cache-Control')).toBe('public, max-age=60, stale-while-revalidate=300');
  });

  it('publishes NO player-identifying data — seeded uuids appear nowhere in the body', async () => {
    await seedFold(FULL_FOLD);
    const res = await getSnapshot();
    expect(res.status).toBe(200);
    const text = await res.text();
    for (const uuid of [A, B, C, E, F, G, I, OUTSIDE]) {
      expect(text.includes(uuid), `leaked ${uuid}`).toBe(false);
    }
  });

  it('serves the compact numbers: ccu from the live chain, peak from the series, joins top-5, d1 of the closed cohort', async () => {
    await seedFold(FULL_FOLD);
    await seedPeakToday(21);
    const res = await getSnapshot();
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      date: string;
      ccu_now: number;
      ccu_peak_7d: number;
      joins_7d: { window: { from: string; to: string }; total: number; by_source: Array<{ source: string; joins: number }> };
      d1_cohort: { window: { from: string; to: string }; cohort_size: number; d1: number | null };
      sources: Record<string, string>;
    };
    expect(json.ccu_now).toBe(12); // the redis mock answered
    expect(json.sources.ccu_now).toContain('redis-heartbeat');
    expect(json.ccu_peak_7d).toBe(21);
    expect(json.joins_7d.total).toBe(7); // OUTSIDE (@40d) excluded
    expect(json.joins_7d.window.to).toBe(json.date);
    // 6 sources seeded: vote-mcs 2, then the count-1 ties alphabetical ->
    // direct, forums, launcher, site (wiki is the 6th, clamped out).
    expect(json.joins_7d.by_source).toEqual([
      { source: 'vote-mcs', joins: 2 },
      { source: 'direct', joins: 1 },
      { source: 'forums', joins: 1 },
      { source: 'launcher', joins: 1 },
      { source: 'site', joins: 1 },
    ]);
    // Cohort = the 7 in-window joiners minus today-only... all 7 joined on
    // closed days: d1 hits are B, C, F, G -> 4/7.
    expect(json.d1_cohort!.cohort_size).toBe(7);
    expect(json.d1_cohort!.d1).toBeCloseTo(4 / 7, 5);
    expect(json.d1_cohort!.window.to).toBe(addDays(json.date, -1)); // closed days only
  });

  it('season_days_elapsed counts whole UTC days from the stated anchor (self-consistent, never a rotting pin)', async () => {
    const res = await getSnapshot();
    const json = (await res.json()) as { season_days_elapsed: number; season_starts_at: string; generated_at: string };
    expect(json.season_starts_at).toBe(new Date(SEASON_2_START_AT_MS).toISOString());
    const elapsed = Math.floor((Date.parse(json.generated_at) - Date.parse(json.season_starts_at)) / DAY);
    expect(json.season_days_elapsed).toBe(Math.max(0, elapsed));
  });

  it('is listed in the public OpenAPI document (AI/LLM discovery surface)', async () => {
    const res = await app.request('/api/v2/openapi.json', { headers: {} });
    expect(res.status).toBe(200);
    const spec = (await res.json()) as { paths: Record<string, unknown> };
    expect(spec.paths['/api/v2/growth/snapshot.json']).toBeDefined();
  });
});

/* ── Pre-launch honesty (empty everything) ────────────────────────────────── */

describe('the empty state (fresh D1, no CCU samples)', () => {
  it('zeros and nulls, never fabricated numbers or an error', async () => {
    const res = await getSnapshot();
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ccu_now: number;
      ccu_peak_7d: null;
      joins_7d: { total: number; by_source: unknown[] };
      d1_cohort: null;
      sources: Record<string, string>;
    };
    expect(json.joins_7d).toEqual({ window: expect.anything(), total: 0, by_source: [] });
    expect(json.d1_cohort).toBeNull();
    expect(json.ccu_peak_7d).toBeNull();
    expect(json.ccu_now).toBe(12); // the live count is real even pre-launch
    expect(json.sources.ccu_peak_7d).toContain('no answered sample');
  });
});

/* ── Degradation (one dead source never takes the page down) ─────────────── */

describe('source degradation', () => {
  it('every CCU source dead -> ccu_now null with the marker, still 200', async () => {
    redisOnline.count = null as unknown as number;
    pgOnline.fail = true;
    mysqlOnline.fail = true;
    await seedFold(FULL_FOLD);
    const res = await getSnapshot();
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ccu_now: null; joins_7d: { total: number }; sources: Record<string, string> };
    expect(json.ccu_now).toBeNull();
    expect(json.sources.ccu_now).toContain('unavailable');
    expect(json.joins_7d.total).toBe(7); // the fold is a different source
  });

  it('falls back postgres -> game-mysql when redis is down', async () => {
    redisOnline.count = null as unknown as number;
    const pgFirst = await readCcuNow();
    expect(pgFirst).toEqual({ count: 5, source: 'postgres-snapshot' });
    pgOnline.fail = true;
    const mysqlSecond = await readCcuNow();
    expect(mysqlSecond).toEqual({ count: 2, source: 'game-mysql-snapshot' });
  });

  it('a D1 outage degrades joins/d1/peak to null + markers; ccu_now (redis) still serves', async () => {
    getD1Mock.mockImplementation(() => {
      throw new Error('d1 down (simulated)');
    });
    const res = await getSnapshot();
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      ccu_now: number;
      ccu_peak_7d: null;
      joins_7d: { total: null; by_source: unknown[] };
      d1_cohort: null;
      sources: Record<string, string>;
    };
    expect(json.joins_7d.total).toBeNull();
    expect(json.d1_cohort).toBeNull();
    expect(json.ccu_peak_7d).toBeNull();
    expect(json.ccu_now).toBe(12);
    expect(json.sources.joins_7d).toContain('unavailable');
  });
});

/* ── buildGrowthSnapshot: pinned-instant math (never rots) ───────────────── */

describe('buildGrowthSnapshot with injected instants', () => {
  it('season clock: 0 the ms before the anchor, 0 all day one... 1 only after a whole day', async () => {
    const pre = await buildGrowthSnapshot(SEASON_2_START_AT_MS - 1);
    expect(pre.season_days_elapsed).toBe(0);
    const atOpen = await buildGrowthSnapshot(SEASON_2_START_AT_MS);
    expect(atOpen.season_days_elapsed).toBe(0);
    const nextDay = await buildGrowthSnapshot(SEASON_2_START_AT_MS + DAY);
    expect(nextDay.season_days_elapsed).toBe(1);
    const plus36h = await buildGrowthSnapshot(SEASON_2_START_AT_MS + DAY + 12 * 3_600_000);
    expect(plus36h.season_days_elapsed).toBe(1); // whole days only
  });

  it('an all-null-ccu instant still builds (each section isolated inside the builder)', async () => {
    redisOnline.count = null as unknown as number;
    pgOnline.fail = true;
    mysqlOnline.fail = true;
    const snap = await buildGrowthSnapshot(NOW);
    expect(snap.ccu_now).toBeNull();
    expect(snap.joins_7d.total).toBe(0);
    expect(snap.d1_cohort).toBeNull();
  });
});

/* ── The CCU peak series (src/analytics/ccu.ts) ───────────────────────────── */

describe('sampleCcuPeak / readCcuPeak7d', () => {
  it('folds a running MAX: later lower samples never lower the peak; samples count ticks', async () => {
    // All ticks share one instant — same-day row, no midnight-straddle flake.
    expect((await sampleCcuPeak(new Date(NOW))).peak).toBe(12);
    expect((await sampleCcuPeak(new Date(NOW))).peak).toBe(12);
    redisOnline.count = 3;
    const third = await sampleCcuPeak(new Date(NOW));
    expect(third.sampled).toBe(true);
    expect(third.peak).toBe(12); // MAX held
    redisOnline.count = 30;
    const fourth = await sampleCcuPeak(new Date(NOW));
    expect(fourth.peak).toBe(30);
    const row = db.prepare('SELECT peak, samples FROM ccu_daily_peak WHERE day = ?').get(dayKey(NOW)) as { peak: number; samples: number };
    expect(row).toEqual({ peak: 30, samples: 4 });
  });

  it('a null count records NOTHING (no fabricated 0-day)', async () => {
    redisOnline.count = null as unknown as number;
    pgOnline.fail = true;
    mysqlOnline.fail = true;
    const report = await sampleCcuPeak(new Date(NOW));
    expect(report.sampled).toBe(false);
    const row = db.prepare('SELECT COUNT(*) AS n FROM ccu_daily_peak').get() as { n: number };
    expect(row.n).toBe(0);
    expect(await readCcuPeak7d(NOW)).toBeNull();
  });

  it('readCcuPeak7d: MAX over the 7-day window; days older than the window never count', async () => {
    await ensureCcuSchema();
    const insert = db.prepare('INSERT INTO ccu_daily_peak (day, peak, samples, updated_at) VALUES (?, ?, 1, ?)');
    insert.run(dayKey(NOW - 8 * DAY), 99, NOW - 8 * DAY); // outside the window
    insert.run(dayKey(NOW - 6 * DAY), 15, NOW - 6 * DAY);
    insert.run(dayKey(NOW), 7, NOW);
    expect(await readCcuPeak7d(NOW)).toBe(15);
    expect(await readCcuPeak7d(NOW - 7 * DAY)).toBe(99); // that day was in-window then
  });

  it('the hourly prune tick drops rows older than the retention bound', async () => {
    await ensureCcuSchema();
    const insert = db.prepare('INSERT INTO ccu_daily_peak (day, peak, samples, updated_at) VALUES (?, ?, 1, ?)');
    insert.run(dayKey(NOW - 40 * DAY), 50, NOW - 40 * DAY);
    insert.run(dayKey(NOW - 3 * DAY), 5, NOW - 3 * DAY);
    // The prune fires on the minute-of-hour-0 tick. Build this hour's :00
    // boundary from NOW's UTC parts, then tick once before it (no prune)
    // and once on it (prune).
    const parts = new Date(NOW);
    const hourStart = Date.UTC(parts.getUTCFullYear(), parts.getUTCMonth(), parts.getUTCDate(), parts.getUTCHours());
    const before = await sampleCcuPeak(new Date(hourStart - 60_000)); // HH-1:59 — not the :00 minute
    expect(before.pruned).toBe(false);
    const on = await sampleCcuPeak(new Date(hourStart)); // HH:00 — the prune tick
    expect(on.pruned).toBe(true);
    const days = (db.prepare('SELECT day FROM ccu_daily_peak ORDER BY day').all() as Array<{ day: string }>).map((r) => r.day);
    expect(days).not.toContain(dayKey(NOW - 40 * DAY)); // the out-of-bound row is gone
    expect(days).toContain(dayKey(NOW - 3 * DAY)); // recent history survives
  });
});
