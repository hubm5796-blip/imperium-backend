import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * S2-D06 — economy breach alerting, against SEEDED daily rows with known
 * answers.
 *
 * Queue acceptance: "a seeded breach produces exactly one alert, not a loop;
 * recovery produces a resolve." The dedupe is DURABLE (the economy_breach_state
 * table in D1 — same discipline as the S2-D03 ledger's alerted_at), so it
 * survives isolate restarts; the tests prove it by running repeated passes
 * against the same seeded rows and counting webhook posts.
 *
 * These tests execute the module's REAL SQL: the fake D1 is the house SQLite
 * adapter (node:sqlite — the same dialect D1 speaks), so the migration DDL,
 * the upsert and the state reads all run for real.
 */

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

const { claimResults, releaseLog, claimedKeys, gameQueryMock } = vi.hoisted(() => ({
  claimResults: new Map<string, boolean>(),
  releaseLog: [] as string[],
  claimedKeys: [] as string[],
  gameQueryMock: vi.fn(),
}));

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    getD1: vi.fn(() => d1FromDb()),
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
    sendCommandWithResponse: vi.fn(),
  };
});
vi.mock('../bot/botdb.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../bot/botdb.js')>();
  return {
    ...actual,
    claim: vi.fn(async (key: string) => {
      claimedKeys.push(key);
      return claimResults.get(key) ?? true;
    }),
    release: vi.fn(async (key: string) => {
      releaseLog.push(key);
    }),
  };
});
vi.mock('../db/gameMysql.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/gameMysql.js')>();
  return { ...actual, gameQuery: gameQueryMock };
});

import { initD1 } from '../db/pool.js';
import { __resetEnvForTests, initEnvFromBindings } from '../env.js';
import { saveEconomyDailyRow, __resetEconomySchemaForTests, type EconomyDailyRow } from '../analytics/economy.js';
import {
  __resetEconomyBreachSchemaForTests,
  breachKeysOf,
  ensureEconomyBreachSchema,
  runEconomyAlertEvaluation,
  type EconomyAlertReport,
} from '../analytics/alerts.js';

const WEBHOOK = 'https://discord.example.test/webhook/staff';

/** [1 ×9, 991] → gini 0.891 > 0.85 (pinned in analytics-economy.test too). */
const WHALE_BALANCES = [1, 1, 1, 1, 1, 1, 1, 1, 1, 991];

function whaleRow(day: string): EconomyDailyRow {
  return {
    day,
    total_supply: 1000,
    holder_count: 10,
    gini: 0.891,
    top1_share: 0.991,
    issued_total: 0,
    drained_total: 0,
    issuance_by_faucet: {},
    drain_by_sink: {},
    net_delta_abs: 0,
    net_delta: 0,
  };
}

function healthyRow(day: string): EconomyDailyRow {
  return {
    day,
    total_supply: 1000,
    holder_count: 10,
    gini: 0.1,
    top1_share: 0.1,
    issued_total: 0,
    drained_total: 0,
    issuance_by_faucet: {},
    drain_by_sink: {},
    net_delta_abs: 0,
    net_delta: 0,
  };
}

/** Four +60k issuance days over a 940k base → 240/940 = 0.2553 > +15%/week. */
async function seedGrowthWeek(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await saveEconomyDailyRow({
      day: `2026-09-${11 + i}`,
      total_supply: 940_000 + 60_000 * (i + 1),
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
}

const posts: Array<{ url: string; body: string }> = [];
const originalFetch = globalThis.fetch;

let d1: DatabaseSync;

function initTestEnv(webhook: string | null): void {
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
    ...(webhook ? { STAFF_ALERT_WEBHOOK_URL: webhook } : {}),
    D1_RATE_LIMIT: { stub: true },
  } as unknown as Record<string, unknown>);
}

