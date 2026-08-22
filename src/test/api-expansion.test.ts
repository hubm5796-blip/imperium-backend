import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';

/**
 * Route tests for the 12a API expansion (docs/api.md). These exercise the
 * real Hono app (createApp) end-to-end via app.request(...) with the two
 * network dependencies mocked at module level:
 *   - db/pool.js  -> `query`, `getLeaderboard`, `getNameByUuid`, `getUuidByDiscordId`
 *   - db/redis.js -> response-cache helpers (no-op, so SWR deterministically misses)
 * Env is built from fake Workers bindings (initEnvFromBindings), so no
 * process.env or real secret is involved.
 */


// D1 stub for the rate limiter (shared in-memory counter map — mirrors D1's
// single-row-per-key upsert semantics closely enough for limit tests).
vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  const rows = new Map<string, number>();
  const d1Stub = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.startsWith('INSERT INTO')) {
                const key = String(args[0]);
                const next = (rows.get(key) ?? 0) + 1;
                rows.set(key, next);
                return { hits: next } as T;
              }
              return null as T;
            },
            async run() { return { meta: {} }; },
          };
        },
        async run() { return { meta: {} }; },
        async first<T>() { return null as T; },
      };
    },
  };
  const holder = { stub: d1Stub };
  return {
    ...actual,
    getD1: () => holder.stub!,
    query: vi.fn(),
    getLeaderboard: vi.fn(),
    getEloLeaderboard: vi.fn(),
    getWaveLeaderboard: vi.fn(),
    getNameByUuid: vi.fn(async () => null),
    getUuidByDiscordId: vi.fn(async () => null),
  };
});

vi.mock('../db/redis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/redis.js')>();
  return {
    ...actual,
    getCachedJson: vi.fn(async () => null),
    setCachedJson: vi.fn(async () => undefined),
    deleteCachedJson: vi.fn(async () => undefined),
  };
});

import { createApp } from '../app.js';
import { initEnvFromBindings } from '../env.js';
import { signJwt } from '../auth/jwt.js';
import { query as queryMock } from '../db/pool.js';
import { getLeaderboard as getLeaderboardMock } from '../db/pool.js';
import { getEloLeaderboard as getEloLeaderboardMock } from '../db/pool.js';
import { getCachedJson as getCachedJsonMock } from '../db/redis.js';
import { signWebQueueRow } from '../api/expansion/webqueue.js';

const TEST_UUID = 'a25a17ce-bca1-4894-92c9-00d7ab5b7875';
const JWT_SECRET = 'unit-test-jwt-secret-0123456789abcdef0123';
const WEBPANEL_SECRET = 'unit-test-webpanel-secret-0123456789abcdef';

let app: ReturnType<typeof createApp>;
let sessionCookie: string;

/** Distinct IP per rate-limit-sensitive test (limiter buckets are module-global). */
let ipSeq = 0;
function nextIp(): string {
  ipSeq += 1;
  return `198.51.100.${ipSeq % 250}`;
}

function reqInit(ip: string, extra: Record<string, string> = {}, withSession = false): RequestInit {
  const headers: Record<string, string> = {
    'CF-Connecting-IP': ip,
    ...extra,
  };
  if (withSession) headers.Cookie = sessionCookie;
  return { headers };
}

/** Route one SQL statement to a rows array; anything unexpected throws loudly. */
function stubQuery(handlers: Array<{ match: (sql: string) => boolean; rows: unknown[] }>) {
  vi.mocked(queryMock).mockImplementation(async (sql: string) => {
    for (const h of handlers) {
      if (h.match(sql)) return { rows: h.rows, rowCount: h.rows.length } as never;
    }
    throw new Error(`Unexpected query in test: ${sql.slice(0, 120)}`);
  });
}

beforeAll(async () => {
  initEnvFromBindings({
    JWT_SECRET,
    WEBPANEL_HMAC_SECRET: WEBPANEL_SECRET,
    DISCORD_CLIENT_ID: 'test-client-id',
    DISCORD_CLIENT_SECRET: 'test-client-secret',
    BOT_API_TOKEN: 'test-bot-token',
    VOTE_CALLBACK_KEYS: 'planetminecraft:test-vote-key,serverlist:second-key',
    PAYNOW_API_KEY: 'test-paynow-key',
    PAYNOW_STORE_ID: 'test-store',
    PAYNOW_WEBHOOK_SECRETS: 'test-webhook-secret',
    NODE_ENV: 'test',
  });
  app = createApp();
  sessionCookie = `imperium_session=${await signJwt({ authMethod: 'mc_code', mcUuid: TEST_UUID })}`;
});

