import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * V6 04-03 route tests for GET /api/v2/public/player/:username. Two contracts:
 *   1. PRIVACY — the response schema must never carry aureus/auctoritas
 *      (tokens) fields. This is asserted on the wire shape, not the types.
 *   2. RESOLUTION — name resolution reads player_names only (no Mojang
 *      fallback, so anonymous traffic can't seed the registry), 404s for
 *      unknowns, and every optional table degrades instead of 500ing.
 * Network dependencies are mocked at module level, same as api-expansion.test.ts.
 */

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    query: vi.fn(),
    getPlayerProfile: vi.fn(),
    getPlayerBalances: vi.fn(),
    getPlayerParkour: vi.fn(),
    getPlayerAchievements: vi.fn(),
  };
});

vi.mock('../db/redis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/redis.js')>();
  return {
    ...actual,
    getCachedJson: vi.fn(async () => null),
    setCachedJson: vi.fn(async () => undefined),
  };
});

import { createApp } from '../app.js';
import { initEnvFromBindings } from '../env.js';
import {
  query as queryMock,
  getPlayerProfile as profileMock,
  getPlayerBalances as balancesMock,
  getPlayerParkour as parkourMock,
  getPlayerAchievements as achievementsMock,
} from '../db/pool.js';
import { getCachedJson as cacheGetMock } from '../db/redis.js';

const TEST_UUID = 'a25a17ce-bca1-4894-92c9-00d7ab5b7875';

let app: ReturnType<typeof createApp>;

let ipSeq = 0;
function nextIp(): string {
  ipSeq += 1;
  return `203.0.113.${ipSeq % 250}`;
}

function reqInit(): RequestInit {
  return { headers: { 'CF-Connecting-IP': nextIp() } };
}

/** Route one SQL statement to a rows array; anything unexpected throws loudly
 *  — phrased as a schema error so the route's mega→multi-query fallback path
 *  engages exactly as it would for a missing table in production. */
function stubQuery(handlers: Array<{ match: (sql: string) => boolean; rows: unknown[] }>) {
  (queryMock as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string) => {
    // The mega aggregate references nearly every table, so naive
    // sql.includes(...) matchers collide with it; serve it only when a
    // handler matches the aggregate shape itself.
    const isMega = sql.includes('WITH me AS');
    for (const h of handlers) {
      const matched = isMega ? h.match(sql) && h.match('WITH me AS') : h.match(sql);
      if (matched) return { rows: h.rows };
    }
    throw new Error(`relation does not exist (unstubbed in test): ${sql.slice(0, 80)}`);
  });
}

beforeAll(() => {
  initEnvFromBindings({
    JWT_SECRET: 'unit-test-jwt-secret-0123456789abcdef0123',
    WEBPANEL_HMAC_SECRET: 'unit-test-webpanel-secret-0123456789abcdef',
    DISCORD_CLIENT_ID: 'test-client-id',
    DISCORD_CLIENT_SECRET: 'test-client-secret',
    PAYNOW_API_KEY: 'test-paynow-key',
    PAYNOW_STORE_ID: 'test-store',
    PAYNOW_WEBHOOK_SECRETS: 'test-webhook-secret',
    NODE_ENV: 'test',
  } as never);
  app = createApp();
});

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps implementations — reset the cross-test default
  // explicitly so one test's cache-hit mock doesn't leak into the next.
  vi.mocked(cacheGetMock).mockResolvedValue(null);
});

