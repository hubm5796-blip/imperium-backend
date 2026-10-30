/**
 * S2-E09 (Lane D backend half) — the attribution intent store, the claim
 * endpoint, and the cronSync fold of join_source, against SEEDED data with
 * known answers (the D07 seeded-suite style).
 *
 * The house SQLite adapter runs the real SQL (attribution DDL, the upsert +
 * 48h prune, the one-shot claim, the monotonic seen fold). The contract is
 * docs/season-2/requests/S2-E09.md (Ask 1) + API-CONTRACTS-S2.md
 * (Attribution):
 *
 *   intent  POST /api/v2/attribution/intent  public, 10/min/IP: stores
 *           salted-IP-hash -> source (latest wins, 48h TTL, pruned on
 *           write). 'direct' is refused; the vocabulary is shape-validated
 *           so no PII can ride in; the raw IP is NEVER persisted.
 *   claim   POST /api/v2/attribution/claim   service-token: one-shot per
 *           uuid (first attribution wins), resolves the uuid's source from
 *           the freshest stored intent matching the player's IP hash,
 *           default 'direct', never null.
 *   fold    cronSync.syncRetention carries player_stats.join_source into
 *           retention_player_seen.source — written on INSERT, upgraded on
 *           UPDATE only from 'direct' (a first attribution is permanent);
 *           degrades to the legacy SELECT (all 'direct') while the plugin
 *           lane's column does not exist yet.
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
import {
  ATTRIBUTION_INTENT_WINDOW_MS,
  __resetAttributionSchemaForTests,
  ensureAttributionSchema,
  hashIp,
  parseSourceTag,
} from '../analytics/attribution.js';
import { __resetRetentionSchemaForTests, listSeenRows, upsertSeenRows } from '../analytics/retention.js';
import { runAnalyticsDaily } from '../analytics/cronSync.js';

const BOT = { 'X-Bot-Token': 'test-bot-token' };
const UUID = '11111111-2222-3333-4444-555555555555';
const HOUR = 3_600_000;

let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  db = new DatabaseSync(':memory:');
  // The global limiter tables: both limiters arm a module-level schemaReady
  // on first use, and every test here gets a FRESH db — pre-create the
  // tables so an armed schemaReady never meets a missing table (which would
  // fail-open instead of limiting).
  db.exec('CREATE TABLE IF NOT EXISTS rate_limit_windows (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, hits INTEGER NOT NULL DEFAULT 0)');
  db.exec('CREATE TABLE IF NOT EXISTS rate_limit_v2_windows (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, cost INTEGER NOT NULL DEFAULT 0)');
  __resetAttributionSchemaForTests();
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
  // Create the attribution tables eagerly: several tests inspect rows on
  // paths that never reach the store (400 validation branches), and the
  // lazy ensure only runs on the first real write.
  await ensureAttributionSchema();
  app = createApp();
  claimResults.clear();
  gameQueryMock.mockReset();
  gameQueryMock.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM player_stats ps')) return [];
    if (sql.includes('DISTINCT uuid, DATE')) return [];
    if (sql.includes('FROM currency_balances')) return [];
    if (sql.includes('GROUP BY reason')) return [];
    throw new Error(`unexpected gameQuery in attribution test: ${sql.slice(0, 60)}`);
  });
});

async function postIntent(source: string, ip: string): Promise<Response> {
  return app.request('/api/v2/attribution/intent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
    body: JSON.stringify({ source }),
  });
}

async function postClaim(body: unknown, headers: Record<string, string> = BOT): Promise<Response> {
  return app.request('/api/v2/attribution/claim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function intentRows(): Array<{ ip_hash: string; source: string; ts: number }> {
  return db.prepare('SELECT ip_hash, source, ts FROM attribution_intent').all() as Array<{
    ip_hash: string; source: string; ts: number;
  }>;
}

function claimRow(uuid: string): { uuid: string; source: string; claimed_at: number } | undefined {
  return db.prepare('SELECT uuid, source, claimed_at FROM attribution_claim WHERE uuid = ?').get(uuid) as
    | { uuid: string; source: string; claimed_at: number }
    | undefined;
}

/* ── The vocabulary mirror (frontend src/lib/attribution.ts parseSourceTag) ── */