beforeEach(() => {
  vi.mocked(queryMock).mockReset();
  vi.mocked(getLeaderboardMock).mockReset();
});

/* ------------------------------------------------------------ Leaderboards */

describe('GET /api/leaderboards/:board (expansion boards)', () => {
  it('colosseum: 200, ranked entries from leaderboard_stats, cache headers set', async () => {
    stubQuery([
      {
        match: (sql) => sql.includes('FROM leaderboard_stats'),
        rows: [
          { uuid: TEST_UUID, player_name: 'Caesar', total: '900' },
          { uuid: 'b25a17ce-bca1-4894-92c9-00d7ab5b7875', player_name: 'Titus', total: '400' },
        ],
      },
    ]);
    const res = await app.request('/api/leaderboards/colosseum?limit=2', reqInit(nextIp()));
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Cache')).toBe('MISS');
    expect(res.headers.get('Cache-Control')).toContain('max-age=60');
    expect(res.headers.get('Cache-Control')).toContain('stale-while-revalidate');
    const body = (await res.json()) as { type: string; entries: Array<{ rank: number; username: string; value: number }> };
    expect(body.type).toBe('colosseum');
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0]).toMatchObject({ rank: 1, username: 'Caesar', value: 900 });
    expect(body.entries[1]).toMatchObject({ rank: 2, username: 'Titus', value: 400 });
    // category allowlist was applied via a bound parameter ($1), not string interpolation
    const call = vi.mocked(queryMock).mock.calls[0];
    expect(call?.[1]?.[0]).toBe('COLOSSEUM_POINTS');
  });

  it('rejects unknown board types with 400', async () => {
    const res = await app.request('/api/leaderboards/cheese', reqInit(nextIp()));
    expect(res.status).toBe(400);
  });

  it('legacy boards still work through the SWR wrapper', async () => {
    vi.mocked(getLeaderboardMock).mockResolvedValue([
      { uuid: TEST_UUID, name: 'Caesar', value: 1000 },
    ]);
    const res = await app.request('/api/leaderboards/blocks', reqInit(nextIp()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { type: string; entries: Array<{ rank: number; username: string }> };
    expect(body.type).toBe('blocks');
    expect(body.entries[0]).toMatchObject({ rank: 1, username: 'Caesar' });
  });

  it('pre-existing static routes (/leaderboards/elo) are not shadowed by the :board param route', async () => {
    vi.mocked(getEloLeaderboardMock).mockResolvedValue([
      { uuid: TEST_UUID, elo: 2100, wins: 30, losses: 10, peak_elo: 2200 },
    ]);
    const res = await app.request('/api/leaderboards/elo', reqInit(nextIp()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ elo: number; username: string }> };
    expect(body.entries[0]).toMatchObject({ elo: 2100, username: TEST_UUID });
  });

  it('cache HIT short-circuits the database entirely', async () => {
    vi.mocked(getCachedJsonMock).mockResolvedValueOnce({
      data: { type: 'colosseum', entries: [{ rank: 1, uuid: TEST_UUID, username: 'Cached', value: 1 }] },
      fetchedAt: Date.now(), // fresh — must be served without revalidation
    });
    const res = await app.request('/api/leaderboards/colosseum', reqInit(nextIp()));
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Cache')).toBe('HIT');
    expect(vi.mocked(queryMock)).not.toHaveBeenCalled();
    const body = (await res.json()) as { entries: Array<{ username: string }> };
    expect(body.entries[0].username).toBe('Cached');
  });
});

/* ------------------------------------------------------------------ Codex */

