/**
 * S2-D08 — the launch-day observability composite, against SEEDED data with
 * known answers.
 *
 * Executes the real SQL through the house SQLite adapter (the dialect D1
 * speaks): the composite's five sections are seeded independently — crash
 * reports at known ages, one stored economy day, four retention players with
 * ranks/purchases/pending-d7 windows, four delivery ledger lines in all four
 * effective states — and the payload's numbers are pinned by hand.
 *
 * The pins that matter:
 *   - field order IS the contract (triage order: error_rate → tps →
 *     new_player_funnel → economy_snapshot → store_deliveries);
 *   - tps is null with sources.tps 'not instrumented' — nothing in src/
 *     carries a TPS measurement, and the composite must never invent one;
 *   - the funnel numbers are the REUSED S2-D07 functions' output (a duplicate
 *     implementation would drift; these assertions pin the reuse);
 *   - one dead source degrades its OWN section to null + 'unavailable' while
 *     the page still loads whole (200) — the launch-day page cannot half-load.
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

const { retentionSource } = vi.hoisted(() => ({ retentionSource: { fail: false } }));

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
// The reuse seam: when this flag is set, the S2-D07 reader the composite
// calls rejects — proving a dead funnel source degrades ONE section.
vi.mock('../analytics/retention.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../analytics/retention.js')>();
  return {
    ...actual,
    listSeenRows: vi.fn(async (...args: Parameters<typeof actual.listSeenRows>) => {
      if (retentionSource.fail) throw new Error('retention source down (simulated)');
      return actual.listSeenRows(...args);
    }),
  };
});

import { createApp } from '../app.js';
import { initEnvFromBindings, __resetEnvForTests } from '../env.js';
import { __resetLaunchdaySchemaForTests, ensureCrashReportsSchema } from '../api/v2/launchday.js';
import { __resetEconomySchemaForTests, saveEconomyDailyRow } from '../analytics/economy.js';
import { __resetRetentionSchemaForTests, dayKey, upsertSeenRows } from '../analytics/retention.js';
import { __resetDeliveryLedgerSchemaForTests, ledgerLineExecuted, ledgerLineFailed, ledgerLineQueued } from '../db/deliveryLedger.js';

const BOT = { 'X-Bot-Token': 'test-bot-token' };
const ADMIN = { ...BOT, 'X-Staff-Role': 'admin' };
const HELPER = { ...BOT, 'X-Staff-Role': 'helper' };

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const NOW = Date.now();

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const P3 = '33333333-3333-4333-8333-333333333333';
const P4 = '44444444-4444-4444-8444-444444444444';

let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  __resetLaunchdaySchemaForTests();
  __resetEconomySchemaForTests();
  __resetRetentionSchemaForTests();
  __resetDeliveryLedgerSchemaForTests();
  retentionSource.fail = false;
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
  app = createApp();
});

async function seedLedger(): Promise<void> {
  // o1: delivered + one fresh pending line; o2: pending past 24h (stale);
  // o3: failed. Also the funnel's purchase evidence (p2, p3 bought).
  await ledgerLineQueued({
    orderId: 'pn-order-1', lineKey: 'a', productId: 'rank-upgrade',
    customerUuid: P2, command: 'LP user p2 parent add rank_ii', queuedAt: NOW - HOUR_MS,
  });
  await ledgerLineExecuted('pn-order-1', 'a', NOW - HOUR_MS + 5_000);
  await ledgerLineQueued({
    orderId: 'pn-order-1', lineKey: 'b', productId: 'crate-keys',
    customerUuid: P2, command: 'crate key p2 1', queuedAt: NOW - HOUR_MS,
  });
  await ledgerLineQueued({
    orderId: 'pn-order-2', lineKey: 'a', productId: 'rank-upgrade',
    customerUuid: P3, command: 'LP user p3 parent add rank_v', queuedAt: NOW - 25 * HOUR_MS,
  });
  await ledgerLineQueued({
    orderId: 'pn-order-3', lineKey: 'a', productId: 'currency-pack',
    customerUuid: P4, command: 'eco give p4 5000', queuedAt: NOW - 2 * HOUR_MS,
  });
  await ledgerLineFailed('pn-order-3', 'a', 'dispatch rejected: player offline');
}

async function seedCrashReports(): Promise<void> {
  await ensureCrashReportsSchema(); // the same ensure the route runs on read
  const ins = db.prepare(
    `INSERT INTO client_crash_reports
       (id, created_at, ip_hash, launcher, launcher_version, client_version, mc_version, platform, cause, mod, log_tail, crash_report)
     VALUES (?, ?, 'h', 'launcher', '1.0.0', NULL, NULL, 'win32', ?, NULL, 'tail', NULL)`,
  );
  ins.run('c1', NOW - 10 * 60_000, 'OOM');
  ins.run('c2', NOW - 20 * 60_000, 'OOM');
  ins.run('c3', NOW - 2 * HOUR_MS, 'launcher-update');
  ins.run('c4', NOW - 30 * HOUR_MS, 'ancient'); // outside the 24h window
}

async function seedEconomy(): Promise<void> {
  await saveEconomyDailyRow({
    day: dayKey(NOW),
    total_supply: 1_000_000,
    holder_count: 4,
    gini: 0.5,
    top1_share: 0.6,
    issued_total: 100,
    drained_total: 30,
    issuance_by_faucet: { 'mining:sell': 100 },
    drain_by_sink: { 'rank:cost': 30 },
    net_delta_abs: 70,
    net_delta: 70 / 999_930,
  });
}

async function seedRetention(): Promise<void> {
  await upsertSeenRows(
    [
      { uuid: P1, firstSeenMs: NOW - HOUR_MS, lastSeenMs: NOW, sessionCount: 1, totalPlaytimeS: 60, rankLevel: 1 },
      { uuid: P2, firstSeenMs: NOW - HOUR_MS, lastSeenMs: NOW, sessionCount: 1, totalPlaytimeS: 300, rankLevel: 2 },
      { uuid: P3, firstSeenMs: NOW - HOUR_MS, lastSeenMs: NOW, sessionCount: 1, totalPlaytimeS: 900, rankLevel: 5 },
      { uuid: P4, firstSeenMs: NOW - HOUR_MS, lastSeenMs: NOW, sessionCount: 1, totalPlaytimeS: 120, rankLevel: 5 },
    ],
    NOW,
  );
}

const get = (path = '/api/v2/admin/launchday', headers: Record<string, string> = ADMIN) =>
  app.request(path, { headers });

/* ── Gate ─────────────────────────────────────────────────────────────────── */

