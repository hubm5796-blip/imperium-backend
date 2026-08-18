import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Route tests for the 12b/12c companion + community endpoints added during
 * the contract reconciliation (docs/api.md):
 *   POST /api/lfg/posts, GET /api/bounties/top, GET /api/events/feed,
 *   GET /api/vote/status, GET /api/shop/orders, GET /api/economy/drift-alerts,
 *   GET /api/admin/liveops, GET /api/admin/contraband/sweeps,
 *   GET /api/admin/player-tools, plus the /seasons/current enrichment and
 *   /server/status + /player/profile additions.
 *
 * Same harness as api-expansion.test.ts: the real Hono app over module-mocked
 * db/redis, env from fake bindings.
 */

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    query: vi.fn(),
    getLeaderboard: vi.fn(),
    getEloLeaderboard: vi.fn(),
    getWaveLeaderboard: vi.fn(),
    getNameByUuid: vi.fn(async () => null),
    getUuidByDiscordId: vi.fn(async () => null),
    getPlayerProfile: vi.fn(),
    getPlayerBalances: vi.fn(),
  };
});

vi.mock('../db/redis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/redis.js')>();
  return {
    ...actual,
    getCachedJson: vi.fn(async () => null),
    setCachedJson: vi.fn(async () => undefined),
    deleteCachedJson: vi.fn(async () => undefined),
    getOnlinePlayerCount: vi.fn(),
  };
});

import { createApp } from '../app.js';
import { initEnvFromBindings } from '../env.js';
import { signJwt } from '../auth/jwt.js';
import {
  query as queryMock,
  getPlayerProfile as getPlayerProfileMock,
  getPlayerBalances as getPlayerBalancesMock,
} from '../db/pool.js';
import { getCachedJson as getCachedJsonMock, getOnlinePlayerCount as getOnlinePlayerCountMock } from '../db/redis.js';

const TEST_UUID = 'a25a17ce-bca1-4894-92c9-00d7ab5b7875';
const JWT_SECRET = 'unit-test-jwt-secret-0123456789abcdef0123';
const WEBPANEL_SECRET = 'unit-test-webpanel-secret-0123456789abcdef';

let app: ReturnType<typeof createApp>;
let sessionCookie: string;

/** Distinct IP per rate-limit-sensitive test (limiter buckets are module-global). */
let ipSeq = 0;
function nextIp(): string {
  ipSeq += 1;
  return `203.0.113.${ipSeq % 250}`;
}

function reqInit(ip: string, extra: Record<string, string> = {}, withSession = false): RequestInit {
  const headers: Record<string, string> = { 'CF-Connecting-IP': ip, ...extra };
  if (withSession) headers.Cookie = sessionCookie;
  return { headers };
}

const BOT_HEADERS = { 'X-Bot-Token': 'test-bot-token' };

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
    VOTE_CALLBACK_KEYS: 'planetminecraft:test-vote-key',
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
  vi.mocked(getPlayerProfileMock).mockReset();
  vi.mocked(getPlayerBalancesMock).mockReset();
  vi.mocked(getOnlinePlayerCountMock).mockReset();
  vi.mocked(getOnlinePlayerCountMock).mockResolvedValue(3);
});

/* ------------------------------------------------------------------ LFG */

