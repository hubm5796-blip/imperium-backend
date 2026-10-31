/**
 * S2-D05 — the economy snapshot, against SEEDED data with known answers.
 *
 * These tests execute the module's REAL SQL: the fake D1 is the house
 * SQLite adapter (node:sqlite — the same dialect D1 speaks), so the
 * migration DDL, the upsert and the series read all run for real. The cron
 * leg runs against a game-MySQL mock, and the numbers are pinned by hand:
 *
 *   gini([0,100,300,600]) = 2*3500/(4*1000) - 5/4 = 0.5 exactly
 *   gini([1×9, 991])      = 2*9955/10000 - 11/10 ≈ 0.891 (> the 0.85 alert)
 *   four +60k issuance days over a 940k base = 240/940 ≈ 0.2553 (> +15%/week)
 *   a single faucet at 100% (> 25%) breaches the concentration alert
 *
 * Covered: pure math (gini/top1/split/shares), the daily row upsert (exact
 * numbers, cross-day net_delta chaining in oldest-first catch-up, idempotent
 * replay), breach marking (all three S2-D06 thresholds incl. the
 * history-seam base fallback), the snapshot/faucet endpoints (contract
 * shape, days validation, fail-closed admin gate), and migration parity.
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

const { claimResults, releaseLog, gameQueryMock } = vi.hoisted(() => ({
  claimResults: new Map<string, boolean>(),
  releaseLog: [] as string[],
  gameQueryMock: vi.fn(),
}));

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    getD1: vi.fn(() => d1FromDb()),
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
    release: vi.fn(async (key: string) => {
      releaseLog.push(key);
    }),
  };
});
vi.mock('../db/gameMysql.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/gameMysql.js')>();
  return { ...actual, gameQuery: gameQueryMock };
});

import { createApp } from '../app.js';
import { initEnvFromBindings, __resetEnvForTests } from '../env.js';
import { signJwt } from '../auth/jwt.js';
import {
  __resetEconomySchemaForTests,
  buildDailyRow,
  ECONOMY_THRESHOLDS,
  giniOf,
  getEconomyDailyRow,
  listEconomyDailyRows,
  markBreaches,
  saveEconomyDailyRow,
  sharesOf,
  snapshotPayload,
  splitFaucetsSinks,
  top1ShareOf,
  type EconomyDailyRow,
} from '../analytics/economy.js';
import { runAnalyticsDaily } from '../analytics/cronSync.js';

const BOT = { 'X-Bot-Token': 'test-bot-token' };
const ADMIN = { ...BOT, 'X-Staff-Role': 'admin' };
const HELPER = { ...BOT, 'X-Staff-Role': 'helper' };

/** The balance snapshot the game MySQL serves (live state, currency=denarius). */
const BALANCES: number[] = [600, 300, 100, 0];

let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  __resetEconomySchemaForTests();
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
  app = createApp();
  claimResults.clear();
  releaseLog.length = 0;
  txQueryOrder.length = 0;
  gameQueryMock.mockReset();
  gameQueryMock.mockImplementation(async (sql: string, params: readonly unknown[] = []) => {
    if (sql.includes('FROM currency_balances')) return BALANCES.map((balance) => ({ balance }));
    if (sql.includes('GROUP BY reason')) {
      const day = String(params[1] ?? '').slice(0, 10);
      txQueryOrder.push(day);
      return TXS.get(day) ?? [];
    }
    throw new Error(`unexpected gameQuery in economy test: ${sql.slice(0, 60)}`);
  });
});

/** Per-day faucet/sink fixtures keyed by the queried UTC day. The BALANCE
 *  snapshot is deliberately day-INDEPENDENT (game MySQL is live state): the
 *  supply/gini/top1 of every row is the measurement taken at fold time; only
 *  the transaction sums are day-scoped. */
const TXS = new Map<string, Array<{ reason: string; amount: number }>>([
  ['2026-09-17', [
    { reason: 'mining:sell', amount: 100 },
    { reason: 'crate:reward', amount: 50 },
    { reason: 'rank:cost', amount: -30 },
  ]],
  ['2026-09-16', [
    { reason: 'mining:sell', amount: 150 },
    { reason: 'rank:cost', amount: -50 },
  ]],
]);

/** The UTC days whose transaction sums were queried, in call order — the
 *  catch-up's oldest-first discipline is asserted against this. */
const txQueryOrder: string[] = [];