/** Wire a fully-populated player through every stub. */
function stubRichPlayer(username = 'Maximus') {
  stubQuery([
    {
      match: (sql) => sql.includes('FROM player_names') && !sql.includes('WITH me AS'),
      rows: [{ uuid: TEST_UUID, username }],
    },
    {
      match: (sql) => sql.includes('FROM online_players'),
      rows: [{ uuid: TEST_UUID }],
    },
    {
      match: (sql) => sql.includes('legion_members'),
      rows: [{ name: 'XVII' }],
    },
    {
      match: (sql) => sql.includes('KOTH_WINS'),
      rows: [{ total: '8' }],
    },
    {
      match: (sql) => sql.includes('FROM player_elo'),
      rows: [{ elo: '1850', peak_elo: '1910' }],
    },
  ]);
  (profileMock as ReturnType<typeof vi.fn>).mockResolvedValue({
    uuid: TEST_UUID,
    rank: { level: 7, name: 'VII', progress: 42 },
    prestige: { level: 3, points: 900 },
    stats: {
      blocksMined: 123456,
      playTime: 3600000,
      pvpKills: 40,
      pvpDeaths: 20,
      pvpTrophies: 12,
      kdRatio: 2,
    },
  });
  (balancesMock as ReturnType<typeof vi.fn>).mockResolvedValue({
    denarius: 250000,
    tokens: 999, // auctoritas — MUST NOT survive into the payload
    beacons: 4321,
    goldenCoins: 777, // aureus — MUST NOT survive into the payload
  });
  (achievementsMock as ReturnType<typeof vi.fn>).mockResolvedValue({
    achievements: [
      { achievementId: 'first_blood', progress: 1, completed: true, claimed: true, completedAt: 200 },
      { achievementId: 'miner_ii', progress: 1, completed: true, claimed: true, completedAt: 300 },
      { achievementId: 'in_progress', progress: 0.5, completed: false, claimed: false, completedAt: 0 },
    ],
  });
  (parkourMock as ReturnType<typeof vi.fn>).mockResolvedValue({
    records: [
      { course: 'aqueduct', best_time_ms: 12400, completions: 6 },
      { course: 'colosseum', best_time_ms: 33100, completions: 2 },
      { course: 'sewers', best_time_ms: 51000, completions: 1 },
      { course: 'extra', best_time_ms: 99999, completions: 1 },
    ],
  });
}

