/**
 * S2-D12 (Lane D) — the growth-metrics attribution surface: ONE staff-gated
 * read, GET /api/v2/admin/growth/overview, stitching the weekly table from
 * docs/season-2/06-MARKETING-AND-GROWTH.md §6 out of the endpoints that
 * already exist (E09 intents/claims, the D07 retention fold, C13-style
 * honest-empty markers) — never fabricating a cell the backend cannot see.
 *
 * Seeded answers (relative to a load-time NOW, the launchday style):
 *
 *   window    ?from = NOW-12d, ?to = NOW-2d (explicit, deterministic)
 *   intents   h1 -> vote-mcs @ NOW-5d, h2 -> site @ NOW-5d,
 *             h3 -> launcher @ NOW-20d (OUTSIDE the window — must not count)
 *   claims    A -> vote-mcs @ NOW-5d, C -> direct @ NOW-5d,
 *             X -> launcher @ NOW-20d (OUTSIDE — must not count)
 *   fold      A vote-mcs  joined NOW-10d, active {d0}          -> d1 miss
 *             B vote-mcs  joined NOW-10d, active {d0, d0+1}    -> d1 hit
 *             C direct    joined NOW-9d,  active {c0, c0+1}    -> d1 hit
 *             D direct    joined NOW-40d (OUTSIDE the window)  -> excluded
 *   discord   3 discord_links rows created in-window (Postgres mock)
 *
 * Pins that matter:
 *   - field order IS the §6 table order (connect_attempts -> joins ->
 *     server_lists -> discord_bridge -> retention_by_source -> CAC marker);
 *   - the 48h intent-TTL is DISCLOSED on the payload, and out-of-window rows
 *     never leak into the counts;
 *   - dN by source comes from the retention fold (first_seen + active days),
 *     with null for windows that have not closed — a partial window is never
 *     presented as data;
 *   - discord GUILD joins are null + marked not-tracked (the backend has no
 *     guild-join table); only the link count is a real number;
 *   - one dead source degrades its OWN cells to null + sources 'unavailable'
 *     while the page still loads whole (200) — the launchday doctrine.
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

const { discordPg, getD1Mock } = vi.hoisted(() => ({
  /** The Postgres side of the discord_links count, mockable per test. */
  discordPg: { links: 3, fail: false },
  getD1Mock: vi.fn(),
}));

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    getD1: getD1Mock,
    query: vi.fn(async (sql: string) => {
      if (sql.includes('discord_links')) {
        if (discordPg.fail) throw new Error('pg down (simulated)');
        return { rows: [{ n: discordPg.links }] };
      }
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

import { createApp } from '../app.js';
import { initEnvFromBindings, __resetEnvForTests } from '../env.js';
import { ensureAttributionSchema, __resetAttributionSchemaForTests } from '../analytics/attribution.js';
import {
  __resetRetentionSchemaForTests,
  addDays,
  computeSourceRetention,
  dayKey,
  upsertActiveDays,
  upsertSeenRows,
  type SeenRow,
} from '../analytics/retention.js';

const BOT = { 'X-Bot-Token': 'test-bot-token' };
const ADMIN = { ...BOT, 'X-Staff-Role': 'admin' };
const HELPER = { ...BOT, 'X-Staff-Role': 'helper' };

const DAY = 86_400_000;
const NOW = Date.now();
const FROM = dayKey(NOW - 12 * DAY);
const TO = dayKey(NOW - 2 * DAY);

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';
const X = '55555555-5555-4555-8555-555555555555';

let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  // The global limiter tables: pre-create so an armed schemaReady never
  // meets a missing table (the churn/e09 suite's rule).
  db.exec('CREATE TABLE IF NOT EXISTS rate_limit_windows (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, hits INTEGER NOT NULL DEFAULT 0)');
  db.exec('CREATE TABLE IF NOT EXISTS rate_limit_v2_windows (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, cost INTEGER NOT NULL DEFAULT 0)');
  __resetAttributionSchemaForTests();
  __resetRetentionSchemaForTests();
  discordPg.links = 3;
  discordPg.fail = false;
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

/** Seed intents + claims with raw rows (the read path never inspects hashes). */
async function seedAttribution(): Promise<void> {
  await ensureAttributionSchema();
  const intent = db.prepare('INSERT INTO attribution_intent (ip_hash, source, ts) VALUES (?, ?, ?)');
  intent.run('h1', 'vote-mcs', NOW - 5 * DAY);
  intent.run('h2', 'site', NOW - 5 * DAY);
  intent.run('h3', 'launcher', NOW - 20 * DAY); // outside [from, to] — must not count
  const claim = db.prepare('INSERT INTO attribution_claim (uuid, source, claimed_at) VALUES (?, ?, ?)');
  claim.run(A, 'vote-mcs', NOW - 5 * DAY);
  claim.run(C, 'direct', NOW - 5 * DAY);
  claim.run(X, 'launcher', NOW - 20 * DAY); // outside — must not count
}

/** Seed the retention fold: A/B vote-mcs, C direct (in window), D (outside). */
async function seedFold(): Promise<void> {
  const a0 = dayKey(NOW - 10 * DAY);
  const c0 = dayKey(NOW - 9 * DAY);
  await upsertSeenRows(
    [
      { uuid: A, firstSeenMs: NOW - 10 * DAY, lastSeenMs: NOW - 10 * DAY, sessionCount: 1, totalPlaytimeS: 60, rankLevel: 1, source: 'vote-mcs' },
      { uuid: B, firstSeenMs: NOW - 10 * DAY, lastSeenMs: NOW - 10 * DAY, sessionCount: 1, totalPlaytimeS: 60, rankLevel: 1, source: 'vote-mcs' },
      { uuid: C, firstSeenMs: NOW - 9 * DAY, lastSeenMs: NOW - 9 * DAY, sessionCount: 1, totalPlaytimeS: 60, rankLevel: 1, source: 'direct' },
      { uuid: D, firstSeenMs: NOW - 40 * DAY, lastSeenMs: NOW - 40 * DAY, sessionCount: 1, totalPlaytimeS: 60, rankLevel: 1, source: 'direct' },
    ],
    NOW,
  );
  await upsertActiveDays([
    { uuid: A, day: a0 },
    { uuid: B, day: a0 },
    { uuid: B, day: addDays(a0, 1) }, // B returns on join+1 -> the d1 hit
    { uuid: C, day: c0 },
    { uuid: C, day: addDays(c0, 1) },
    { uuid: D, day: dayKey(NOW - 40 * DAY) },
  ]);
}

const get = (query = `?from=${FROM}&to=${TO}`, headers: Record<string, string> = ADMIN) =>
  app.request(`/api/v2/admin/growth/overview${query}`, { headers });

/* ── computeSourceRetention (the D1/D7/D30-by-source cell, pure function) ─── */

describe('computeSourceRetention (whole-window per-source cohort slices)', () => {
  const joinDay = '2026-09-01';
  const mk = (uuid: string, source: string, day: string): SeenRow => ({
    uuid,
    first_seen_ms: Date.parse(`${day}T00:00:00.000Z`),
    last_seen_ms: Date.parse(`${day}T00:00:00.000Z`),
    session_count: 1,
    total_playtime_s: 60,
    rank_level: 1,
    source,
  });
  const players = [
    mk('u1', 'vote-x', joinDay),
    mk('u2', 'vote-x', joinDay),
    mk('u3', 'direct', joinDay),
    mk('u4', 'direct', '2026-08-01'), // outside [from, to] — excluded
  ];
  const active = new Map<string, Set<string>>([
    ['u1', new Set(['2026-09-01', '2026-09-02', '2026-10-01'])], // d1 + d30 hit
    ['u2', new Set(['2026-09-01'])],
    ['u3', new Set(['2026-09-01'])],
    ['u4', new Set(['2026-08-01'])],
  ]);
  // nowMs 2026-10-15: d1/d7/d30 windows all closed for the 09-01 cohort.
  const out = computeSourceRetention(players, active, {
    from: '2026-09-01',
    to: '2026-09-30',
    nowMs: Date.parse('2026-10-15T00:00:00.000Z'),
  });

  it('aggregates the whole join window per source with exact d1/d7/d30 rates', () => {
    expect(out.overall).toEqual({ size: 3, d1: 0.333333, d7: 0, d30: 0.333333 });
    expect(out.by_source['vote-x']).toEqual({ size: 2, d1: 0.5, d7: 0, d30: 0.5 });
    expect(out.by_source['direct']).toEqual({ size: 1, d1: 0, d7: 0, d30: 0 });
  });

  it('excludes players whose join day falls outside the window', () => {
    expect(out.overall.size).toBe(3); // u4 (2026-08-01) never counted
    expect(out.by_source['direct']!.size).toBe(1);
  });

  it('reports null (never a partial number) while a dN window is still open', () => {
    // Joined 2026-10-10, now 2026-10-15: the d1 window HAS closed (computable,
    // 0 — v1 was not active on 10-11); d7/d30 windows are still open -> null.
    const young = computeSourceRetention([mk('v1', 'site', '2026-10-10')], new Map([['v1', new Set(['2026-10-10'])]]), {
      from: '2026-10-01',
      to: '2026-10-31',
      nowMs: Date.parse('2026-10-15T00:00:00.000Z'),
    });
    expect(young.overall).toEqual({ size: 1, d1: 0, d7: null, d30: null });
  });

  it('an empty window answers size 0 with null rates, not an error', () => {
    const empty = computeSourceRetention(players, active, {
      from: '2025-01-01',
      to: '2025-01-31',
      nowMs: Date.parse('2026-10-15T00:00:00.000Z'),
    });
    expect(empty.overall).toEqual({ size: 0, d1: null, d7: null, d30: null });
    expect(empty.by_source).toEqual({});
  });
});

/* ── The route ────────────────────────────────────────────────────────────── */

describe('GET /api/v2/admin/growth/overview — fail-closed admin gate', () => {
  it('anonymous 401, helper 403, admin 200', async () => {
    expect((await get('', {})).status).toBe(401);
    expect((await get('', HELPER)).status).toBe(403);
    expect((await get('', ADMIN)).status).toBe(200);
  });

  it('junk from/to dates are 400 exactly like the other retention reads', async () => {
    expect((await get('?from=nonsense')).status).toBe(400);
    expect((await get(`?from=${FROM}&to=2026-13-99`)).status).toBe(400);
  });
});

describe('the empty state (fresh D1 + empty Postgres)', () => {
  it('every cell is an honest zero/null, never an error or a fabricated number', async () => {
    discordPg.links = 0;
    const res = await get('', ADMIN); // default window (30d)
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown> & {
      connect_attempts: { by_source: unknown[]; intent_window_hours: number };
      joins: { total: number; by_source: unknown[]; claims_by_source: unknown[] };
      discord_bridge: { links_created_in_window: number; discord_guild_joins: null };
      retention_by_source: { overall: { size: number; d1: null; d7: null; d30: null } };
      sources: Record<string, string>;
    };
    expect(json.connect_attempts.by_source).toEqual([]);
    expect(json.connect_attempts.intent_window_hours).toBe(48);
    expect(json.joins).toEqual({ total: 0, by_source: [], claims_by_source: [] });
    expect(json.discord_bridge.links_created_in_window).toBe(0);
    expect(json.discord_bridge.discord_guild_joins).toBeNull();
    expect(json.retention_by_source.overall).toEqual({ size: 0, d1: null, d7: null, d30: null });
    // No section failed — emptiness is a state, not an outage.
    expect(Object.values(json.sources).some((s) => s === 'unavailable')).toBe(false);
  });
});

describe('the seeded §6 table', () => {
  beforeEach(async () => {
    await seedAttribution();
    await seedFold();
  });

  it('serves the contract field ORDER (the §6 table row order) in one call', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(json)).toEqual([
      'generated_at',
      'from',
      'to',
      'window_days',
      'connect_attempts',
      'joins',
      'server_lists',
      'discord_bridge',
      'retention_by_source',
      'cac_vs_arppu',
      'sources',
    ]);
  });

  it('connect_attempts: intents by source with the 48h TTL disclosed; out-of-window rows never count', async () => {
    const json = (await (await get()).json()) as {
      connect_attempts: {
        by_source: Array<{ source: string; count: number }>;
        intent_window_hours: number;
        note: string;
      };
    };
    expect(json.connect_attempts.by_source).toEqual([
      { source: 'site', count: 1 },
      { source: 'vote-mcs', count: 1 },
    ]); // launcher @ NOW-20d excluded by the window
    expect(json.connect_attempts.intent_window_hours).toBe(48);
    expect(json.connect_attempts.note).toContain('48');
  });

  it('joins: the fold is the full denominator (direct included), claims are the E09 one-shot record', async () => {
    const json = (await (await get()).json()) as {
      joins: {
        total: number;
        by_source: Array<{ source: string; count: number }>;
        claims_by_source: Array<{ source: string; count: number }>;
      };
    };
    expect(json.joins.total).toBe(3); // A+B+C in window; D (NOW-40d) excluded
    expect(json.joins.by_source).toEqual([
      { source: 'vote-mcs', count: 2 },
      { source: 'direct', count: 1 },
    ]);
    expect(json.joins.claims_by_source).toEqual([
      { source: 'direct', count: 1 },
      { source: 'vote-mcs', count: 1 },
    ]); // launcher claim @ NOW-20d excluded
  });

  it('server_lists: the vote-<list> slices, list slug stripped of the prefix', async () => {
    const json = (await (await get()).json()) as {
      server_lists: {
        intent_copies_by_list: Array<{ list: string; count: number }>;
        claimed_joins_by_list: Array<{ list: string; count: number }>;
        joins_by_list: Array<{ list: string; count: number }>;
      };
    };
    expect(json.server_lists.intent_copies_by_list).toEqual([{ list: 'mcs', count: 1 }]);
    expect(json.server_lists.claimed_joins_by_list).toEqual([{ list: 'mcs', count: 1 }]);
    expect(json.server_lists.joins_by_list).toEqual([{ list: 'mcs', count: 2 }]);
  });

  it('discord_bridge: the link count is real; GUILD joins are null + marked not-tracked', async () => {
    const json = (await (await get()).json()) as {
      discord_bridge: { links_created_in_window: number; discord_guild_joins: null };
      sources: Record<string, string>;
    };
    expect(json.discord_bridge.links_created_in_window).toBe(3);
    expect(json.discord_bridge.discord_guild_joins).toBeNull();
    expect(json.sources['discord_bridge.guild_joins']).toContain('not tracked');
  });

  it('retention_by_source: exact fold-derived d1/d7, d30 null while the window is open', async () => {
    const json = (await (await get()).json()) as {
      retention_by_source: {
        overall: { size: number; d1: number; d7: number; d30: number | null };
        by_source: Record<string, { size: number; d1: number; d7: number; d30: number | null }>;
        derivation: string;
      };
    };
    // A misses d1, B and C hit -> overall 2/3; nobody active on join+7 -> 0;
    // joins are 9-10 days old -> the d30 window is still open -> null.
    expect(json.retention_by_source.overall).toEqual({ size: 3, d1: 0.666667, d7: 0, d30: null });
    expect(json.retention_by_source.by_source['vote-mcs']).toEqual({ size: 2, d1: 0.5, d7: 0, d30: null });
    expect(json.retention_by_source.by_source['direct']).toEqual({ size: 1, d1: 1, d7: 0, d30: null });
    expect(json.retention_by_source.derivation).toContain('retention_player_seen');
  });

  it('CAC vs ARPPU is the §6 manual row: null with the honest marker', async () => {
    const json = (await (await get()).json()) as { cac_vs_arppu: null; sources: Record<string, string> };
    expect(json.cac_vs_arppu).toBeNull();
    expect(json.sources['cac_vs_arppu']).toContain('manual');
  });
});