describe('GET /api/v2/admin/launchday — fail-closed admin gate', () => {
  it('anonymous 401, helper 403, admin 200', async () => {
    await seedLedger();
    expect((await get('/api/v2/admin/launchday', {})).status).toBe(401);
    expect((await get('/api/v2/admin/launchday', HELPER)).status).toBe(403);
    expect((await get('/api/v2/admin/launchday', ADMIN)).status).toBe(200);
  });

  it("?days= is validated: junk, 0 and 91 are 400s", async () => {
    expect((await get('/api/v2/admin/launchday?days=junk')).status).toBe(400);
    expect((await get('/api/v2/admin/launchday?days=0')).status).toBe(400);
    expect((await get('/api/v2/admin/launchday?days=91')).status).toBe(400);
    expect((await get('/api/v2/admin/launchday?days=30')).status).toBe(200);
  });
});

/* ── Empty state: populated or honestly marked, never fabricated ─────────── */

describe('the empty state (fresh D1)', () => {
  it('tps is null and honestly marked; quiet sections are zeros, not errors', async () => {
    await seedLedger(); // ledger exists; crash/economy/retention still empty
    const res = await get();
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      tps: unknown;
      error_rate: { errors_last_hour: number; errors_24h: number; top_cause_24h: string | null };
      new_player_funnel: { stages: Array<{ stage: string; count: number }> };
      economy_snapshot: unknown;
      sources: Record<string, string>;
    };
    expect(json.tps).toBeNull();
    expect(json.sources.tps).toBe('not instrumented');
    expect(json.error_rate).toEqual({ errors_last_hour: 0, errors_24h: 0, top_cause_24h: null });
    expect(json.new_player_funnel!.stages[0]).toEqual({ stage: 'joined', count: 0, conversion: null });
    expect(json.economy_snapshot).toBeNull();
    expect(json.sources.economy_snapshot).toContain('no stored rows yet');
  });
});

/* ── The seeded composite ─────────────────────────────────────────────────── */