describe('parseSourceTag (backend mirror of the frontend guard)', () => {
  it('accepts the closed vocabulary and unknown-but-well-formed tags as data', () => {
    expect(parseSourceTag('site')).toBe('site');
    expect(parseSourceTag('launcher')).toBe('launcher');
    expect(parseSourceTag('client')).toBe('client');
    expect(parseSourceTag('vote-minecraftservers')).toBe('vote-minecraftservers');
    expect(parseSourceTag('sponsor-somestreamer')).toBe('sponsor-somestreamer');
    expect(parseSourceTag('page-faq')).toBe('page-faq');
    expect(parseSourceTag('vote-unknown-new-site')).toBe('vote-unknown-new-site'); // data, not a gate
  });

  it('normalizes case/whitespace and rejects junk, oversize, and PII shapes', () => {
    expect(parseSourceTag('  Site ')).toBe('site');
    expect(parseSourceTag('direct')).toBe('direct'); // valid TAG — the intent route refuses it, not the parser
    expect(parseSourceTag('')).toBeNull();
    expect(parseSourceTag('a'.repeat(41))).toBeNull();
    expect(parseSourceTag('Vote_-bad')).toBeNull();
    expect(parseSourceTag('vote-')).toBeNull();
    expect(parseSourceTag('vote-UPPER')).toBe('vote-upper'); // case-normalized, like the frontend guard
    expect(parseSourceTag('free text')).toBeNull();
    expect(parseSourceTag('user@example.com')).toBeNull();
    expect(parseSourceTag('https://romanica.net')).toBeNull();
    expect(parseSourceTag(123)).toBeNull();
    expect(parseSourceTag(null)).toBeNull();
  });
});

/* ── hashIp: the one salted construction both sides share ─────────────────── */

describe('hashIp', () => {
  it('is deterministic, salted, 64-hex, and never the raw IP', () => {
    expect(hashIp('203.0.113.7')).toBe(hashIp('203.0.113.7'));
    expect(hashIp('203.0.113.7')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashIp('203.0.113.7')).not.toBe('203.0.113.7');
    expect(hashIp('203.0.113.7')).not.toBe(hashIp('203.0.113.8'));
  });

  it('canonicalizes IPv6 case, v4-mapped form, and zone indices before hashing', () => {
    expect(hashIp('2001:DB8::1')).toBe(hashIp('2001:db8::1'));
    expect(hashIp('::ffff:203.0.113.7')).toBe(hashIp('203.0.113.7'));
    expect(hashIp('fe80::1%eth0')).toBe(hashIp('fe80::1'));
  });
});

/* ── POST /api/v2/attribution/intent ──────────────────────────────────────── */