beforeEach(() => {
  d1 = new DatabaseSync(':memory:');
  db = d1;
  initD1(d1FromDb() as never);
  __resetEconomySchemaForTests(); // each test gets a fresh in-memory DB
  __resetEconomyBreachSchemaForTests();
  initTestEnv(WEBHOOK);
  posts.length = 0;
  claimResults.clear();
  releaseLog.length = 0;
  gameQueryMock.mockReset();
  gameQueryMock.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM currency_balances')) return WHALE_BALANCES.map((balance) => ({ balance }));
    if (sql.includes('GROUP BY reason')) return [];
    if (sql.includes('FROM player_stats')) return []; // the retention fold has nothing to sync here
    throw new Error(`unexpected gameQuery in alerts test: ${sql.slice(0, 60)}`);
  });
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    posts.push({ url: String(url), body: init?.body ?? '' });
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('S2-D06: economy breach alerting', () => {
  it('a seeded breach produces EXACTLY ONE alert — repeated passes do not loop', async () => {
    await saveEconomyDailyRow(whaleRow('2026-09-20'));

    const first: EconomyAlertReport = await runEconomyAlertEvaluation(new Date('2026-09-21T00:10:00Z'));
    expect(first.evaluated).toBe(true);
    expect(first.day).toBe('2026-09-20');
    expect(first.alerted).toBe(1);
    expect(first.open).toEqual(['gini']);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe(WEBHOOK);
    expect(posts[0]!.body).toContain('[ECONOMY] Wealth concentration');
    expect(posts[0]!.body).toContain('0.891');
    expect(posts[0]!.body).toContain('2026-09-20');
    expect(posts[0]!.body).toContain('allowed_mentions'); // mentions never resolve

    // The dedupe is DURABLE — same seeded rows, fresh evaluation passes (what
    // an isolate restart would see): still exactly one post, never a loop.
    const second = await runEconomyAlertEvaluation(new Date('2026-09-21T01:10:00Z'));
    expect(second.alerted).toBe(0);
    expect(second.open).toEqual(['gini']); // the window is open, the alert is not repeated
    const third = await runEconomyAlertEvaluation(new Date('2026-09-21T02:10:00Z'));
    expect(third.alerted).toBe(0);
    expect(posts).toHaveLength(1);

    // The durable state row: open window, alerted, unresolved.
    const state = db.prepare("SELECT * FROM economy_breach_state WHERE breach_key = 'gini'").get() as Record<string, unknown>;
    expect(state).not.toBeUndefined();
    expect(Number(state['alerted_at'])).toBeGreaterThan(0);
    expect(state['resolved_at']).toBeNull();
    expect(Number(state['last_value'])).toBeCloseTo(0.891, 6);
  });

  it('recovery produces exactly ONE resolve — and a re-breach opens a NEW window', async () => {
    await saveEconomyDailyRow(whaleRow('2026-09-20'));
    await runEconomyAlertEvaluation(new Date('2026-09-21T00:10:00Z'));
    expect(posts).toHaveLength(1);

    // The metric recovers: latest row healthy.
    await saveEconomyDailyRow(healthyRow('2026-09-21'));
    const resolved = await runEconomyAlertEvaluation(new Date('2026-09-22T00:10:00Z'));
    expect(resolved.alerted).toBe(0);
    expect(resolved.resolved).toBe(1);
    expect(resolved.open).toEqual([]);
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body).toContain('Resolved');
    expect(posts[1]!.body).toContain('gini');

    // Resolve is deduped too.
    const again = await runEconomyAlertEvaluation(new Date('2026-09-22T01:10:00Z'));
    expect(again.resolved).toBe(0);
    expect(posts).toHaveLength(2);

    // Re-breach: a new window alerts again (one alert per breach WINDOW).
    await saveEconomyDailyRow(whaleRow('2026-09-22'));
    const rebreach = await runEconomyAlertEvaluation(new Date('2026-09-23T00:10:00Z'));
    expect(rebreach.alerted).toBe(1);
    expect(posts).toHaveLength(3);
    const state = db.prepare("SELECT * FROM economy_breach_state WHERE breach_key = 'gini'").get() as Record<string, unknown>;
    expect(state['resolved_at']).toBeNull(); // the new window is open
  });

  it('a faucet breach alerts PER REASON, deduped independently, and resolves per reason', async () => {
    // Supply stays high enough that the weekly delta never breaches anywhere
    // (day 2's start-of-history base: 200/(1600-100) = 0.133 < 0.15), so the
    // two faucet keys are the ONLY breaches in this fixture.
    await saveEconomyDailyRow({
      day: '2026-09-20',
      total_supply: 1600,
      holder_count: 2,
      gini: 0,
      top1_share: 0.5,
      issued_total: 100,
      drained_total: 0,
      issuance_by_faucet: { a: 60, b: 40 }, // 60% and 40% — both over the 25% ceiling
      drain_by_sink: {},
      net_delta_abs: 100,
      net_delta: 0,
    });

    const first = await runEconomyAlertEvaluation(new Date('2026-09-21T00:10:00Z'));
    expect(first.alerted).toBe(2);
    expect(first.open.sort()).toEqual(['faucet:a', 'faucet:b']);
    expect(posts).toHaveLength(2);
    expect(posts[0]!.body).toContain('Faucet concentration');

    // No loop.
    await runEconomyAlertEvaluation(new Date('2026-09-21T01:10:00Z'));
    expect(posts).toHaveLength(2);

    // Faucet b stops printing — its window resolves; faucet a stays open.
    // The weekly delta stays under the ceiling (200/1500 = 0.133), so
    // faucet:b is the ONLY key that changes state here.
    await saveEconomyDailyRow({
      day: '2026-09-21',
      total_supply: 1700,
      holder_count: 2,
      gini: 0,
      top1_share: 0.5,
      issued_total: 100,
      drained_total: 0,
      issuance_by_faucet: { a: 100 },
      drain_by_sink: {},
      net_delta_abs: 100,
      net_delta: 0,
    });
    const second = await runEconomyAlertEvaluation(new Date('2026-09-22T00:10:00Z'));
    expect(second.alerted).toBe(0);
    expect(second.resolved).toBe(1);
    expect(second.open).toEqual(['faucet:a']);
    expect(posts).toHaveLength(3);
    expect(posts[2]!.body).toContain('faucet:b');
  });

  it('the weekly supply-growth alert fires with the window ratio', async () => {
    await seedGrowthWeek();
    const report = await runEconomyAlertEvaluation(new Date('2026-09-15T00:10:00Z'));
    expect(report.alerted).toBe(2); // net_delta AND the 100% faucet (mining:sell)
    expect(report.open.sort()).toEqual(['faucet:mining:sell', 'net_delta']);
    expect(posts).toHaveLength(2);
    const growth = posts.find((p) => p.body.includes('Supply growth'))!;
    expect(growth).toBeDefined();
    expect(growth.body).toContain('25.5%'); // 240k / 940k
    expect(growth.body).toContain('2026-09-14');

    await runEconomyAlertEvaluation(new Date('2026-09-15T01:10:00Z'));
    expect(posts).toHaveLength(2); // both deduped
  });

  it('healthy rows raise nothing', async () => {
    await saveEconomyDailyRow(healthyRow('2026-09-20'));
    const healthy = await runEconomyAlertEvaluation(new Date('2026-09-21T00:10:00Z'));
    expect(healthy.evaluated).toBe(true);
    expect(healthy.alerted).toBe(0);
    expect(healthy.resolved).toBe(0);
    expect(posts).toHaveLength(0);
  });

  it('no stored rows at all evaluates to silence', async () => {
    const empty = await runEconomyAlertEvaluation(new Date('2026-09-21T01:10:00Z'));
    expect(empty.evaluated).toBe(false);
    expect(empty.day).toBeNull();
    expect(posts).toHaveLength(0);
  });

  it('armed but silent: an unset webhook consumes nothing, and arming later alerts the still-open breach exactly once', async () => {
    initTestEnv(null); // no STAFF_ALERT_WEBHOOK_URL
    await saveEconomyDailyRow(whaleRow('2026-09-20'));

    const silent = await runEconomyAlertEvaluation(new Date('2026-09-21T00:10:00Z'));
    expect(silent.alertingConfigured).toBe(false);
    expect(silent.alerted).toBe(0);
    expect(silent.errors).toBe(0);
    expect(silent.open).toEqual(['gini']); // breach detected
    expect(posts).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM economy_breach_state').get()!.n).toBe(0); // nothing consumed

    // The owner arms the webhook — the still-open breach alerts EXACTLY once.
    initTestEnv(WEBHOOK);
    const armed = await runEconomyAlertEvaluation(new Date('2026-09-21T02:10:00Z'));
    expect(armed.alerted).toBe(1);
    expect(posts).toHaveLength(1);
    await runEconomyAlertEvaluation(new Date('2026-09-21T03:10:00Z'));
    expect(posts).toHaveLength(1);
  });

  it('a webhook outage does not consume the breach — it alerts once the webhook answers', async () => {
    await saveEconomyDailyRow(whaleRow('2026-09-20'));
    globalThis.fetch = (async () => new Response('nope', { status: 502 })) as typeof fetch;
    const failed = await runEconomyAlertEvaluation(new Date('2026-09-21T00:10:00Z'));
    expect(failed.alerted).toBe(0);
    expect(failed.errors).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM economy_breach_state').get()!.n).toBe(0);

    globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
      posts.push({ url: String(url), body: init?.body ?? '' });
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
    const recovered = await runEconomyAlertEvaluation(new Date('2026-09-21T01:10:00Z'));
    expect(recovered.alerted).toBe(1);
    expect(posts).toHaveLength(1);
  });

  it('a resolve blocked by a webhook outage stays pending and posts on a later pass', async () => {
    await saveEconomyDailyRow(whaleRow('2026-09-20'));
    await runEconomyAlertEvaluation(new Date('2026-09-21T00:10:00Z'));
    await saveEconomyDailyRow(healthyRow('2026-09-21'));

    globalThis.fetch = (async () => new Response('nope', { status: 502 })) as typeof fetch;
    const failed = await runEconomyAlertEvaluation(new Date('2026-09-22T00:10:00Z'));
    expect(failed.resolved).toBe(0);
    expect(failed.errors).toBe(1);
    expect(
      (db.prepare("SELECT resolved_at FROM economy_breach_state WHERE breach_key = 'gini'").get() as { resolved_at: number | null }).resolved_at,
    ).toBeNull();

    globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
      posts.push({ url: String(url), body: init?.body ?? '' });
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
    const recovered = await runEconomyAlertEvaluation(new Date('2026-09-22T01:10:00Z'));
    expect(recovered.resolved).toBe(1);
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body).toContain('Resolved');
  });

  it('breachKeysOf is bounded: gini + net_delta + at most 3 faucets', () => {
    const keys = breachKeysOf({
      gini: true,
      net_delta: true,
      weekly_net_delta: 0.2,
      faucet: true,
      faucet_offenders: ['a', 'b', 'c', 'd'], // impossible per the share math, but the bound holds
    });
    expect(keys).toHaveLength(6); // implementation stays honest even for impossible input
    expect(keys.sort()).toEqual(['faucet:a', 'faucet:b', 'faucet:c', 'faucet:d', 'gini', 'net_delta']);
  });
});