async function seedRow(row: EconomyDailyRow): Promise<void> {
  await saveEconomyDailyRow(row);
}

/* ── Pure math, known answers ─────────────────────────────────────────────── */

describe('S2-D05 economy math (known answers)', () => {
  it('gini: equal balances are 0, [0,100,300,600] is exactly 0.5, and concentration is (n-1)/n', () => {
    expect(giniOf([])).toBe(0);
    expect(giniOf([0])).toBe(0);
    expect(giniOf([7, 7, 7, 7])).toBe(0);
    // One holder owning everything among n holders scores (n-1)/n — 0.75 at
    // n=4, approaching 1 only as n grows (the standard population gini).
    expect(giniOf([0, 0, 0, 10])).toBeCloseTo(0.75, 10);
    expect(giniOf([0, 100, 300, 600])).toBeCloseTo(0.5, 10);
  });

  it('top1% share: ceil picks the single richest holder in a 40-holder economy', () => {
    expect(top1ShareOf([])).toBe(0);
    const forty = Array.from({ length: 40 }, (_, i) => i + 1); // sum 820
    expect(top1ShareOf(forty)).toBeCloseTo(40 / 820, 10); // ceil(0.4)=1 → the 40-holder
    expect(top1ShareOf([5, 5])).toBeCloseTo(0.5, 10);
  });

  it('faucet/sink split keeps raw magnitudes and never mixes signs', () => {
    const split = splitFaucetsSinks([
      { reason: 'mining:sell', amount: 100 },
      { reason: 'crate:reward', amount: 50 },
      { reason: 'rank:cost', amount: -80 },
      { reason: 'enchant:cost', amount: -20 },
      { reason: 'zero:noop', amount: 0 },
    ]);
    expect(Object.fromEntries(split.issuance)).toEqual({ 'mining:sell': 100, 'crate:reward': 50 });
    expect(Object.fromEntries(split.drain)).toEqual({ 'rank:cost': 80, 'enchant:cost': 20 });
    expect(split.issuedTotal).toBe(150);
    expect(split.drainedTotal).toBe(100);
  });

  it('shares sum to 1 and an empty total yields an empty object (never NaN)', () => {
    const shares = sharesOf(new Map([['a', 100], ['b', 50]]));
    expect(shares.a).toBeCloseTo(2 / 3, 10);
    expect(shares.b).toBeCloseTo(1 / 3, 10);
    expect(sharesOf(new Map())).toEqual({});
  });

  it('buildDailyRow: net_delta is the day change over the previous supply, 0 on the first day', () => {
    const row = buildDailyRow('2026-09-17', [600, 300, 100, 0], [
      { reason: 'mining:sell', amount: 100 },
      { reason: 'crate:reward', amount: 50 },
      { reason: 'rank:cost', amount: -30 },
    ], 1000);
    expect(row.total_supply).toBe(1000);
    expect(row.holder_count).toBe(4);
    expect(row.gini).toBeCloseTo(0.5, 10);
    expect(row.top1_share).toBeCloseTo(0.6, 10);
    expect(row.issued_total).toBe(150);
    expect(row.drained_total).toBe(30);
    expect(row.net_delta_abs).toBe(120);
    expect(row.net_delta).toBeCloseTo(0.12, 10);

    expect(buildDailyRow('2026-09-16', [500, 500], [], null).net_delta).toBe(0);
    expect(buildDailyRow('2026-09-16', [500, 500], [], 0).net_delta).toBe(0); // zero base guards div/0
  });

  it('the alert thresholds are the documented S2-D06 values', () => {
    expect(ECONOMY_THRESHOLDS).toEqual({ gini_max: 0.85, weekly_net_delta_max: 0.15, faucet_share_max: 0.25 });
  });
});

/* ── Cron leg: the stored daily row ───────────────────────────────────────── */