describe('POST /api/v2/attribution/intent', () => {
  it('stores a salted IP hash -> source row and answers 202 {ok:true}', async () => {
    const res = await postIntent('vote-minecraftservers', '198.51.100.5');
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true });
    const rows = intentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ip_hash).toBe(hashIp('198.51.100.5'));
    expect(rows[0]!.source).toBe('vote-minecraftservers');
    expect(rows[0]!.ts).toBeGreaterThan(Date.now() - 10_000);
    // Privacy pin: nothing resembling the raw IP is persisted anywhere.
    expect(rows[0]!.ip_hash).not.toContain('198.51.100.5');
  });

  it('resolves the END VISITOR IP: X-Forwarded-For first entry, CF-Connecting-IP only as fallback', async () => {
    // The site proxy relays the visitor as XFF; through Cloudflare the header
    // arrives as a chain — the LEFTMOST entry is the original visitor.
    await postIntent('site', '198.51.100.5, 10.0.0.9');
    expect(intentRows()[0]!.ip_hash).toBe(hashIp('198.51.100.5'));

    // A direct call (no proxy hop) carries only the edge-set CF-Connecting-IP.
    const res = await app.request('/api/v2/attribution/intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.6' },
      body: JSON.stringify({ source: 'site' }),
    });
    expect(res.status).toBe(202);
    expect(intentRows().map((r) => r.ip_hash)).toContain(hashIp('198.51.100.6'));
  });

  it('latest intent wins and ts refreshes (the newest copy action produced the join)', async () => {
    await postIntent('site', '198.51.100.7');
    const firstTs = intentRows()[0]!.ts;
    await postIntent('vote-minecraftservers', '198.51.100.7');
    const rows = intentRows();
    expect(rows).toHaveLength(1); // upsert by ip_hash, not a new row
    expect(rows[0]!.source).toBe('vote-minecraftservers');
    expect(rows[0]!.ts).toBeGreaterThanOrEqual(firstTs);
  });

  it("prunes rows older than 48h on each write", async () => {
    const stale = Date.now() - (ATTRIBUTION_INTENT_WINDOW_MS + HOUR);
    db.exec(`INSERT INTO attribution_intent (ip_hash, source, ts) VALUES ('${'a'.repeat(64)}', 'site', ${stale})`);
    await postIntent('site', '198.51.100.8');
    const hashes = intentRows().map((r) => r.ip_hash);
    expect(hashes).not.toContain('a'.repeat(64));
    expect(hashes).toContain(hashIp('198.51.100.8'));
  });

  it("'direct' is refused (400): it is the join's default, not a tag anyone reports", async () => {
    const res = await postIntent('direct', '198.51.100.9');
    expect(res.status).toBe(400);
    expect(intentRows()).toHaveLength(0);
  });

  it('malformed bodies and junk sources are 400, never stored', async () => {
    expect((await postIntent('not a tag!', '198.51.100.9')).status).toBe(400);
    expect((await postIntent('', '198.51.100.9')).status).toBe(400);
    expect((await postIntent('a'.repeat(41), '198.51.100.9')).status).toBe(400);
    const badJson = await app.request('/api/v2/attribution/intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.9' },
      body: 'not json',
    });
    expect(badJson.status).toBe(400);
    expect(intentRows()).toHaveLength(0);
  });

  it('no resolvable client IP is a 400 (never a stored guess)', async () => {
    const res = await app.request('/api/v2/attribution/intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'site' }),
    });
    expect(res.status).toBe(400);
    expect(intentRows()).toHaveLength(0);
  });

  it('a spoofed junk XFF entry is dropped, not forwarded (the proxy relay guard, mirrored)', async () => {
    const res = await app.request('/api/v2/attribution/intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': 'evil.example.com' },
      body: JSON.stringify({ source: 'site' }),
    });
    expect(res.status).toBe(400);
    expect(intentRows()).toHaveLength(0);
  });

  it('rate limit: the 11th intent in a minute from one IP is 429 (10/min/IP)', async () => {
    const ip = '198.51.100.10';
    for (let i = 0; i < 10; i += 1) {
      expect((await postIntent('site', ip)).status).toBe(202);
    }
    const res = await postIntent('site', ip);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    // A different visitor is unaffected — the cap is per visitor IP.
    expect((await postIntent('site', '198.51.100.11')).status).toBe(202);
  });

  it('a D1 outage answers 503, never a hang', async () => {
    getD1Mock.mockImplementation(() => {
      throw new Error('d1 down');
    });
    expect((await postIntent('site', '198.51.100.12')).status).toBe(503);
  });
});

/* ── POST /api/v2/attribution/claim ───────────────────────────────────────── */