describe('section degradation (one dead source never takes the page down)', () => {
  beforeEach(async () => {
    await seedAttribution();
    await seedFold();
  });

  it('a Postgres outage degrades ONLY the discord link count; the page is 200', async () => {
    discordPg.fail = true;
    const res = await get();
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      connect_attempts: unknown;
      joins: { total: number };
      discord_bridge: null;
      retention_by_source: { overall: { size: number } };
      sources: Record<string, string>;
    };
    expect(json.discord_bridge).toBeNull();
    expect(json.sources['discord_bridge.links']).toBe('unavailable');
    expect(json.joins.total).toBe(3); // D1 sections unaffected
    expect(json.retention_by_source.overall.size).toBe(3);
  });

  it('a D1 outage degrades the attribution + fold cells; discord (Postgres) still serves', async () => {
    getD1Mock.mockImplementation(() => {
      throw new Error('d1 down (simulated)');
    });
    const res = await get();
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      connect_attempts: null;
      joins: { total: null; by_source: null; claims_by_source: null };
      server_lists: { intent_copies_by_list: null; claimed_joins_by_list: null; joins_by_list: null };
      retention_by_source: null;
      discord_bridge: { links_created_in_window: number };
      sources: Record<string, string>;
    };
    expect(json.connect_attempts).toBeNull();
    expect(json.joins).toEqual({ total: null, by_source: null, claims_by_source: null });
    expect(json.retention_by_source).toBeNull();
    expect(json.server_lists.joins_by_list).toBeNull();
    expect(json.discord_bridge.links_created_in_window).toBe(3); // Postgres unaffected
    expect(json.sources['connect_attempts']).toBe('unavailable');
    expect(json.sources['retention_by_source']).toBe('unavailable');
  });
});