describe('S2-D05 cron leg — the day is aggregated ONCE into a stored row', () => {
  it('stores one row per claimed day with the exact known numbers', async () => {
    const report = await runAnalyticsDaily(new Date('2026-09-18T00:06:30Z'));
    expect(report.economy.ran).toBe(true);
    expect(report.economy.day).toBe('2026-09-17');
    // The catch-up folds OLDEST-first (09-11 → 09-17): a net_delta chain
    // needs the previous day's row to exist before the next day computes.
    expect(txQueryOrder).toEqual([
      '2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17',
    ]);

    const count = Number(db.prepare('SELECT COUNT(*) AS n FROM economy_daily_row').get()!.n);
    expect(count).toBe(7); // the full catch-up window (most days legitimately empty)

    const day17 = await getEconomyDailyRow('2026-09-17');
    expect(day17).not.toBeNull();
    expect(day17!.total_supply).toBe(1000);
    expect(day17!.holder_count).toBe(4);
    expect(day17!.gini).toBeCloseTo(0.5, 10);
    expect(day17!.top1_share).toBeCloseTo(0.6, 10);
    expect(day17!.issued_total).toBe(150);
    expect(day17!.drained_total).toBe(30);
    expect(day17!.net_delta_abs).toBe(120);
    // Stored net_delta is the day's net issuance FLOW over the previous
    // stored supply: +120 net issuance over 09-16's measured 1000 = 0.12.
    // (09-16 was folded first — oldest-first catch-up — so its row existed.)
    expect(day17!.net_delta).toBeCloseTo(0.12, 10);
    expect(day17!.issuance_by_faucet).toEqual({ 'mining:sell': 100, 'crate:reward': 50 });
    expect(day17!.drain_by_sink).toEqual({ 'rank:cost': 30 });

    const day16 = await getEconomyDailyRow('2026-09-16');
    expect(day16!.total_supply).toBe(1000);
    expect(day16!.gini).toBeCloseTo(0.5, 10); // the same live snapshot
    expect(day16!.net_delta_abs).toBe(100);
    expect(day16!.net_delta).toBeCloseTo(0.1, 10); // +100 net over 09-15's supply 1000
    expect(day16!.issued_total).toBe(150);
    expect(day16!.drained_total).toBe(50);
  });

  it('a replayed day upserts (never duplicates); taken claims rewrite nothing', async () => {
    await runAnalyticsDaily(new Date('2026-09-18T00:06:30Z'));
    const strip = (rows: Record<string, unknown>[]) =>
      rows.map((r) => {
        const { computed_at, ...rest } = r;
        void computed_at;
        return rest;
      });
    const before = strip(db.prepare('SELECT * FROM economy_daily_row ORDER BY day').all() as Record<string, unknown>[]);

    // The next minute: every claim already taken — nothing rewrites.
    for (let back = 1; back <= 7; back += 1) {
      const d = new Date('2026-09-18T00:07:00Z');
      d.setUTCDate(d.getUTCDate() - back);
      claimResults.set(`analytics-econ:${d.toISOString().slice(0, 10)}`, false);
    }
    const second = await runAnalyticsDaily(new Date('2026-09-18T00:07:00Z'));
    expect(second.economy.ran).toBe(false);

    // A forced re-claim replays into the SAME rows (ON CONFLICT DO UPDATE).
    claimResults.clear();
    await runAnalyticsDaily(new Date('2026-09-18T00:08:00Z'));
    const after = strip(db.prepare('SELECT * FROM economy_daily_row ORDER BY day').all() as Record<string, unknown>[]);
    expect(after).toHaveLength(before.length);
    expect(after).toEqual(before);
  });

  it('a game-MySQL failure releases the day claim and reports the error (retry next tick)', async () => {
    await listEconomyDailyRows(1); // ensure the schema exists for the empty-rows assertion
    gameQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM currency_balances')) throw new Error('game-mysql unavailable: socket died');
      return [];
    });
    const report = await runAnalyticsDaily(new Date('2026-09-18T00:06:30Z'));
    expect(report.economy.ran).toBe(false);
    expect(report.economy.error).toContain('socket died');
    expect(releaseLog).toContain('analytics-econ:2026-09-11'); // oldest candidate, released for retry
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM economy_daily_row').get()!.n)).toBe(0);
  });

  it('no-ops outside the 00:06–00:59 UTC window without touching the game DB', async () => {
    const report = await runAnalyticsDaily(new Date('2026-09-18T12:01:00Z'));
    expect(report.economy.ran).toBe(false);
    expect(gameQueryMock.mock.calls).toHaveLength(0);
  });

  it('is reachable from a real cron pass: runBotCron inside the window folds the day', async () => {
    const { runBotCron } = await import('../bot/cron.js');
    const report = await runBotCron(new Date('2026-09-18T00:07:00Z'));
    expect(report.analytics.economy.ran).toBe(true);
    expect(report.analytics.economy.day).toBe('2026-09-17');
    expect(Number(db.prepare('SELECT COUNT(*) AS n FROM economy_daily_row').get()!.n)).toBe(7);
    const day17 = await getEconomyDailyRow('2026-09-17');
    expect(day17!.net_delta_abs).toBe(120);
  });

  it('runBotCron outside the window leaves the analytics report untouched', async () => {
    const { runBotCron } = await import('../bot/cron.js');
    const report = await runBotCron(new Date('2026-09-18T12:07:00Z'));
    expect(report.analytics).toEqual({
      economy: { ran: false, day: null },
      retention: { ran: false, players: 0, days: 0, churn_events: 0 }, // churn_events: S2-C13 rider field
    });
    expect(gameQueryMock.mock.calls).toHaveLength(0);
  });
});