describe('POST /api/v2/attribution/claim', () => {
  it('is service-token gated: anonymous 401, wrong token 401, service token 200', async () => {
    const body = { uuid: UUID, ip: '203.0.113.7' };
    expect((await postClaim(body, {})).status).toBe(401);
    expect((await postClaim(body, { 'X-Bot-Token': 'wrong-token' })).status).toBe(401);
    expect((await postClaim(body)).status).toBe(200);
  });

  it('resolves a uuid to the freshest intent on its IP and persists the one-shot claim', async () => {
    await postIntent('vote-minecraftservers', '203.0.113.7');
    const res = await postClaim({ uuid: UUID, ip: '203.0.113.7' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ source: 'vote-minecraftservers' });
    expect(claimRow(UUID)?.source).toBe('vote-minecraftservers');
  });

  it('one-shot per uuid: a re-join never re-attributes, even against a newer different intent', async () => {
    await postIntent('vote-minecraftservers', '203.0.113.7');
    expect(await postClaim({ uuid: UUID, ip: '203.0.113.7' })).toMatchObject({ status: 200 });
    // The visitor later copies from a different vote site, then rejoins.
    await postIntent('vote-other-site', '203.0.113.7');
    const again = await postClaim({ uuid: UUID, ip: '203.0.113.7' });
    expect(await again.json()).toEqual({ source: 'vote-minecraftservers' }); // first attribution wins
    // And a DIFFERENT ip intent cannot flip it either.
    await postIntent('site', '203.0.113.99');
    const third = await postClaim({ uuid: UUID, ip: '203.0.113.99' });
    expect(await third.json()).toEqual({ source: 'vote-minecraftservers' });
  });

  it('no matching intent -> direct (never null, never a guess)', async () => {
    const res = await postClaim({ uuid: UUID, ip: '203.0.113.8' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ source: 'direct' });
    expect(claimRow(UUID)?.source).toBe('direct');
  });

  it('an intent older than 48h does not claim — the window expired', async () => {
    const expired = Date.now() - (ATTRIBUTION_INTENT_WINDOW_MS + HOUR);
    db.exec(`INSERT INTO attribution_intent (ip_hash, source, ts) VALUES ('${hashIp('203.0.113.9')}', 'vote-minecraftservers', ${expired})`);
    const fresh = Date.now() - 6 * HOUR; // inside the window for the boundary pin
    db.exec(`INSERT INTO attribution_intent (ip_hash, source, ts) VALUES ('${hashIp('203.0.113.10')}', 'vote-fresh', ${fresh})`);
    expect(await (await postClaim({ uuid: UUID, ip: '203.0.113.9' })).json()).toEqual({ source: 'direct' });
    expect(await (await postClaim({ uuid: '99999999-2222-3333-4444-555555555555', ip: '203.0.113.10' })).json())
      .toEqual({ source: 'vote-fresh' });
  });

  it('the IP hash canonicalization matches the intent side (v4-mapped IPv6 joins claim their v4 intent)', async () => {
    await postIntent('site', '203.0.113.11');
    const res = await postClaim({ uuid: UUID, ip: '::ffff:203.0.113.11' }); // Java socket form
    expect(await res.json()).toEqual({ source: 'site' });
  });

  it('validates the body: junk uuid / junk ip are 400', async () => {
    expect((await postClaim({ uuid: 'not-a-uuid', ip: '203.0.113.7' })).status).toBe(400);
    expect((await postClaim({ uuid: UUID, ip: 'not-an-ip' })).status).toBe(400);
    expect((await postClaim({ uuid: UUID })).status).toBe(400);
    const badJson = await app.request('/api/v2/attribution/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...BOT },
      body: 'not json',
    });
    expect(badJson.status).toBe(400);
  });

  it('a D1 outage answers 503 — the plugin half treats that as direct locally', async () => {
    getD1Mock.mockImplementation(() => {
      throw new Error('d1 down');
    });
    expect((await postClaim({ uuid: UUID, ip: '203.0.113.7' })).status).toBe(503);
  });
});

/* ── The full round trip the request file pins (intent -> claim -> fold) ───── */

describe('S2-E09 round trip: intent -> claim -> cronSync fold -> dashboard row', () => {
  it('a tagged copy-then-join ends with retention_player_seen carrying the tag', async () => {
    // 1. The web visitor copies the IP from a tagged vote landing.
    await postIntent('vote-minecraftservers', '203.0.113.20');
    // 2. The player joins from the same network; the plugin (Lane C half)
    //    claims once and stores the resolved tag on player_stats.join_source.
    const claim = await postClaim({ uuid: UUID, ip: '203.0.113.20' });
    const { source } = (await claim.json()) as { source: string };
    expect(source).toBe('vote-minecraftservers');
    // 3. The game MySQL now carries join_source; the daily fold lands it in D1.
    gameQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM player_stats ps')) {
        return [{
          uuid: UUID,
          join_count: 1,
          last_join: '2026-10-30 10:00:00',
          last_quit: '2026-10-30 12:00:00',
          rank_level: 1,
          total_secs: 7200,
          first_seen: '2026-10-30 09:59:00',
          join_source: source,
        }];
      }
      if (sql.includes('DISTINCT uuid, DATE')) return [{ uuid: UUID, day: '2026-10-30' }];
      if (sql.includes('FROM currency_balances')) return [];
      if (sql.includes('GROUP BY reason')) return [];
      throw new Error(`unexpected gameQuery: ${sql.slice(0, 50)}`);
    });
    const report = await runAnalyticsDaily(new Date('2026-10-31T00:07:00Z'));
    expect(report.retention.ran).toBe(true);
    expect(report.retention.players).toBe(1);
    const seen = await listSeenRows('vote-minecraftservers'); // the ?source= the slicer uses
    expect(seen).toHaveLength(1);
    expect(seen[0]!.uuid).toBe(UUID);
    expect(seen[0]!.source).toBe('vote-minecraftservers');
  });
});

/* ── The fold's monotonicity + the pre-column degradation ─────────────────── */