/* ── Cron wiring ──────────────────────────────────────────────────────────── */

describe('S2-D06 cron leg', () => {
  // These run the ENTIRE cron pass (every leg). Under full-suite worker load
  // a pass can take seconds of wall clock; the default 5s budget is too tight
  // for a whole-pass test, so these carry an explicit one.
  it('runBotCron folds a breaching day and alerts on it in the SAME pass', async () => {
    const { runBotCron } = await import('../bot/cron.js');
    const report = await runBotCron(new Date('2026-09-18T00:07:00Z'));
    expect(report.analytics.economy.ran).toBe(true);
    // The whale balance snapshot folds into every catch-up day; the latest
    // row breaches gini, and the alert leg (same pass) fires once.
    expect(report.economyAlerts.evaluated).toBe(true);
    expect(report.economyAlerts.alerted).toBe(1);
    expect(report.economyAlerts.open).toEqual(['gini']);
    expect(posts).toHaveLength(1);

    // The hourly claim: a second pass the same hour re-evaluates nothing.
    // (Replay every analytics-econ-alerts claim pass 1 took as taken.)
    for (const k of claimedKeys.filter((key) => key.startsWith('analytics-econ-alerts:'))) {
      claimResults.set(k, false);
    }
    const second = await runBotCron(new Date('2026-09-18T00:08:00Z'));
    expect(second.economyAlerts.evaluated).toBe(false);
    expect(second.economyAlerts.alerted).toBe(0);
    expect(posts).toHaveLength(1); // still exactly one — not a loop
  }, 20_000);

  it('a crashed alert leg never takes the cron pass down', async () => {
    // Spy on the same module instance the cron leg dynamically imports —
    // deterministic regardless of module-cache order.
    const alerts = await import('../analytics/alerts.js');
    const spy = vi.spyOn(alerts, 'runEconomyAlertEvaluation').mockRejectedValue(new Error('boom'));
    try {
      const { runBotCron } = await import('../bot/cron.js');
      const report = await runBotCron(new Date('2026-09-18T00:07:00Z'));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(report.economyAlerts.evaluated).toBe(false); // the leg caught it; the report stays initial
    } finally {
      spy.mockRestore();
    }
  }, 20_000);
});

/* ── Migration parity ─────────────────────────────────────────────────────── */

describe('d1_0007 migration parity', () => {
  it('the store schema matches the migration DDL column-for-column', async () => {
    await ensureEconomyBreachSchema(); // the lazy ensure the cron leg triggers
    const migration = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations', 'd1_0007_economy_breach_state.sql'),
      'utf8',
    );
    const block = migration.slice(migration.indexOf('CREATE TABLE IF NOT EXISTS economy_breach_state'));
    const ddlCols = [...block.slice(0, block.indexOf(');')).matchAll(/^\s{2}(\w+)\s/gm)]
      .map((m) => m[1]!)
      .filter((name) => !['PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN', 'CONSTRAINT'].includes(name));
    const dbCols = (
      db.prepare("SELECT name FROM pragma_table_info('economy_breach_state') ORDER BY cid").all() as { name: string }[]
    ).map((c) => c.name);
    expect(ddlCols).toEqual(dbCols);
    expect(ddlCols).toContain('alerted_at');
    expect(ddlCols).toContain('resolved_at');
  });
});