/* ── Breach marking (S2-D06 consumes these) ───────────────────────────────── */

describe('S2-D06 breach booleans computed from stored rows', () => {
  it('the +15% weekly alert: 4 × +60k days over a 940k base = 0.2553 > 0.15', async () => {
    for (let i = 0; i < 4; i += 1) {
      const day = `2026-09-${11 + i}`;
      const supply = 940_000 + 60_000 * (i + 1);
      await seedRow({
        day,
        total_supply: supply,
        holder_count: 10,
        gini: 0.4,
        top1_share: 0.3,
        issued_total: 60_000,
        drained_total: 0,
        issuance_by_faucet: { 'mining:sell': 60_000 },
        drain_by_sink: {},
        net_delta_abs: 60_000,
        net_delta: i === 0 ? 0 : 60_000 / (940_000 + 60_000 * i),
      });
    }
    const breaches = markBreaches(await listEconomyDailyRows(90));
    // Window bases: no row precedes 09-11, so the base is reconstructed as
    // 1,000,000 - 60,000 = 940,000 (end-of-day minus its own delta).
    expect(breaches[0]!.net_delta).toBe(false); //  60/940 = 0.064
    expect(breaches[1]!.net_delta).toBe(false); // 120/940 = 0.128
    expect(breaches[2]!.net_delta).toBe(true);  // 180/940 = 0.191
    expect(breaches[3]!.net_delta).toBe(true);  // 240/940 = 0.255
    expect(breaches[3]!.weekly_net_delta).toBeCloseTo(240_000 / 940_000, 6);
    expect(breaches[2]!.weekly_net_delta).toBeCloseTo(180_000 / 940_000, 6);
  });

  it('a single faucet at 100% breaches the 25% concentration alert with the key named', async () => {
    await seedRow({
      day: '2026-09-20', total_supply: 1000, holder_count: 2, gini: 0.1, top1_share: 0.6,
      issued_total: 100, drained_total: 0,
      issuance_by_faucet: { 'mining:sell': 100 }, drain_by_sink: {},
      net_delta_abs: 100, net_delta: 0,
    });
    const breaches = markBreaches(await listEconomyDailyRows(90));
    expect(breaches[0]!.faucet).toBe(true);
    expect(breaches[0]!.faucet_offenders).toEqual(['mining:sell']);
  });

  it('an even four-way split (exactly 25% each) does NOT breach (strict >)', async () => {
    await seedRow({
      day: '2026-09-21', total_supply: 1000, holder_count: 2, gini: 0.1, top1_share: 0.6,
      issued_total: 100, drained_total: 0,
      issuance_by_faucet: { a: 25, b: 25, c: 25, d: 25 }, drain_by_sink: {},
      net_delta_abs: 100, net_delta: 0,
    });
    const breaches = markBreaches(await listEconomyDailyRows(90));
    expect(breaches[0]!.faucet).toBe(false);
    expect(breaches[0]!.faucet_offenders).toEqual([]);
  });

  it('the gini alert: a 10-holder whale economy (0.891) breaches; an equal one does not', async () => {
    const whale = [1, 1, 1, 1, 1, 1, 1, 1, 1, 991];
    await seedRow({
      day: '2026-09-20', total_supply: 1000, holder_count: 10, gini: giniOf(whale), top1_share: 0.991,
      issued_total: 0, drained_total: 0, issuance_by_faucet: {}, drain_by_sink: {},
      net_delta_abs: 0, net_delta: 0,
    });
    await seedRow({
      day: '2026-09-21', total_supply: 1000, holder_count: 10,
      gini: giniOf(Array.from({ length: 10 }, () => 100)), top1_share: 0.1,
      issued_total: 0, drained_total: 0, issuance_by_faucet: {}, drain_by_sink: {},
      net_delta_abs: 0, net_delta: 0,
    });
    expect(giniOf(whale)).toBeGreaterThan(0.85); // the fixture really is above the ceiling
    const breaches = markBreaches(await listEconomyDailyRows(90));
    expect(breaches[0]!.gini).toBe(true);
    expect(breaches[1]!.gini).toBe(false);
  });
});