describe('GET /api/players/:uuid/codex', () => {
  function stubCodex() {
    stubQuery([
      {
        match: (sql) => sql.includes('FROM player_story'),
        rows: [{ chapter_id: 'ch01', block_progress: '120' }],
      },
      {
        match: (sql) => sql.includes('FROM enchant_stats'),
        rows: [
          { enchant_id: 'veneer', procs: '900' },
          { enchant_id: 'forge', procs: '100' },
        ],
      },
    ]);
  }

  it('self: 200 with lore + enchant aggregation and an ETag', async () => {
    stubCodex();
    const res = await app.request(`/api/players/${TEST_UUID}/codex`, reqInit(nextIp(), {}, true));
    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).toMatch(/^"[0-9a-f]{32}"$/);
    const body = (await res.json()) as {
      lore: { chapters: Array<{ chapterId: string; blockProgress: number }> };
      enchants: { distinct: number; totalProcs: number };
    };
    expect(body.lore.chapters).toEqual([{ chapterId: 'ch01', blockProgress: 120 }]);
    expect(body.enchants).toMatchObject({ distinct: 2, totalProcs: 1000 });
  });

  it('matching If-None-Match returns 304 with no body', async () => {
    stubCodex();
    const first = await app.request(`/api/players/${TEST_UUID}/codex`, reqInit(nextIp(), {}, true));
    const etag = first.headers.get('ETag')!;
    const second = await app.request(
      `/api/players/${TEST_UUID}/codex`,
      reqInit(nextIp(), { 'If-None-Match': etag }, true),
    );
    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
  });

  it('requires a session (401 anonymous)', async () => {
    const res = await app.request(`/api/players/${TEST_UUID}/codex`, reqInit(nextIp()));
    expect(res.status).toBe(401);
  });

  it('refuses reading someone else\'s codex (403)', async () => {
    const other = 'c25a17ce-bca1-4894-92c9-00d7ab5b7875';
    const res = await app.request(`/api/players/${other}/codex`, reqInit(nextIp(), {}, true));
    expect(res.status).toBe(403);
  });
});

/* ------------------------------------------------------------------ Fleet */

describe('GET /api/players/:uuid/fleet', () => {
  it('self: 200 with robots + summary', async () => {
    stubQuery([
      {
        match: (sql) => sql.includes('FROM robot_data'),
        rows: [
          { robot_type: 'miner', count: '3', level: '7', active: true, last_collection: '500', updated_at: '2026-08-01' },
          { robot_type: 'farmer', count: '2', level: '5', active: false, last_collection: '400', updated_at: '2026-08-01' },
        ],
      },
    ]);
    const res = await app.request(`/api/players/${TEST_UUID}/fleet`, reqInit(nextIp(), {}, true));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      robots: Array<{ robotType: string; count: number; active: boolean }>;
      summary: { distinctTypes: number; totalRobots: number; activeTypes: number };
    };
    expect(body.robots).toHaveLength(2);
    expect(body.robots[0]).toMatchObject({ robotType: 'miner', count: 3, active: true });
    expect(body.summary).toEqual({ distinctTypes: 2, totalRobots: 5, activeTypes: 1, totalLevels: 12 });
  });
});

/* ---------------------------------------------------------- Dungeon stats */

describe('GET /api/dungeons/:id/stats', () => {
  it('session: live tables -> clears and lockout', async () => {
    stubQuery([
      {
        match: (sql) => sql.includes('FROM player_dungeon_stats'),
        rows: [{ total_clears: '12', best_time_ms: '184223', last_clear_at: '2026-08-01T00:00:00Z' }],
      },
      {
        match: (sql) => sql.includes('FROM dungeon_lockouts'),
        rows: [{ locked_until: '2026-08-02T00:00:00Z' }],
      },
    ]);
    const res = await app.request('/api/dungeons/cloaca_maxima/stats', reqInit(nextIp(), {}, true));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean; clears: number; bestTimeMs: number | null };
    expect(body).toMatchObject({ dungeonId: 'cloaca_maxima', available: true, clears: 12, bestTimeMs: 184223 });
  });

  it('degrades to zero-state when the tables do not exist yet', async () => {
    vi.mocked(queryMock).mockRejectedValue(new Error('relation does not exist'));
    const res = await app.request('/api/dungeons/cloaca_maxima/stats', reqInit(nextIp(), {}, true));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean; clears: number };
    expect(body.available).toBe(false);
    expect(body.clears).toBe(0);
  });

  it('rejects malformed dungeon ids (400)', async () => {
    const res = await app.request('/api/dungeons/Not%20Valid!!/stats', reqInit(nextIp(), {}, true));
    expect(res.status).toBe(400);
  });
});

/* ----------------------------------------------------------------- Seasons */