describe('POST /api/lfg/posts', () => {
  const body = { dungeon: 'cloaca_maxima', note: 'need healer', discordId: '999000111222333444', username: 'Caesar' };

  function lastInsertParams(): unknown[] {
    const call = vi.mocked(queryMock).mock.calls.find(([sql]) => (sql as string).includes('INSERT INTO lfg_posts'));
    if (!call) throw new Error('no lfg_posts insert captured');
    return call[1] as unknown[];
  }

  it('bot token: 202 with postId + expiresAt 15 minutes out', async () => {
    stubQuery([{ match: (sql) => sql.includes('INSERT INTO lfg_posts'), rows: [{ id: 9 }] }]);
    const res = await app.request('/api/lfg/posts', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': nextIp(), ...BOT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(202);
    const parsed = (await res.json()) as { ok: boolean; postId: string; expiresAt: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.postId).toBe('9');
    const ttl = Date.parse(parsed.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(13 * 60_000);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000);
    const [dungeon, note, discordId, username] = lastInsertParams() as [string, string, string, string];
    expect([dungeon, note, discordId, username]).toEqual(['cloaca_maxima', 'need healer', '999000111222333444', 'Caesar']);
  });

  it('401 without the bot token', async () => {
    const res = await app.request('/api/lfg/posts', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': nextIp(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(401);
  });

  it('400 for a bad body (uppercase dungeon / bad discordId)', async () => {
    for (const bad of [
      { ...body, dungeon: 'Not A Slug' },
      { ...body, discordId: 'abc' },
      { dungeon: 'ok', discordId: '999000111222333444' }, // missing username
    ]) {
      const res = await app.request('/api/lfg/posts', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': nextIp(), ...BOT_HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify(bad),
      });
      expect(res.status).toBe(400);
    }
  });

  it('503 when the lfg_posts table does not exist yet (worker degrades)', async () => {
    vi.mocked(queryMock).mockRejectedValue(new Error('relation does not exist'));
    const res = await app.request('/api/lfg/posts', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': nextIp(), ...BOT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(503);
  });
});

/* -------------------------------------------------------------- Bounties */

describe('GET /api/bounties/top', () => {
  it('200 with OPEN pools grouped by target (names resolved)', async () => {
    stubQuery([
      {
        match: (sql) => sql.includes('FROM pvp_bounty_board'),
        rows: [
          { target_uuid: TEST_UUID, pool: '500000', placers: '3', username: 'Caesar' },
          { target_uuid: 'b25a17ce-bca1-4894-92c9-00d7ab5b7875', pool: '100000', placers: '1', username: null },
        ],
      },
    ]);
    const res = await app.request('/api/bounties/top?limit=2', reqInit(nextIp()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean; entries: Array<{ rank: number; target: string; amount: number; placers: number }> };
    expect(body.available).toBe(true);
    expect(body.entries[0]).toEqual({ rank: 1, target: 'Caesar', amount: 500000, placers: 3 });
    expect(body.entries[1].target).toBe('b25a17ce-bca1-4894-92c9-00d7ab5b7875');
    // Only OPEN state is queried
    const sql = vi.mocked(queryMock).mock.calls[0]![0] as string;
    expect(sql).toContain("state = 'OPEN'");
  });

  it('degrades to an empty board when the plugin table is missing', async () => {
    vi.mocked(queryMock).mockRejectedValue(new Error('relation does not exist'));
    const res = await app.request('/api/bounties/top', reqInit(nextIp()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean; entries: unknown[] };
    expect(body).toEqual({ available: false, entries: [] });
  });
});

/* ----------------------------------------------------------- Events feed */

describe('GET /api/events/feed', () => {
  it('401 without the bot token', async () => {
    const res = await app.request('/api/events/feed?since=2026-08-14T00:00:00Z', reqInit(nextIp()));
    expect(res.status).toBe(401);
  });

  it('400 for a non-ISO since', async () => {
    const res = await app.request('/api/events/feed?since=yesterday', reqInit(nextIp(), BOT_HEADERS));
    expect(res.status).toBe(400);
  });

  it('200 with rows filtered to the documented event types', async () => {
    stubQuery([
      {
        match: (sql) => sql.includes('FROM web_events'),
        rows: [
          { id: 2, event_type: 'war_result', uuid: TEST_UUID, message: 'Legio I victorious', at: '2026-08-14T12:00:00Z' },
          { id: 1, event_type: 'contract_fulfilled', uuid: TEST_UUID, message: 'Contract delivered', at: '2026-08-14T11:00:00Z' },
          { id: 3, event_type: 'something_else', uuid: TEST_UUID, message: 'noise', at: '2026-08-14T13:00:00Z' },
        ],
      },
    ]);
    const res = await app.request('/api/events/feed?since=2026-08-14T10:00:00Z', reqInit(nextIp(), BOT_HEADERS));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean; events: Array<{ id: string; type: string }> };
    expect(body.available).toBe(true);
    expect(body.events).toHaveLength(2);
    expect(body.events.every((e) => e.type !== 'something_else')).toBe(true);
  });

  it('degrades to an empty feed until the plugin ships the producer', async () => {
    vi.mocked(queryMock).mockRejectedValue(new Error('relation does not exist'));
    const res = await app.request('/api/events/feed?since=2026-08-14T00:00:00Z', reqInit(nextIp(), BOT_HEADERS));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean; events: unknown[] };
    expect(body).toEqual({ available: false, events: [] });
  });
});

/* ------------------------------------------------------------ Vote status */

describe('GET /api/vote/status', () => {
  it('session (self): pending rows + lifetime total', async () => {
    stubQuery([
      { match: (sql) => sql.includes('FROM web_queue'), rows: [{ site: 'planetminecraft', created_at: '2026-08-14T10:00:00Z' }] },
      { match: (sql) => sql.includes('FROM vote_claims'), rows: [{ count: '12' }] },
    ]);
    const res = await app.request('/api/vote/status', reqInit(nextIp(), {}, true));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { uuid: string; available: boolean; pending: Array<{ site: string }>; totalVotes: number };
    expect(body.uuid).toBe(TEST_UUID);
    expect(body.available).toBe(true);
    expect(body.pending).toEqual([{ site: 'planetminecraft', queuedAt: '2026-08-14T10:00:00Z' }]);
    expect(body.totalVotes).toBe(12);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('bot token may target any uuid', async () => {
    stubQuery([
      { match: (sql) => sql.includes('FROM web_queue'), rows: [] },
      { match: (sql) => sql.includes('FROM vote_claims'), rows: [] },
    ]);
    const res = await app.request(`/api/vote/status?uuid=${TEST_UUID}`, reqInit(nextIp(), BOT_HEADERS));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean; pending: unknown[]; totalVotes?: number };
    expect(body.available).toBe(true);
    expect(body.pending).toEqual([]);
    expect(body.totalVotes).toBe(0);
  });

  it('targeted read without the bot token is 401 (no session fallback)', async () => {
    const res = await app.request(`/api/vote/status?uuid=${TEST_UUID}`, reqInit(nextIp()));
    expect(res.status).toBe(401);
  });

  it('anonymous (no uuid, no session) is 401', async () => {
    const res = await app.request('/api/vote/status', reqInit(nextIp()));
    expect(res.status).toBe(401);
  });

  it('degrades when web_queue is unreachable', async () => {
    vi.mocked(queryMock).mockRejectedValue(new Error('db down'));
    const res = await app.request('/api/vote/status', reqInit(nextIp(), {}, true));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean; pending: unknown[] };
    expect(body.available).toBe(false);
    expect(body.pending).toEqual([]);
  });
});

/* ------------------------------------------------------------ Shop orders */

describe('GET /api/shop/orders', () => {
  it('session (self): rows with totals from the queue payload', async () => {
    stubQuery([
      {
        match: (sql) => sql.includes('FROM web_queue'),
        rows: [
          {
            id: 7, request_id: 'V1StGXR8_Z5jdHi6B', sku: 'key_vote_5', quantity: 2,
            status: 'done', created_at: '2026-08-14T10:00:00Z', processed_at: '2026-08-14T10:00:05Z',
            payload: { totalPrice: 15000 },
          },
        ],
      },
    ]);
    const res = await app.request('/api/shop/orders', reqInit(nextIp(), {}, true));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      orders: Array<{ id: string; sku: string; quantity: number; totalPrice: number; currency: string; status: string }>;
    };
    expect(body.orders).toHaveLength(1);
    expect(body.orders[0]).toMatchObject({ id: '7', sku: 'key_vote_5', quantity: 2, totalPrice: 15000, currency: 'denarius', status: 'done' });
  });

  it('re-derives the total from the catalog when the payload lacks one', async () => {
    stubQuery([
      {
        match: (sql) => sql.includes('FROM web_queue'),
        rows: [
          { id: 8, request_id: 'x', sku: 'aureus_100', quantity: 1, status: 'pending', created_at: '2026-08-14T10:00:00Z', processed_at: null, payload: {} },
        ],
      },
    ]);
    const res = await app.request('/api/shop/orders', reqInit(nextIp(), {}, true));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orders: Array<{ totalPrice: number }> };
    expect(body.orders[0].totalPrice).toBe(5000); // catalog price for aureus_100
  });

  it('401 anonymous; 503 when the queue table errors', async () => {
    expect((await app.request('/api/shop/orders', reqInit(nextIp()))).status).toBe(401);
    vi.mocked(queryMock).mockRejectedValue(new Error('db down'));
    const res = await app.request('/api/shop/orders', reqInit(nextIp(), {}, true));
    expect(res.status).toBe(503);
  });
});

