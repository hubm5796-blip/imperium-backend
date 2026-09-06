/**
 * B-28 — /player/lookup oracle + registry writes closed off for sessions.
 *
 * The route used to accept ANY login (link not required) and resolved
 * arbitrary usernames through Mojang/PlayerDB, 404-vs-200 oracling every Java
 * name in existence — then INSERTed the externally-resolved rows into the
 * shared player_names registry the plugin treats as authoritative-ish.
 *
 * Post-fix contract:
 *   - bot/service token: full resolution (external fallback + cache write) —
 *     the trusted path auth/me and the bot panel ride.
 *   - session: LINKED only (unlinked 403 linkRequired), strict username
 *     schema, REGISTRY-ONLY resolution (getUuidByUsername receives
 *     {external:false}: no outbound fetch, no registry write), and every
 *     response (200 AND 404) carries Cache-Control: no-store.
 *   - no auth at all: 401.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { getUuidByUsernameMock, getUuidByDiscordIdMock, fakeD1, pgState, realGetUuidByUsername } = vi.hoisted(() => {
  const fakeD1 = {
    prepare() {
      const runFor = () => ({ run: async () => ({ meta: { changes: 1 } }), first: async () => ({ hits: 1 }) });
      return { bind: () => runFor(), ...runFor() };
    },
  };
  const pgState = {
    queries: [] as Array<{ sql: string; params: unknown[] }>,
    nextRows: [] as Array<Record<string, string>>,
  };
  return {
    getUuidByUsernameMock: vi.fn(),
    getUuidByDiscordIdMock: vi.fn(),
    fakeD1,
    pgState,
    realGetUuidByUsername: { current: null as null | ((username: string, opts?: { external?: boolean }) => Promise<string | null>) },
  };
});

vi.mock('pg', () => {
  return {
    Pool: class {
      constructor() {}
      on() {}
      async end() {}
      async connect() {
        return {
          async query(sql: string, params: unknown[]) {
            pgState.queries.push({ sql, params });
            return { rows: pgState.nextRows, rowCount: pgState.nextRows.length };
          },
          release() {},
        };
      }
    },
  };
});

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  // Capture the REAL implementation so the pool-level contract of
  // external:false can be tested against the fake pg pool.
  realGetUuidByUsername.current = actual.getUuidByUsername;
  return {
    ...actual,
    getD1: () => fakeD1,
    getUuidByUsername: getUuidByUsernameMock,
    getUuidByDiscordId: getUuidByDiscordIdMock,
  };
});

import { createApp } from '../app.js';
import { initEnvFromBindings, __resetEnvForTests } from '../env.js';
import { initPool } from '../db/pool.js';
import { signJwt } from '../auth/jwt.js';

let app: ReturnType<typeof createApp>;
const realFetch = globalThis.fetch;

beforeAll(() => {
  __resetEnvForTests();
  initEnvFromBindings({
    JWT_SECRET: 'test-jwt-secret-0123456789abcdef0123456789abcdef',
    WEBPANEL_HMAC_SECRET: 'test-hmac-secret-0123456789abcdef0123456789abcdef',
    DISCORD_CLIENT_ID: 'test-client-id',
    DISCORD_CLIENT_SECRET: 'test-client-secret',
    BOT_API_TOKEN: 'bot-token-test',
    PAYNOW_API_KEY: 'test-paynow-key',
    PAYNOW_STORE_ID: 'test-store',
    PAYNOW_WEBHOOK_SECRETS: 'test-webhook-secret',
    NODE_ENV: 'test',
  } as unknown as Record<string, unknown>);
  initPool('postgresql://fake');
  app = createApp();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  getUuidByUsernameMock.mockReset();
  getUuidByDiscordIdMock.mockReset();
});

async function sessionCookie(linked: boolean): Promise<string> {
  const jwt = await signJwt({ authMethod: 'discord', discordId: '111111111111111111' });
  getUuidByDiscordIdMock.mockResolvedValue(
    linked ? 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' : null,
  );
  return `imperium_session=${jwt}`;
}

async function lookup(username: string, headers: Record<string, string> = {}): Promise<Response> {
  return app.request(`/api/player/lookup?username=${encodeURIComponent(username)}`, { headers });
}

describe('B-28: /player/lookup gate', () => {
  it('no session and no bot token → 401', async () => {
    const res = await lookup('Steve');
    expect(res.status).toBe(401);
    expect(getUuidByUsernameMock).not.toHaveBeenCalled();
  });

  it('an UNLINKED session is refused with linkRequired (was: any login could resolve names)', async () => {
    const res = await lookup('Steve', { Cookie: await sessionCookie(false) });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ linkRequired: true });
    expect(getUuidByUsernameMock).not.toHaveBeenCalled();
  });

  it('a linked session resolves REGISTRY-ONLY (external:false) and gets no-store', async () => {
    getUuidByUsernameMock.mockResolvedValue('a25a17ce-bca1-4894-92c9-00d7ab5b7875');
    const res = await lookup('Steve', { Cookie: await sessionCookie(true) });
    expect(res.status).toBe(200);
    expect(getUuidByUsernameMock).toHaveBeenCalledWith('Steve', { external: false });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ username: 'Steve' });
  });

  it('a bot token keeps the full external resolution path (auth/me / bot panel compatibility)', async () => {
    getUuidByUsernameMock.mockResolvedValue('a25a17ce-bca1-4894-92c9-00d7ab5b7875');
    const res = await lookup('Steve', { 'X-Bot-Token': 'bot-token-test' });
    expect(res.status).toBe(200);
    expect(getUuidByUsernameMock).toHaveBeenCalledWith('Steve', { external: true });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('usernames outside the strict schema are rejected before any lookup', async () => {
    for (const bad of ['', 'Two Words', 'x'.repeat(17), 'name;delete', '<script>']) {
      getUuidByUsernameMock.mockClear();
      const res = await lookup(bad, { 'X-Bot-Token': 'bot-token-test' });
      expect(res.status, `username "${bad}"`).toBe(bad === '' ? 400 : 400);
      expect(getUuidByUsernameMock).not.toHaveBeenCalled();
    }
  });

  it('a registry miss 404s with no-store (never a Mojang probe from a session)', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    getUuidByUsernameMock.mockResolvedValue(null);
    const res = await lookup('NeverSeen', { Cookie: await sessionCookie(true) });
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/** Pool-level: external:false must stop at the registry — no fetch, no INSERT. */
describe('B-28: getUuidByUsername({external:false}) stops at the registry', () => {
  beforeEach(() => {
    pgState.queries.length = 0;
    pgState.nextRows = [];
  });

  it('a registry miss performs NO outbound fetch and NO cache-write INSERT', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    pgState.nextRows = []; // registry miss
    const uuid = await realGetUuidByUsername.current!('NeverSeen', { external: false });
    expect(uuid).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(pgState.queries.some((q) => q.sql.includes('INSERT INTO player_names'))).toBe(false);
    expect(pgState.queries).toHaveLength(1); // only the registry SELECT
  });

  it('a registry hit resolves without touching Mojang either', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    pgState.nextRows = [{ uuid: 'a25a17ce-bca1-4894-92c9-00d7ab5b7875' }];
    const uuid = await realGetUuidByUsername.current!('Steve', { external: false });
    expect(uuid).toBe('a25a17ce-bca1-4894-92c9-00d7ab5b7875');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('the trusted default (external) still falls back to Mojang and caches the row', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: 'a25a17cebca1489492c900d7ab5b7875', name: 'MojangSteve' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    pgState.nextRows = []; // registry miss → external fallback
    const uuid = await realGetUuidByUsername.current!('MojangSteve');
    expect(uuid).toBe('a25a17ce-bca1-4894-92c9-00d7ab5b7875');
    expect(pgState.queries.some((q) => q.sql.includes('INSERT INTO player_names'))).toBe(true);
  });
});

afterAll(() => {
  globalThis.fetch = realFetch;
});