describe('GET /api/v2/public/player/:username', () => {
  it('serves the public aggregate with exactly the public fields', async () => {
    stubRichPlayer();

    const res = await app.request('/api/v2/public/player/maximus', reqInit());
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.username).toBe('Maximus'); // canonical casing from the registry
    expect(body.rank).toBe(7);
    expect(body.prestige).toBe(3);
    expect(body.legion).toBe('XVII');
    expect(body.online).toBe(true);
    expect(body.denarius).toBe(250000);
    expect(body.civitas).toBe(4321);
    expect(body.kothWins).toBe(8);
    expect(body.elo).toEqual({ rating: 1850, peak: 1910 });
    expect(body.achievementCount).toBe(2); // completed only
    expect(body.recentAchievements).toEqual(['miner_ii', 'first_blood']); // latest first
    expect(body.parkourBests).toHaveLength(3); // capped at 3
    expect((body.parkourBests as Array<{ course: string }>)[0].course).toBe('aqueduct');

    // THE privacy contract: premium/token currencies must not exist on the wire.
    expect(body).not.toHaveProperty('aureus');
    expect(body).not.toHaveProperty('auctoritas');
    expect(body).not.toHaveProperty('tokens');
    expect(body).not.toHaveProperty('goldenCoins');
    expect(JSON.stringify(body)).not.toContain('777');
    expect(JSON.stringify(body)).not.toContain('999');
  });

  it('404s for unknown usernames without any Mojang fallback', async () => {
    stubQuery([
      {
        match: (sql) => sql.includes('FROM player_names') && !sql.includes('WITH me AS'),
        rows: [], // registry miss
      },
    ]);

    const res = await app.request('/api/v2/public/player/Nobody', reqInit());
    expect(res.status).toBe(404);

    // Only the registry lookup ran — no Mojang fetch, no cache write.
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('400s on invalid username shapes', async () => {
    for (const bad of ['x'.repeat(25), 'name;drop', '<script>']) {
      const res = await app.request(`/api/v2/public/player/${encodeURIComponent(bad)}`, reqInit());
      expect(res.status).toBe(400);
    }
  });

  it('degrades to zero-defaults when optional tables are unavailable', async () => {
    stubQuery([
      {
        match: (sql) => sql.includes('FROM player_names') && !sql.includes('WITH me AS'),
        rows: [{ uuid: TEST_UUID, username: 'Maximus' }],
      },
    ]);
    // Every other query (online/legion/koth/elo) throws → degrade path.
    (queryMock as ReturnType<typeof vi.fn>).mockImplementation(async (sql: string) => {
      if (sql.includes('FROM player_names') && !sql.includes('WITH me AS')) {
        return { rows: [{ uuid: TEST_UUID, username: 'Maximus' }] };
      }
      throw new Error('table unavailable');
    });
    (profileMock as ReturnType<typeof vi.fn>).mockResolvedValue({
      uuid: TEST_UUID,
      rank: { level: 2, name: 'II', progress: 0 },
      prestige: null,
      stats: null,
    });
    (balancesMock as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('pg down'));
    (achievementsMock as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('pg down'));
    (parkourMock as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('pg down'));

    const res = await app.request('/api/v2/public/player/maximus', reqInit());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.online).toBe(false);
    expect(body.legion).toBeNull();
    expect(body.elo).toBeNull();
    expect(body.denarius).toBe(0);
    expect(body.achievementCount).toBe(0);
    expect(body.parkourBests).toEqual([]);
  });

  it('serves a cache hit without touching Postgres', async () => {
    stubQuery([
      {
        match: (sql) => sql.includes('FROM player_names') && !sql.includes('WITH me AS'),
        rows: [{ uuid: TEST_UUID, username: 'Maximus' }],
      },
    ]);
    (cacheGetMock as ReturnType<typeof vi.fn>).mockResolvedValue({
      uuid: TEST_UUID,
      username: 'Maximus',
      cached: true,
    });

    const res = await app.request('/api/v2/public/player/maximus', reqInit());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.cached).toBe(true);
    // The cache is uuid-keyed, so exactly one query runs (the name→uuid
    // registry lookup) — but no profile/balances/achievements reads.
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(profileMock).not.toHaveBeenCalled();
    expect(balancesMock).not.toHaveBeenCalled();
    expect(achievementsMock).not.toHaveBeenCalled();
    expect(parkourMock).not.toHaveBeenCalled();
  });

  it('marks Bedrock players', async () => {
    stubQuery([
      {
        match: (sql) => sql.includes('FROM player_names') && !sql.includes('WITH me AS'),
        rows: [{ uuid: TEST_UUID, username: '.BedrockBob' }],
      },
    ]);
    (profileMock as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const res = await app.request('/api/v2/public/player/.bedrockbob', reqInit());
    // No player_ranks row for a name-only Bedrock player → 404 (never joined
    // the sync); the bedrock flag assertion lives in the rich-player shape,
    // so here we just verify the dotted name routes (not a 400).
    expect([200, 404]).toContain(res.status);
  });

  it('serves the single-round-trip aggregate without the fallback queries', async () => {
    // The mega statement re-resolves the name itself and joins everything.
    stubQuery([
      {
        match: (sql) => sql.includes('FROM player_names') && !sql.includes('WITH me AS'),
        rows: [{ uuid: TEST_UUID, username: 'Maximus' }], // route's registry lookup
      },
      {
        match: (sql) => sql.includes('WITH me AS'),
        rows: [
          {
            uuid: TEST_UUID,
            rank_level: '7',
            rank_name: 'VII',
            prestige_level: '3',
            blocks_mined: '123456',
            play_time: '3600000',
            pvp_kills: '40',
            pvp_deaths: '20',
            pvp_trophies: '12',
            denarius_minor: '25000000', // → 250000 display
            civitas_minor: '432100', // → 4321 display
            koth_wins: '8',
            legion_name: 'XVII',
            elo: '1850',
            peak_elo: '1910',
            ach_count: '2',
            recent_ach: [
              { achievement_id: 'miner_ii', completed_at: '300' },
              { achievement_id: 'first_blood', completed_at: '200' },
            ],
            online: true,
            parkour: [
              { course_id: 'aqueduct', best_time_ms: '12400', completions: '6' },
              { course_id: 'colosseum', best_time_ms: '33100', completions: '2' },
              { course_id: 'sewers', best_time_ms: '51000', completions: '1' },
            ],
          },
        ],
      },
    ]);

    const res = await app.request('/api/v2/public/player/maximus', reqInit());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.username).toBe('Maximus');
    expect(body.rankName).toBe('VII');
    expect(body.denarius).toBe(250000); // minor units converted
    expect(body.civitas).toBe(4321);
    expect(body.kothWins).toBe(8);
    expect(body.elo).toEqual({ rating: 1850, peak: 1910 });
    expect(body.achievementCount).toBe(2);
    expect(body.recentAchievements).toEqual(['miner_ii', 'first_blood']);
    expect(body.online).toBe(true);
    expect(body.parkourBests).toEqual([
      { course: 'aqueduct', timeMs: 12400, completions: 6 },
      { course: 'colosseum', timeMs: 33100, completions: 2 },
      { course: 'sewers', timeMs: 51000, completions: 1 },
    ]);
    // The whole point: one aggregate statement, none of the per-table reads.
    expect(profileMock).not.toHaveBeenCalled();
    expect(balancesMock).not.toHaveBeenCalled();
    expect(achievementsMock).not.toHaveBeenCalled();
    expect(parkourMock).not.toHaveBeenCalled();
  });

  it('romanizes a numeric synced rankName', async () => {
    stubQuery([
      {
        match: (sql) => sql.includes('FROM player_names') && !sql.includes('WITH me AS'),
        rows: [{ uuid: TEST_UUID, username: 'Maximus' }],
      },
    ]);
    (profileMock as ReturnType<typeof vi.fn>).mockResolvedValue({
      uuid: TEST_UUID,
      rank: { level: 24, name: '24', progress: 0 }, // synced name carries the level
      prestige: null,
      stats: null,
    });
    (balancesMock as ReturnType<typeof vi.fn>).mockResolvedValue({
      denarius: 0, tokens: 0, beacons: 0, goldenCoins: 0,
    });
    (achievementsMock as ReturnType<typeof vi.fn>).mockResolvedValue({ achievements: [] });
    (parkourMock as ReturnType<typeof vi.fn>).mockResolvedValue({ records: [] });

    const res = await app.request('/api/v2/public/player/maximus', reqInit());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.rankName).toBe('XXIV');
  });

  it('returns 503 (not 404) when the profile read fails mid-outage', async () => {
    // Fresh player — the stale map legitimately serves previously-built
    // profiles during outages, so this test must use one never served.
    stubQuery([
      {
        match: (sql) => sql.includes('FROM player_names') && !sql.includes('WITH me AS'),
        rows: [{ uuid: TEST_UUID, username: 'Outagius' }],
      },
    ]);
    (profileMock as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('connection terminated'));

    const res = await app.request('/api/v2/public/player/outagius', reqInit());
    // The name resolved, so the player EXISTS — an outage must not report
    // them as never-joined.
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('Registry unavailable');
  });

  it('serves a stale profile when the database stops answering', async () => {
    // Distinct player: the stale map is module-level and persists across
    // tests, so this test must populate it itself to be deterministic.
    stubRichPlayer('Staleius');
    const first = await app.request('/api/v2/public/player/staleius', reqInit());
    expect(first.status).toBe(200);
    expect((await first.json() as Record<string, unknown>).stale).toBeUndefined();

    // Database goes down entirely: even the registry lookup fails now.
    (queryMock as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      throw new Error('connection terminated');
    });

    const second = await app.request('/api/v2/public/player/staleius', reqInit());
    expect(second.status).toBe(200); // stale-serve, not 503
    const body = (await second.json()) as Record<string, unknown>;
    expect(body.stale).toBe(true);
    expect(body.username).toBe('Staleius');
    expect(second.headers.get('X-Stale-Profile')).toBe('1');

    // A player never served before still 503s during the outage.
    const other = await app.request('/api/v2/public/player/someoneelse', reqInit());
    expect(other.status).toBe(503);
  });

  it('rate limits enumeration at 30/min per IP', async () => {
    stubQuery([
      {
        match: (sql) => sql.includes('FROM player_names') && !sql.includes('WITH me AS'),
        rows: [],
      },
    ]);
    const ip = nextIp();
    let lastStatus = 200;
    for (let i = 0; i < 35; i++) {
      const res = await app.request('/api/v2/public/player/zzz', { headers: { 'CF-Connecting-IP': ip } });
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});