/* --------------------------------------------------- Seasons enrichment */

describe('GET /api/seasons/current (12c enrichment)', () => {
  it('events filters to war/colosseum with signupDeadline; festival from the live row', async () => {
    stubQuery([
      { match: (sql) => sql.includes('FROM seasonal_data'), rows: [] },
      {
        match: (sql) => sql.includes('FROM events_calendar'),
        rows: [
          { id: 1, name: 'Legion War', kind: 'war', starts_at: '2026-08-15T18:00:00Z', ends_at: '2026-08-15T19:00:00Z', signup_deadline: null },
          { id: 2, name: 'Colosseum Cup', kind: 'colosseum', starts_at: '2026-08-16T18:00:00Z', ends_at: '2026-08-16T20:00:00Z', signup_deadline: '2026-08-16T17:00:00Z' },
          { id: 3, name: 'KOTH: Citadel', kind: 'koth', starts_at: '2026-08-17T18:00:00Z', ends_at: '2026-08-17T19:00:00Z', signup_deadline: null },
        ],
      },
      {
        match: (sql) => sql.includes('FROM festivals'),
        rows: [{ id: 5, name: 'Crate Festival', starts_at: '2026-08-14T00:00:00Z', ends_at: '2026-08-16T00:00:00Z' }],
      },
    ]);
    const res = await app.request('/api/seasons/current', reqInit(nextIp()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: Array<{ id: number; type: string; name: string; signupDeadline?: string }>;
      festival: { id: number; name: string; active: boolean; endsAt: string } | null;
    };
    expect(body.events).toHaveLength(2);
    expect(body.events[0]).toMatchObject({ id: 1, type: 'war', name: 'Legion War' });
    expect(body.events[0].signupDeadline).toBeUndefined();
    expect(body.events[1]).toMatchObject({ id: 2, type: 'colosseum', signupDeadline: '2026-08-16T17:00:00Z' });
    expect(body.festival).toEqual({ id: 5, name: 'Crate Festival', active: true, endsAt: '2026-08-16T00:00:00Z' });
  });

  it('missing calendar/festival tables degrade: events [] and festival null', async () => {
    stubQuery([{ match: (sql) => sql.includes('FROM seasonal_data'), rows: [] }]);
    const res = await app.request('/api/seasons/current', reqInit(nextIp()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: unknown[]; festival: unknown };
    expect(body.events).toEqual([]);
    expect(body.festival).toBeNull();
  });
});

/* ------------------------------------------------------- Server status */

describe('GET /api/server/status (players list)', () => {
  it('includes the best-effort online name list', async () => {
    stubQuery([
      { match: (sql) => sql.includes('FROM online_players'), rows: [{ username: 'Caesar' }, { username: null }, { username: 'Titus' }] },
    ]);
    const res = await app.request('/api/server/status', reqInit(nextIp()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { online: boolean; players: string[] };
    expect(body.online).toBe(true);
    expect(body.players).toEqual(['Caesar', 'Titus']);
  });

  it('degrades to an empty list when the snapshot table is missing', async () => {
    stubQuery([{ match: (sql) => sql.includes('FROM online_players'), rows: [] }]);
    const res = await app.request('/api/server/status', reqInit(nextIp()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { players: string[] };
    expect(body.players).toEqual([]);
  });
});

/* ------------------------------------------------------------- Profile */

describe('GET /api/player/profile (legion + koth extras)', () => {
  it('carries legion name and kothRecord derived from live tables', async () => {
    vi.mocked(getPlayerProfileMock).mockResolvedValue({
      rank: { level: 12, name: 'XII', progress: 40 },
      prestige: null,
      stats: null,
    } as never);
    vi.mocked(getPlayerBalancesMock).mockResolvedValue({
      denarius: 1000, tokens: 0, beacons: 0, goldenCoins: 4,
    } as never);
    stubQuery([
      { match: (sql) => sql.includes('FROM legion_members'), rows: [{ name: 'LegioI' }] },
      { match: (sql) => sql.includes('FROM leaderboard_stats'), rows: [{ total: '4' }] },
    ]);
    const res = await app.request(`/api/player/profile?uuid=${TEST_UUID}`, reqInit(nextIp(), BOT_HEADERS));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { legion: string | null; kothRecord: string | null };
    expect(body.legion).toBe('LegioI');
    expect(body.kothRecord).toBe('4 wins');
  });

  it('missing tables omit the fields instead of failing the profile', async () => {
    vi.mocked(getPlayerProfileMock).mockResolvedValue({
      rank: null, prestige: null, stats: null,
    } as never);
    vi.mocked(getPlayerBalancesMock).mockResolvedValue({
      denarius: 0, tokens: 0, beacons: 0, goldenCoins: 0,
    } as never);
    stubQuery([]); // legion/koth queries throw inside try/catch — degrade to null
    const res = await app.request(`/api/player/profile?uuid=${TEST_UUID}`, reqInit(nextIp(), BOT_HEADERS));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { legion: string | null; kothRecord: string | null };
    expect(body.legion).toBeNull();
    expect(body.kothRecord).toBeNull();
  });
});

/* -------------------------------------------------------- Drift alerts */

describe('GET /api/economy/drift-alerts', () => {
  it('401 without the bot token; 200 with alerts when the table is live', async () => {
    expect((await app.request('/api/economy/drift-alerts', reqInit(nextIp()))).status).toBe(401);

    stubQuery([
      {
        match: (sql) => sql.includes('FROM economy_drift_alerts'),
        rows: [
          { id: 1, detected_at: '2026-08-14T09:00:00Z', metric: 'faucet:minesell', direction: 'up', magnitude_pct: 12.5, status: 'open', summary: 'Minesell faucet share rose 12.5%' },
        ],
      },
    ]);
    const res = await app.request('/api/economy/drift-alerts', reqInit(nextIp(), BOT_HEADERS));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean; alerts: Array<{ direction: string; status: string; magnitudePct: number }> };
    expect(body.available).toBe(true);
    expect(body.alerts[0]).toMatchObject({ direction: 'up', status: 'open', magnitudePct: 12.5 });
  });

  it('degrades to an empty inbox until the plugin ships the monitor table', async () => {
    vi.mocked(queryMock).mockRejectedValue(new Error('relation does not exist'));
    const res = await app.request('/api/economy/drift-alerts', reqInit(nextIp(), BOT_HEADERS));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean; alerts: unknown[] };
    expect(body).toEqual({ available: false, alerts: [] });
  });
});

/* ------------------------------------------------------------- Live-ops */

describe('GET /api/admin/liveops', () => {
  it('401 without the bot token; 200 with overrides + festival ledger', async () => {
    expect((await app.request('/api/admin/liveops', reqInit(nextIp()))).status).toBe(401);

    stubQuery([
      {
        match: (sql) => sql.includes('FROM events_calendar_overrides'),
        rows: [{ id: 3, actor: 'Caesar', action: 'skip', target: 'KOTH: Citadel', note: 'patch night', at: '2026-08-14T08:00:00Z' }],
      },
      {
        match: (sql) => sql.includes('FROM festival_fund_ledger'),
        rows: [{ ts: '2026-08-14T09:30:00Z', kind: 'CREDIT', source: 'lottery:2026-08-14', amount: 12500, actor: 'system' }],
      },
    ]);
    const res = await app.request('/api/admin/liveops', reqInit(nextIp(), BOT_HEADERS));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      available: boolean;
      overrides: Array<{ id: string; action: string; target?: string }>;
      festivalLedger: Array<{ entry: string; amount: number }>;
    };
    expect(body.available).toBe(true);
    expect(body.overrides[0]).toMatchObject({ id: '3', action: 'skip', target: 'KOTH: Citadel' });
    expect(body.festivalLedger[0].entry).toContain('lottery:2026-08-14');
    expect(body.festivalLedger[0].amount).toBe(12500);
  });

  it('degrades section-by-section when tables are missing', async () => {
    vi.mocked(queryMock).mockRejectedValue(new Error('relation does not exist'));
    const res = await app.request('/api/admin/liveops', reqInit(nextIp(), BOT_HEADERS));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean; overrides: unknown[]; festivalLedger: unknown[] };
    expect(body.available).toBe(false);
    expect(body.overrides).toEqual([]);
    expect(body.festivalLedger).toEqual([]);
  });
});

/* ----------------------------------------------------------- Contraband */

describe('GET /api/admin/contraband/sweeps', () => {
  it('401 without the bot token; 200 with sweeps + verdict stats', async () => {
    expect((await app.request('/api/admin/contraband/sweeps', reqInit(nextIp()))).status).toBe(401);

    stubQuery([
      {
        match: (sql) => sql.includes('FROM contraband_sweeps') && sql.includes('LIMIT'),
        rows: [{ id: 1, swept_at: '2026-08-14T07:00:00Z', target_name: 'Brutus', target_uuid: TEST_UUID, items: 3, verdict: 'confiscated', action: 'stripped', staff: null }],
      },
      {
        match: (sql) => sql.includes('GROUP BY verdict'),
        rows: [{ verdict: 'confiscated', count: '5' }, { verdict: 'cleared', count: '20' }],
      },
    ]);
    const res = await app.request('/api/admin/contraband/sweeps?limit=25', reqInit(nextIp(), BOT_HEADERS));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sweeps: Array<{ target: string; items: number; verdict: string }>;
      verdictStats: Array<{ verdict: string; count: number }>;
    };
    expect(body.sweeps[0]).toMatchObject({ target: 'Brutus', items: 3, verdict: 'confiscated' });
    expect(body.verdictStats).toEqual([{ verdict: 'confiscated', count: 5 }, { verdict: 'cleared', count: 20 }]);
  });

  it('degrades to an empty log until the sweeper writes a table', async () => {
    vi.mocked(queryMock).mockRejectedValue(new Error('relation does not exist'));
    const res = await app.request('/api/admin/contraband/sweeps', reqInit(nextIp(), BOT_HEADERS));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean; sweeps: unknown[]; verdictStats: unknown[] };
    expect(body).toEqual({ available: false, sweeps: [], verdictStats: [] });
  });
});