describe('the seeded composite payload', () => {
  beforeEach(async () => {
    await seedLedger();
    await seedCrashReports();
    await seedEconomy();
    await seedRetention();
  });

  it('serves the contract field ORDER (the triage order) in one call', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const keys = Object.keys((await res.json()) as Record<string, unknown>);
    expect(keys).toEqual([
      'generated_at',
      'error_rate',
      'tps',
      'new_player_funnel',
      'economy_snapshot',
      'store_deliveries',
      'sources',
    ]);
  });

  it('error_rate counts the crash intake by age (2 last hour, 3 in 24h, top cause OOM)', async () => {
    const json = (await (await get()).json()) as { error_rate: { errors_last_hour: number; errors_24h: number; top_cause_24h: string | null } };
    expect(json.error_rate.errors_last_hour).toBe(2);
    expect(json.error_rate.errors_24h).toBe(3);
    expect(json.error_rate.top_cause_24h).toBe('OOM');
  });

  it('tps stays null with the honest marker even when everything else is populated', async () => {
    const json = (await (await get()).json()) as { tps: unknown; sources: Record<string, string> };
    expect(json.tps).toBeNull();
    expect(json.sources.tps).toBe('not instrumented');
  });

  it('new_player_funnel is the REUSED S2-D07 funnel over the seeded players', async () => {
    const json = (await (await get()).json()) as {
      new_player_funnel: {
        window_days: number;
        stage_order: string[];
        pending_d7: number;
        stages: Array<{ stage: string; count: number; conversion: number | null }>;
      };
    };
    const funnel = json.new_player_funnel!;
    expect(funnel.window_days).toBe(7);
    expect(funnel.stage_order).toEqual(['joined', 'rank_ii', 'rank_v', 'first_purchase', 'd7_return']);
    const byStage = new Map(funnel.stages.map((s) => [s.stage, s]));
    // 4 joins (all within the window, 1h old); ranks II ≥2: p2,p3,p4 = 3;
    // rank V ≥5: p3,p4 = 2; purchases: p2,p3 = 2; d7 windows all open → 0
    // back, 2 pending.
    expect(byStage.get('joined')).toMatchObject({ count: 4, conversion: null });
    expect(byStage.get('rank_ii')).toMatchObject({ count: 3, conversion: 0.75 });
    expect(byStage.get('rank_v')).toMatchObject({ count: 2, conversion: 0.666667 }); // r6(2/3)
    expect(byStage.get('first_purchase')).toMatchObject({ count: 2, conversion: 1 });
    expect(byStage.get('d7_return')).toMatchObject({ count: 0, conversion: 0 });
    expect(funnel.pending_d7).toBe(2);
  });

  it('economy_snapshot is the latest stored day with its S2-D06 breaches', async () => {
    const json = (await (await get()).json()) as {
      economy_snapshot: {
        as_of: string;
        total_supply: number;
        holder_count: number;
        gini: number;
        net_delta: number;
        breaches: { gini: boolean; net_delta: boolean; faucet: boolean; faucet_offenders: string[] };
        thresholds: Record<string, number>;
      };
    };
    const econ = json.economy_snapshot!;
    expect(econ.as_of).toBe(dayKey(NOW));
    expect(econ.total_supply).toBe(1_000_000);
    expect(econ.holder_count).toBe(4);
    expect(econ.gini).toBeCloseTo(0.5, 10);
    expect(econ.breaches.gini).toBe(false); // 0.5 < 0.85
    expect(econ.breaches.faucet).toBe(true); // one faucet at 100% > 25%
    expect(econ.breaches.faucet_offenders).toEqual(['mining:sell']);
    expect(econ.thresholds).toEqual({ gini_max: 0.85, weekly_net_delta_max: 0.15, faucet_share_max: 0.25 });
  });

  it('store_deliveries counts all four effective states and lists the not-delivered triage', async () => {
    const json = (await (await get()).json()) as {
      store_deliveries: {
        total_lines: number;
        by_status: Record<string, number>;
        oldest_pending_age_s: number | null;
        stale_after_s: number;
        triage: Array<{ order_id: string; status: string }>;
      };
    };
    const d = json.store_deliveries!;
    expect(d.total_lines).toBe(4);
    expect(d.by_status).toEqual({ pending: 1, delivered: 1, failed: 1, stale: 1 });
    expect(d.stale_after_s).toBe(86_400);
    // The only still-pending line queued 1h ago; the 25h line reads stale.
    expect(d.oldest_pending_age_s).toBeGreaterThanOrEqual(3_599);
    expect(d.oldest_pending_age_s!).toBeLessThan(3_601);
    // Triage: every non-delivered line, newest queued first.
    expect(d.triage.map((t) => [t.order_id, t.status])).toEqual([
      ['pn-order-1', 'pending'],
      ['pn-order-3', 'failed'],
      ['pn-order-2', 'stale'],
    ]);
  });

  it('the contract-doc alias /admin/ops/launch serves the same composite', async () => {
    const res = await get('/api/v2/admin/ops/launch');
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(json)).toEqual([
      'generated_at',
      'error_rate',
      'tps',
      'new_player_funnel',
      'economy_snapshot',
      'store_deliveries',
      'sources',
    ]);
    expect(json.tps).toBeNull();
  });

  it('one dead source degrades ONLY its own section — the page still loads whole', async () => {
    retentionSource.fail = true;
    const res = await get();
    retentionSource.fail = false;
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      new_player_funnel: unknown;
      error_rate: { errors_last_hour: number } | null;
      economy_snapshot: unknown;
      store_deliveries: unknown;
      sources: Record<string, string>;
    };
    expect(json.new_player_funnel).toBeNull();
    expect(json.sources.new_player_funnel).toBe('unavailable');
    // The rest of the page is intact — triage order preserved, others populated.
    expect(json.error_rate!.errors_last_hour).toBe(2);
    expect(json.economy_snapshot).not.toBeNull();
    expect(json.store_deliveries).not.toBeNull();
  });
});