describe('cronSync join_source fold semantics', () => {
  const uuid = UUID;

  it('upgrades a direct row to its first attribution but never rewrites an attributed one', async () => {
    // Existing 'direct' row (the pre-attribution world).
    await upsertSeenRows([{ uuid, firstSeenMs: 0, lastSeenMs: 0, sessionCount: 1, totalPlaytimeS: 0, rankLevel: 1 }], Date.now());
    // First attribution arrives via the fold.
    await upsertSeenRows([{ uuid, firstSeenMs: 0, lastSeenMs: 0, sessionCount: 2, totalPlaytimeS: 10, rankLevel: 2, source: 'vote-minecraftservers' }], Date.now());
    expect((await listSeenRows())[0]!.source).toBe('vote-minecraftservers');
    // A later, different claim must NOT rewrite history; 'direct' must not regress it either.
    await upsertSeenRows([{ uuid, firstSeenMs: 0, lastSeenMs: 0, sessionCount: 3, totalPlaytimeS: 20, rankLevel: 3, source: 'vote-other' }], Date.now());
    await upsertSeenRows([{ uuid, firstSeenMs: 0, lastSeenMs: 0, sessionCount: 4, totalPlaytimeS: 30, rankLevel: 4 }], Date.now());
    expect((await listSeenRows())[0]!.source).toBe('vote-minecraftservers');
  });

  it('degrades to the legacy SELECT while the plugin column does not exist (all direct, fold still runs)', async () => {
    let playerCalls = 0;
    gameQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM player_stats ps')) {
        playerCalls += 1;
        if (playerCalls === 1) {
          // The plugin lane's column ships separately — until then the game
          // MySQL rejects the extended SELECT exactly like this.
          throw new Error("Unknown column 'ps.join_source' in 'field list'");
        }
        expect(sql).not.toContain('join_source'); // the retry is the legacy shape
        return [{
          uuid,
          join_count: 3,
          last_join: '2026-10-30 10:00:00',
          last_quit: '2026-10-30 12:00:00',
          rank_level: 2,
          total_secs: 3600,
          first_seen: '2026-10-01 09:00:00',
        }];
      }
      if (sql.includes('DISTINCT uuid, DATE')) return [];
      if (sql.includes('FROM currency_balances')) return [];
      if (sql.includes('GROUP BY reason')) return [];
      throw new Error(`unexpected gameQuery: ${sql.slice(0, 50)}`);
    });
    const report = await runAnalyticsDaily(new Date('2026-10-31T00:07:00Z'));
    expect(report.retention.ran).toBe(true);
    expect(report.retention.players).toBe(1);
    expect(playerCalls).toBe(2);
    const seen = await listSeenRows();
    expect(seen[0]!.source).toBe('direct'); // exactly today's behavior — no regression window
  });

  it('an unrelated game-MySQL failure still fails the leg honestly (no silent fold)', async () => {
    gameQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM player_stats ps')) throw new Error('game-mysql unavailable: timeout');
      if (sql.includes('DISTINCT uuid, DATE')) return [];
      if (sql.includes('FROM currency_balances')) return [];
      if (sql.includes('GROUP BY reason')) return [];
      throw new Error(`unexpected gameQuery: ${sql.slice(0, 50)}`);
    });
    const report = await runAnalyticsDaily(new Date('2026-10-31T00:07:00Z'));
    expect(report.retention.ran).toBe(false);
    expect(report.retention.error).toContain('timeout');
  });
});

/* ── Migration parity (the D07 pattern) ───────────────────────────────────── */

describe('d1_0008 migration parity (attribution tables)', () => {
  it('both attribution tables match the migration DDL column-for-column', async () => {
    await postIntent('site', '198.51.100.5'); // triggers lazy ensure of both tables
    const migration = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations', 'd1_0008_attribution.sql'),
      'utf8',
    );
    const colsOf = (table: string): string[] => {
      const block = migration.slice(migration.indexOf(`CREATE TABLE IF NOT EXISTS ${table}`));
      return [
        ...block.slice(0, block.indexOf(');')).matchAll(/^\s{2}(\w+)\s/gm),
      ]
        .map((m) => m[1]!)
        .filter((name) => !['PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN', 'CONSTRAINT'].includes(name));
    };
    for (const table of ['attribution_intent', 'attribution_claim']) {
      const dbCols = (
        db.prepare(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`).all() as { name: string }[]
      ).map((c) => c.name);
      expect(colsOf(table)).toEqual(dbCols);
    }
    // Privacy pin at the schema level: there is NO raw-IP column to misuse.
    expect(colsOf('attribution_intent')).toEqual(['ip_hash', 'source', 'ts']);
  });
});