/* --------------------------------------------------------- Player tools */

describe('GET /api/admin/player-tools', () => {
  it('401 without bot token; 400 for a bad uuid', async () => {
    expect((await app.request('/api/admin/player-tools', reqInit(nextIp()))).status).toBe(401);
    expect((await app.request('/api/admin/player-tools?uuid=nope', reqInit(nextIp(), BOT_HEADERS))).status).toBe(400);
  });

  it('200 with flow tail + lockouts + pity counters', async () => {
    stubQuery([
      {
        match: (sql) => sql.includes('FROM economy_transactions'),
        rows: [
          { type: 'MINED_SELL', currency: 'denarius', amount: '150000', description: 'service:minesell', created_at: '2026-08-14T10:00:00Z' },
        ],
      },
      {
        match: (sql) => sql.includes('FROM dungeon_lockouts'),
        rows: [{ dungeon_id: 'cloaca_maxima', locked_until: '2026-08-15T10:00:00Z' }],
      },
      {
        match: (sql) => sql.includes('FROM pity_counters'),
        rows: [{ counter_id: 'cosmic_storm', rolls: 40, threshold: 100 }],
      },
    ]);
    const res = await app.request(`/api/admin/player-tools?uuid=${TEST_UUID}`, reqInit(nextIp(), BOT_HEADERS));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      player: {
        flowTail: Array<{ reason: string; amount: number }>;
        lockouts: Array<{ id: string; type: string; active: boolean }>;
        pity: Array<{ id: string; rolls: number; threshold: number }>;
      };
    };
    expect(body.player.flowTail[0]).toMatchObject({ reason: 'service:minesell', amount: 1500 });
    expect(body.player.lockouts[0]).toMatchObject({ id: 'cloaca_maxima', type: 'dungeon', active: true });
    expect(body.player.pity[0]).toEqual({ id: 'cosmic_storm', rolls: 40, threshold: 100 });
  });

  it('degrades per-section when specced tables are missing', async () => {
    stubQuery([
      {
        match: (sql) => sql.includes('FROM economy_transactions'),
        rows: [{ type: 'MINED_SELL', currency: 'denarius', amount: '150000', description: null, created_at: '2026-08-14T10:00:00Z' }],
      },
    ]);
    // dungeon_lockouts / pity_counters are NOT stubbed — stubQuery throws for
    // them, which the endpoint must swallow into empty sections.
    const res = await app.request(`/api/admin/player-tools?uuid=${TEST_UUID}`, reqInit(nextIp(), BOT_HEADERS));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { player: { lockouts: unknown[]; pity: unknown[] } };
    expect(body.player.lockouts).toEqual([]);
    expect(body.player.pity).toEqual([]);
  });
});

/* SWR short-circuit still applies to the new cached endpoints */
describe('SWR cache HIT short-circuits bounties', () => {
  it('serves a fresh cached board without touching Postgres', async () => {
    vi.mocked(getCachedJsonMock).mockResolvedValueOnce({
      data: { available: true, entries: [{ rank: 1, target: 'Cached', amount: 1, placers: 1 }] },
      fetchedAt: Date.now(),
    });
    const res = await app.request('/api/bounties/top', reqInit(nextIp()));
    expect(res.status).toBe(200);
    expect(res.headers.get('X-Cache')).toBe('HIT');
    expect(vi.mocked(queryMock)).not.toHaveBeenCalled();
  });
});