/* ── The route: gate + contract shape ─────────────────────────────────────── */

describe('GET /api/v2/admin/economy/snapshot', () => {
  beforeEach(async () => {
    // Four growth days (+60k/day from one faucet), the last upserted again
    // with a two-faucet shape (proves the ON CONFLICT rewrite path).
    const growth: Array<[string, number, number]> = [
      // [day, supply, flow ratio over the previous stored supply]
      ['2026-09-11', 1_000_000, 0], // first stored day: no previous supply
      ['2026-09-12', 1_060_000, 60_000 / 1_000_000],
      ['2026-09-13', 1_120_000, 60_000 / 1_060_000],
      ['2026-09-14', 1_180_000, 60_000 / 1_120_000],
    ];
    for (const [day, supply, netDelta] of growth) {
      await seedRow({
        day, total_supply: supply, holder_count: 10, gini: 0.4, top1_share: 0.3,
        issued_total: 60_000, drained_total: 0,
        issuance_by_faucet: { 'mining:sell': 60_000 }, drain_by_sink: {},
        net_delta_abs: 60_000, net_delta: netDelta,
      });
    }
    await seedRow({
      day: '2026-09-14', total_supply: 1_180_000, holder_count: 10, gini: 0.4, top1_share: 0.3,
      issued_total: 60_000, drained_total: 0,
      issuance_by_faucet: { 'mining:sell': 50_000, 'crate:reward': 10_000 }, drain_by_sink: {},
      net_delta_abs: 60_000, net_delta: 60_000 / 1_120_000, // flow over 09-13's stored supply
    });
  });

  it('the fail-closed admin gate: anonymous 401, helper 403, admin 200', async () => {
    expect((await app.request('/api/v2/admin/economy/snapshot')).status).toBe(401);
    expect((await app.request('/api/v2/admin/economy/snapshot', { headers: HELPER })).status).toBe(403);
    expect((await app.request('/api/v2/admin/economy/snapshot', { headers: ADMIN })).status).toBe(200);
  });

  it('a staff session (JWT staffRole claim) also passes the gate', async () => {
    const jwt = await signJwt({ authMethod: 'discord', discordId: '111111111111111111', staffRole: 'admin' });
    const res = await app.request('/api/v2/admin/economy/snapshot', {
      headers: { Cookie: `imperium_session=${jwt}` },
    });
    expect(res.status).toBe(200);
  });

  it('serves the contract shape: as_of, ascending series, thresholds, shares summing to 1', async () => {
    const res = await app.request('/api/v2/admin/economy/snapshot?days=90', { headers: ADMIN });
    expect(res.status).toBe(200);
    const json = (await res.json()) as ReturnType<typeof snapshotPayload>;
    expect(json.as_of).toBe('2026-09-14');
    expect(json.thresholds).toEqual({ gini_max: 0.85, weekly_net_delta_max: 0.15, faucet_share_max: 0.25 });
    expect(json.series.map((s) => s.date)).toEqual(['2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14']);
    // net_delta served from the stored flow ratio (day's net issuance over
    // the previous stored supply — the fixture chain is consistent, so the
    // flow ratio and the supply-chain ratio agree):
    expect(json.series[1]!.net_delta).toBeCloseTo(60_000 / 1_000_000, 10);
    expect(json.series[3]!.net_delta).toBeCloseTo(60_000 / 1_120_000, 10);
    expect(json.series[0]!.net_delta).toBe(0); // the first stored day has no previous supply
    // shares sum to 1:
    const shares = Object.values(json.series[3]!.issuance_by_faucet);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    // breaches on the latest day: faucet concentration + weekly growth
    const last = json.series[3]!.breaches;
    expect(last.faucet).toBe(true);
    expect(last.faucet_offenders).toEqual(['mining:sell']); // 50k of the 60k day
    expect(last.net_delta).toBe(true);
    expect(last.weekly_net_delta).toBeCloseTo(240_000 / 940_000, 6);
    expect(json.series[0]!.breaches.faucet).toBe(true); // 100% single faucet
    expect(json.series[0]!.breaches.net_delta).toBe(false); // 60k/940k = 0.064 < 0.15
  });

  it('limits the series with ?days= and rejects junk', async () => {
    const limited = await app.request('/api/v2/admin/economy/snapshot?days=2', { headers: ADMIN });
    const json = (await limited.json()) as { series: unknown[]; as_of: string | null };
    expect(json.series).toHaveLength(2);
    expect(json.as_of).toBe('2026-09-14');
    expect((await app.request('/api/v2/admin/economy/snapshot?days=junk', { headers: ADMIN })).status).toBe(400);
    expect((await app.request('/api/v2/admin/economy/snapshot?days=0', { headers: ADMIN })).status).toBe(400);
    expect((await app.request('/api/v2/admin/economy/snapshot?days=366', { headers: ADMIN })).status).toBe(400);
  });

  it('an empty economy is an honest empty payload, not an error', async () => {
    await getEconomyDailyRow('2026-09-11'); // ensure schema exists in this fresh db
    db.exec('DELETE FROM economy_daily_row');
    const res = await app.request('/api/v2/admin/economy/snapshot', { headers: ADMIN });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ as_of: null, series: [] });
  });
});