describe('GET /api/seasons/current', () => {
  it('200 with live season; missing calendar/festival tables degrade to available:false', async () => {
    stubQuery([
      {
        match: (sql) => sql.includes('FROM seasonal_data'),
        rows: [
          {
            season_id: 's3', name: 'Aeternum', starts_at: '2026-06-01', start_date: null,
            ends_at: '2026-09-01', end_date: null, economy_reset: false,
          },
        ],
      },
    ]);
    const res = await app.request('/api/seasons/current', reqInit(nextIp()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      season: { seasonId: string; name: string };
      calendar: { available: boolean; events: unknown[] };
      festivals: { available: boolean; live: unknown[] };
    };
    expect(body.season).toMatchObject({ seasonId: 's3', name: 'Aeternum' });
    expect(body.calendar.available).toBe(false);
    expect(body.calendar.events).toEqual([]);
    expect(body.festivals.available).toBe(false);
  });
});

describe('GET /api/seasons/hall/:id', () => {
  it('200 with hall entries', async () => {
    stubQuery([
      {
        match: (sql) => sql.includes('FROM season_hall'),
        rows: [{ category: 'blocks', rank: 1, uuid: TEST_UUID, value: '8123456', username: 'Caesar' }],
      },
    ]);
    const res = await app.request('/api/seasons/hall/s2', reqInit(nextIp()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean; entries: Array<{ username: string; value: number }> };
    expect(body.available).toBe(true);
    expect(body.entries[0]).toMatchObject({ username: 'Caesar', value: 8123456 });
  });

  it('rejects malformed season ids (400)', async () => {
    const res = await app.request('/api/seasons/hall/bad%20id!!', reqInit(nextIp()));
    expect(res.status).toBe(400);
  });
});

/* --------------------------------------------------------- Economy flow */

describe('GET /api/economy/flow-summary', () => {
  it('returns SHARES ONLY (no absolute amounts) from the live ledger fallback', async () => {
    stubQuery([
      {
        match: (sql) => sql.includes('FROM economy_transactions'),
        rows: [
          { direction: 'faucet', reason: 'service:minesell', total: '7500' },
          { direction: 'faucet', reason: 'service:vote', total: '2500' },
          { direction: 'sink', reason: 'service:upgrade', total: '1000' },
        ],
      },
    ]);
    const res = await app.request('/api/economy/flow-summary?window=24h', reqInit(nextIp()));
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain('total'); // no absolute totals anywhere in the payload
    const body = JSON.parse(raw) as {
      source: string;
      faucet: Array<{ reason: string; share: number }>;
      sink: Array<{ reason: string; share: number }>;
    };
    expect(body.source).toBe('economy_transactions');
    expect(body.faucet[0]).toEqual({ reason: 'service:minesell', share: 0.75 });
    expect(body.faucet[1]).toEqual({ reason: 'service:vote', share: 0.25 });
    expect(body.sink[0]).toEqual({ reason: 'service:upgrade', share: 1 });
  });

  it('rejects unknown windows (400)', async () => {
    const res = await app.request('/api/economy/flow-summary?window=1y', reqInit(nextIp()));
    expect(res.status).toBe(400);
  });
});

/* ----------------------------------------------------------- Legion card */

describe('GET /api/legions/:id', () => {
  it('200 public card', async () => {
    stubQuery([
      {
        match: (sql) => sql.includes('FROM legions'),
        rows: [
          {
            name: 'LegioI', display_name: 'Legio I', level: 6, max_members: 30,
            owner_uuid: TEST_UUID, motd: 'Roma invicta', created_at: '2026-01-04',
            xp: '120450', member_count: '2', bank_balance: '45000', owner_name: 'Caesar',
          },
        ],
      },
      { match: (sql) => sql.includes('FROM legion_members'), rows: [] },
      { match: (sql) => sql.includes('FROM legion_upgrade_levels'), rows: [{ upgrade_id: 'vault', level: 2 }] },
      { match: (sql) => sql.includes('FROM legion_war_records'), rows: [{ wins: 4, losses: 1 }] },
    ]);
    const res = await app.request('/api/legions/LegioI', reqInit(nextIp()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name: string; memberCount: number; perks: unknown[]; warRecord: { wins: number } | null;
    };
    expect(body.name).toBe('LegioI');
    expect(body.memberCount).toBe(2);
    expect(body.perks).toEqual([{ upgradeId: 'vault', level: 2 }]);
    expect(body.warRecord).toEqual({ wins: 4, losses: 1 });
  });

  it('404s for an unknown legion (uncached miss)', async () => {
    stubQuery([{ match: (sql) => sql.includes('FROM legions'), rows: [] }]);
    const res = await app.request('/api/legions/Nemo', reqInit(nextIp()));
    expect(res.status).toBe(404);
  });
});

/* ---------------------------------------------------------- Vote callback */

describe('POST /api/vote/:site', () => {
  const voteBody = { username: 'Caesar', uuid: TEST_UUID, timestamp: 1739500000 };

  function stubInsert() {
    stubQuery([
      {
        match: (sql) => sql.includes('INSERT INTO web_queue'),
        rows: [{ id: 42 }],
      },
    ]);
  }

  function lastInsertParams(): unknown[] {
    const call = vi.mocked(queryMock).mock.calls.find(([sql]) => (sql as string).includes('INSERT INTO web_queue'));
    if (!call) throw new Error('no web_queue insert captured');
    return call[1] as unknown[];
  }

  it('202 + signed web_queue row whose signature matches the documented HMAC scheme', async () => {
    stubInsert();
    const res = await app.request(
      '/api/vote/planetminecraft',
      {
        method: 'POST',
        headers: { 'CF-Connecting-IP': nextIp(), 'X-Vote-Key': 'test-vote-key', 'Content-Type': 'application/json' },
        body: JSON.stringify(voteBody),
      },
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok: boolean; id: number; requestId: string };
    expect(body.ok).toBe(true);
    expect(body.id).toBe(42);
    expect(body.requestId).toHaveLength(16);

    // Recompute the signature exactly per docs/api.md and compare — proves the
    // wire contract the plugin will implement matches what the backend writes.
    const [requestId, kind, uuid, username, site, sku, quantity, , signature, createdAtSec] =
      lastInsertParams() as [string, string, string, string, string, string, number, string, string, number];
    expect(kind).toBe('vote');
    expect(site).toBe('planetminecraft');
    expect(uuid).toBe(TEST_UUID);
    expect(quantity).toBe(1);
    const message = ['v1', kind, requestId, uuid ?? '', username ?? '', site ?? '', sku ?? '', String(quantity), String(createdAtSec)].join('|');
    const expected = crypto.createHmac('sha256', WEBPANEL_SECRET).update(message).digest('hex');
    expect(signature).toBe(expected);
    // created_at is derived from the signed timestamp value (no clock skew)
    const sql = vi.mocked(queryMock).mock.calls.find(([s]) => (s as string).includes('INSERT INTO web_queue'))![0] as string;
    expect(sql).toContain('to_timestamp');
  });

  it('400 when neither uuid nor username is present', async () => {
    const res = await app.request(
      '/api/vote/planetminecraft',
      {
        method: 'POST',
        headers: { 'CF-Connecting-IP': nextIp(), 'X-Vote-Key': 'test-vote-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ timestamp: 1 }),
      },
    );
    expect(res.status).toBe(400);
  });

  it('401 with a wrong key', async () => {
    const res = await app.request(
      '/api/vote/planetminecraft',
      {
        method: 'POST',
        headers: { 'CF-Connecting-IP': nextIp(), 'X-Vote-Key': 'wrong', 'Content-Type': 'application/json' },
        body: JSON.stringify(voteBody),
      },
    );
    expect(res.status).toBe(401);
  });

  it('404 for an unconfigured site', async () => {
    const res = await app.request(
      '/api/vote/unknownsite',
      {
        method: 'POST',
        headers: { 'CF-Connecting-IP': nextIp(), 'X-Vote-Key': 'test-vote-key', 'Content-Type': 'application/json' },
        body: JSON.stringify(voteBody),
      },
    );
    expect(res.status).toBe(404);
  });

  it('rate limit: write class caps at 10/min (429 on the 11th)', async () => {
    stubInsert();
    const ip = nextIp();
    let last: Response | undefined;
    for (let i = 0; i < 11; i++) {
      last = await app.request(
        '/api/vote/serverlist',
        {
          method: 'POST',
          headers: { 'CF-Connecting-IP': ip, 'X-Vote-Key': 'second-key', 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'Caesar' }),
        },
      );
    }
    expect(last!.status).toBe(429);
    expect(last!.headers.get('Retry-After')).toBeTruthy();
  });
});

/* ---------------------------------------------------------------- Web shop */

describe('GET /api/shop/catalog + POST /api/shop/order', () => {
  it('catalog: 200 public with items', async () => {
    const res = await app.request('/api/shop/catalog', reqInit(nextIp()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { currency: string; items: Array<{ sku: string; price: number }> };
    expect(body.currency).toBe('denarius');
    expect(body.items.length).toBeGreaterThanOrEqual(6);
    expect(body.items.some((i) => i.sku === 'aureus_100')).toBe(true);
  });

  it('order: 202 with computed total for a linked session', async () => {
    stubQuery([{ match: (sql) => sql.includes('INSERT INTO web_queue'), rows: [{ id: 7 }] }]);
    const res = await app.request(
      '/api/shop/order',
      {
        method: 'POST',
        headers: { 'CF-Connecting-IP': nextIp(), 'Content-Type': 'application/json', Cookie: sessionCookie },
        body: JSON.stringify({ sku: 'key_vote_5', quantity: 2 }),
      },
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok: boolean; totalPrice: number; currency: string; sku: string };
    expect(body).toMatchObject({ ok: true, sku: 'key_vote_5', totalPrice: 15000, currency: 'denarius' });
    // row carries the buyer uuid + sku (both signed)
    const call = vi.mocked(queryMock).mock.calls.find(([sql]) => (sql as string).includes('INSERT INTO web_queue'));
    const params = call![1] as unknown[];
    expect(params[1]).toBe('shop_order');
    expect(params[2]).toBe(TEST_UUID);
    expect(params[5]).toBe('key_vote_5');
    expect(params[6]).toBe(2);
  });

  it('order: 404 for an unknown SKU', async () => {
    const res = await app.request(
      '/api/shop/order',
      {
        method: 'POST',
        headers: { 'CF-Connecting-IP': nextIp(), 'Content-Type': 'application/json', Cookie: sessionCookie },
        body: JSON.stringify({ sku: 'does_not_exist' }),
      },
    );
    expect(res.status).toBe(404);
  });

  it('order: 400 for out-of-range quantity', async () => {
    const res = await app.request(
      '/api/shop/order',
      {
        method: 'POST',
        headers: { 'CF-Connecting-IP': nextIp(), 'Content-Type': 'application/json', Cookie: sessionCookie },
        body: JSON.stringify({ sku: 'aureus_100', quantity: 99 }),
      },
    );
    expect(res.status).toBe(400);
  });

  it('order: 401 anonymous', async () => {
    const res = await app.request(
      '/api/shop/order',
      {
        method: 'POST',
        headers: { 'CF-Connecting-IP': nextIp(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku: 'aureus_100' }),
      },
    );
    expect(res.status).toBe(401);
  });

  it('rate limit: shop class caps at 5/min (429 on the 6th)', async () => {
    stubQuery([{ match: (sql) => sql.includes('INSERT INTO web_queue'), rows: [{ id: 1 }] }]);
    const ip = nextIp();
    let last: Response | undefined;
    for (let i = 0; i < 6; i++) {
      last = await app.request(
        '/api/shop/order',
        {
          method: 'POST',
          headers: { 'CF-Connecting-IP': ip, 'Content-Type': 'application/json', Cookie: sessionCookie },
          body: JSON.stringify({ sku: 'aureus_100' }),
        },
      );
    }
    expect(last!.status).toBe(429);
  });
});

/* ------------------------------------------------------------ HMAC scheme */

describe('signWebQueueRow (docs/api.md contract)', () => {
  it('produces lowercase hex HMAC-SHA256 over the documented v1 pipe message', () => {
    const fields = {
      kind: 'shop_order' as const,
      requestId: 'abc123def456ghi7',
      uuid: TEST_UUID,
      username: null,
      site: null,
      sku: 'aureus_100',
      quantity: 2,
      createdAtSec: 1739500000,
    };
    const message = ['v1', 'shop_order', 'abc123def456ghi7', TEST_UUID, '', '', 'aureus_100', '2', '1739500000'].join('|');
    const expected = crypto.createHmac('sha256', WEBPANEL_SECRET).update(message).digest('hex');
    expect(signWebQueueRow(fields)).toBe(expected);
    expect(signWebQueueRow(fields)).toMatch(/^[0-9a-f]{64}$/);
  });
});