describe('GET /api/v2/admin/economy/faucets', () => {
  it('rolls the 7-day issuance per reason with share and breach-day counts', async () => {
    for (const [day, byFaucet] of [
      ['2026-09-11', { 'mining:sell': 60_000 }],
      ['2026-09-12', { 'mining:sell': 60_000 }],
      ['2026-09-13', { 'mining:sell': 60_000 }],
      ['2026-09-14', { 'mining:sell': 50_000, 'crate:reward': 10_000 }],
    ] as const) {
      await seedRow({
        day, total_supply: 1_000_000, holder_count: 10, gini: 0.4, top1_share: 0.3,
        issued_total: Object.values(byFaucet).reduce((a, b) => a + b, 0), drained_total: 0,
        issuance_by_faucet: { ...byFaucet }, drain_by_sink: {},
        net_delta_abs: 60_000, net_delta: 0,
      });
    }
    const res = await app.request('/api/v2/admin/economy/faucets', { headers: ADMIN });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      issued_total_7d: number;
      faucets: Array<{ faucet: string; issued_7d: number; share_7d: number | null; registry_ceiling: unknown; breach_days: number }>;
    };
    expect(json.issued_total_7d).toBe(240_000);
    const mining = json.faucets.find((f) => f.faucet === 'mining:sell')!;
    expect(mining.issued_7d).toBe(230_000);
    expect(mining.share_7d).toBeCloseTo(230_000 / 240_000, 6);
    expect(mining.breach_days).toBe(4); // above the 25% ceiling every day
    expect(mining.registry_ceiling).toBeNull(); // Lane A's registry is the authority; not built yet
    const crate = json.faucets.find((f) => f.faucet === 'crate:reward')!;
    expect(crate.issued_7d).toBe(10_000);
    expect(crate.breach_days).toBe(0);
    expect((await app.request('/api/v2/admin/economy/faucets', { headers: HELPER })).status).toBe(403);
  });
});

/* ── Migration parity ─────────────────────────────────────────────────────── */

describe('d1_0006 migration parity', () => {
  it('the store schema matches the migration DDL column-for-column', async () => {
    await listEconomyDailyRows(1); // triggers lazy ensure
    const migration = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations', 'd1_0006_analytics.sql'),
      'utf8',
    );
    const block = migration.slice(migration.indexOf('CREATE TABLE IF NOT EXISTS economy_daily_row'));
    const ddlCols = [...block.slice(0, block.indexOf(');')).matchAll(/^\s{2}(\w+)\s/gm)]
      .map((m) => m[1]!)
      .filter((name) => !['PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN', 'CONSTRAINT'].includes(name));
    const dbCols = (
      db.prepare("SELECT name FROM pragma_table_info('economy_daily_row') ORDER BY cid").all() as { name: string }[]
    ).map((c) => c.name);
    expect(ddlCols).toEqual(dbCols);
    expect(ddlCols).toContain('net_delta');
    expect(ddlCols).toContain('issuance_by_faucet');
  });
});
