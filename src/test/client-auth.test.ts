import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Issue #2 — client API sign-in via the Mojang session check.
 *
 * The sessionserver is MOCKED (fetch stub answering hasJoined), Redis is an
 * in-memory stand-in honoring SET EX / GETDEL semantics (same transport-mock
 * pattern as atomic-consume.test.ts), and the Postgres pool is stubbed for the
 * link lookup. The app, JWT machinery, gates and routes under test are the
 * real ones.
 *
 * Covers: challenge+verify success, 204 not-joined, replayed serverId, expired
 * serverId, mismatched username, client token rejected on a staff route, a
 * store route and as a website cookie, a website session rejected as a bearer
 * client credential, and the allowed-route surface (equip + changelog).
 */

// The Redis transport mock must be in place before anything imports db/redis.
process.env.BUS_TRANSPORT = 'redis';

const { redis, fetchLog, mojang } = vi.hoisted(() => {
  const store = new Map<string, { value: string; expiresAt: number }>();
  let clockOffset = 0;
  return {
    redis: {
      advanceMs(ms: number) {
        clockOffset += ms;
      },
      reset() {
        store.clear();
        clockOffset = 0;
      },
      /** Live entry for a key, honoring the TTL; null when absent/expired. */
      live(key: string) {
        const entry = store.get(key);
        if (!entry) return null;
        if (entry.expiresAt <= Date.now() + clockOffset) {
          store.delete(key);
          return null;
        }
        return entry;
      },
      set(key: string, value: string, ttlSeconds: number) {
        store.set(key, { value, expiresAt: Date.now() + clockOffset + ttlSeconds * 1000 });
      },
      take(key: string) {
        const entry = this.live(key);
        if (!entry) return null;
        store.delete(key);
        return entry.value;
      },
    },
    fetchLog: [] as string[],
    mojang: {
      /** ok | nocontent | error | network | wrongname */
      mode: 'ok' as 'ok' | 'nocontent' | 'error' | 'network' | 'wrongname',
      name: 'Griefos',
    },
  };
});

vi.mock('../db/redisSocket.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/redisSocket.js')>();
  return {
    ...actual,
    redisCommand: vi.fn(async (_cfg: unknown, argv: string[]) => {
      const [cmd, key] = argv as [string, string, ...string[]];
      if (cmd === 'SET') {
        const value = argv[2]!;
        const ex = argv.indexOf('EX');
        const ttl = ex >= 0 ? Number.parseInt(argv[ex + 1]!, 10) : 0;
        redis.set(key, value, ttl);
        return 'OK';
      }
      if (cmd === 'GETDEL') return redis.take(key);
      if (cmd === 'GET') return redis.live(key)?.value ?? null;
      if (cmd === 'DEL') return 1;
      return null;
    }),
  };
});

const { poolMocks } = vi.hoisted(() => ({
  poolMocks: {
    query: vi.fn(async (_sql: string) => ({ rows: [] as Array<Record<string, unknown>> })),
    getDiscordIdByUuid: vi.fn(async () => null as string | null),
  },
}));

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    query: poolMocks.query,
    getUuidByDiscordId: vi.fn(async () => null),
    getDiscordIdByUuid: poolMocks.getDiscordIdByUuid,
    getNameByUuid: vi.fn(async () => null),
  };
});

// The equip route dispatches over the bus — stub just that (the challenge
// helpers ride the actual module through the redisSocket mock above).
vi.mock('../db/redis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/redis.js')>();
  return {
    ...actual,
    sendCommandWithResponse: vi.fn(async () => ({
      status: 'OK',
      ok: true,
      data: { equipped: true },
    })),
  };
});

import { jwtVerify } from 'jose';
import { createApp } from '../app.js';
import { initEnvFromBindings } from '../env.js';
import { signJwt, verifyClientJwt } from '../auth/jwt.js';

const UUID_DASHED = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const UUID_UNDASHED = 'aaaaaaaabbbbccccddddeeeeeeeeeeee';

let app: ReturnType<typeof createApp>;
let lastChallenge: { serverId: string; expiresIn: number } | null = null;

async function challenge(): Promise<Response> {
  const res = await app.request('/api/client/auth/challenge', { method: 'POST' });
  if (res.status === 200) {
    lastChallenge = ((await res.json()) as { data: { serverId: string; expiresIn: number } }).data;
  }
  return res;
}

async function verify(username = 'Griefos', serverId?: string): Promise<Response> {
  return app.request('/api/client/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, serverId: serverId ?? lastChallenge?.serverId ?? '' }),
  });
}

/** Fresh client token for the gate tests (full challenge → verify round trip). */
async function freshClientToken(): Promise<string> {
  await challenge();
  const res = await verify();
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { token: string } }).data.token;
}

beforeAll(() => {
  initEnvFromBindings({
    JWT_SECRET: 'test-jwt-secret-0123456789abcdef0123456789abcdef',
    DISCORD_CLIENT_ID: 'test-client-id',
    DISCORD_CLIENT_SECRET: 'test-client-secret',
    WEBPANEL_HMAC_SECRET: 'test-hmac-secret-0123456789abcdef0123456789abcdef',
    BOT_API_TOKEN: 'test-bot-token',
    PAYNOW_API_KEY: 'test-paynow-key',
    PAYNOW_STORE_ID: 'test-store',
    PAYNOW_WEBHOOK_SECRETS: 'test-webhook-secret',
    NODE_ENV: 'test',
  } as unknown as Record<string, unknown>);
  app = createApp();

  // The mocked Mojang sessionserver.
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
    const u = new URL(String(url));
    if (u.hostname !== 'sessionserver.mojang.com') {
      return new Response(JSON.stringify({ unexpected: String(url) }), { status: 500 });
    }
    fetchLog.push(String(url));
    if (mojang.mode === 'network') throw new Error('sessionserver unreachable');
    if (mojang.mode === 'error') return new Response('nope', { status: 500 });
    if (mojang.mode === 'wrongname') {
      return new Response(JSON.stringify({ id: UUID_UNDASHED, name: 'SomeoneElse' }), { status: 200 });
    }
    // hasJoined matches username↔profile exactly — a different name means not joined.
    const username = u.searchParams.get('username');
    if (!username || username.toLowerCase() !== mojang.name.toLowerCase()) {
      return new Response(null, { status: 204 });
    }
    if (mojang.mode === 'nocontent') return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ id: UUID_UNDASHED, name: mojang.name }), { status: 200 });
  }));
});

beforeEach(() => {
  redis.reset();
  fetchLog.length = 0;
  mojang.mode = 'ok';
  mojang.name = 'Griefos';
  poolMocks.getDiscordIdByUuid.mockReset().mockResolvedValue(null);
  lastChallenge = null;
});

describe('issue #2 — challenge + verify (Mojang session check)', () => {
  it('challenge issues a 40-hex-char single-use serverId with a 60s window', async () => {
    const res = await challenge();
    expect(res.status).toBe(200);
    expect(lastChallenge).not.toBeNull();
    expect(lastChallenge!.serverId).toMatch(/^[a-f0-9]{40}$/);
    expect(lastChallenge!.expiresIn).toBe(60);
    // Stored live under the client-auth prefix (single-use, 60s TTL).
    expect(redis.live(`ImperiumMC:client_auth:${lastChallenge!.serverId}`)).not.toBeNull();
  });

  it('verify succeeds on a 200 profile: canonical UUID, mc_client token in the BODY, Discord link attached', async () => {
    poolMocks.getDiscordIdByUuid.mockResolvedValue('222222222222222222');
    await challenge();
    const res = await verify();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { token: string; tokenType: string; expiresIn: number; uuid: string; username: string; discordLinked: boolean };
    };
    expect(body.data.uuid).toBe(UUID_DASHED); // canonicalised undashed → dashed
    expect(body.data.username).toBe('Griefos');
    expect(body.data.tokenType).toBe('Bearer');
    expect(body.data.expiresIn).toBe(24 * 60 * 60);
    expect(body.data.discordLinked).toBe(true);
    // No auth cookie is ever set on this route.
    expect(res.headers.getSetCookie().length).toBe(0);

    // The token verifies through the client verifier (aud + authMethod family).
    const claims = await verifyClientJwt(body.data.token);
    expect(claims).toMatchObject({ authMethod: 'mc_client', mcUuid: UUID_DASHED, discordId: '222222222222222222' });
    // Raw audience claim — the cross-context separation anchor.
    const { payload } = await jwtVerify(
      body.data.token,
      new TextEncoder().encode('test-jwt-secret-0123456789abcdef0123456789abcdef'),
    );
    expect(payload.aud).toBe('imperium-client');
    expect(payload.iss).toBe('imperium-backend');
    // The sessionserver saw the exact hasJoined query.
    expect(fetchLog).toEqual([
      `https://sessionserver.mojang.com/session/minecraft/hasJoined?username=Griefos&serverId=${lastChallenge!.serverId}`,
    ]);
  });

  it('verify works unlinked too (discordLinked false, no discordId claim)', async () => {
    await challenge();
    const res = await verify();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { token: string; discordLinked: boolean } };
    expect(body.data.discordLinked).toBe(false);
    expect((await verifyClientJwt(body.data.token))?.discordId).toBeUndefined();
  });

  it('a 204 from the sessionserver (not joined) is a 401', async () => {
    mojang.mode = 'nocontent';
    await challenge();
    const res = await verify();
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
  });

  it('a replayed serverId is rejected and never re-asks the sessionserver', async () => {
    await challenge();
    fetchLog.length = 0;
    const first = await verify();
    expect(first.status).toBe(200);
    const callsAfterFirst = fetchLog.length;
    const replay = await verify(); // same serverId — already consumed
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as { error: { code: string } }).error.code).toBe('UNAUTHORIZED');
    expect(fetchLog.length).toBe(callsAfterFirst); // no second hasJoined call
  });

  it('an expired serverId is rejected', async () => {
    await challenge();
    redis.advanceMs(61_000); // past the 60s TTL
    const res = await verify();
    expect(res.status).toBe(401);
  });

  it('a mismatched username is a 401 (sessionserver answers 204 for it)', async () => {
    await challenge();
    const res = await verify('NotGriefos');
    expect(res.status).toBe(401);
  });

  it('a 200 profile whose name does not match is still refused (belt and braces)', async () => {
    mojang.mode = 'wrongname';
    await challenge();
    const res = await verify();
    expect(res.status).toBe(401);
  });

  it('a sessionserver outage is a 503 SESSIONSERVER_UNAVAILABLE, not a 401', async () => {
    mojang.mode = 'network';
    await challenge();
    const res = await verify();
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('SESSIONSERVER_UNAVAILABLE');
  });

  it('garbage bodies are a 400 before anything is consumed', async () => {
    await challenge();
    const res = await app.request('/api/client/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'x', serverId: 'nothex' }),
    });
    expect(res.status).toBe(400);
    // A non-issued serverId shape never touches the store or the sessionserver.
    expect(fetchLog.length).toBe(0);
  });
});

describe('issue #2 — client tokens vs the route surface', () => {
  it('a client token reaches an allowlisted write route (cosmetics equip, requireMcIdentity satisfied)', async () => {
    const token = await freshClientToken();
    const res = await app.request('/api/player/cosmetics/equip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: 'equip', cosmetic: 'golden_halo' }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { equipped?: boolean }).equipped).toBe(true);
  });

  it('a client token reaches the allowlisted v2 changelog list', async () => {
    const token = await freshClientToken();
    const res = await app.request('/api/v2/changelog/list', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { posts?: unknown[] }).posts).toEqual([]);
  });

  it('a client token is rejected on a staff route with CLIENT_TOKEN_NOT_ALLOWED', async () => {
    const token = await freshClientToken();
    const res = await app.request('/api/admin/server/status', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe('CLIENT_TOKEN_NOT_ALLOWED');
  });

  it('a client token is rejected on a store route with CLIENT_TOKEN_NOT_ALLOWED', async () => {
    const token = await freshClientToken();
    const res = await app.request('/api/store/subscription', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe('CLIENT_TOKEN_NOT_ALLOWED');
  });

  it('a client token replayed as the WEBSITE session cookie verifies to nothing (audience separation)', async () => {
    const token = await freshClientToken();
    const res = await app.request('/api/auth/me', {
      headers: { Cookie: `imperium_session=${token}` },
    });
    expect(res.status).toBe(401);
  });

  it('a website SESSION token presented as a bearer client credential verifies to nothing', async () => {
    // There is no client-only route (challenge/verify are anonymous), so the
    // client-credential check itself is exercised: the session JWT (aud
    // imperium-api) must not establish an identity through the bearer path.
    const sessionJwt = await signJwt({ authMethod: 'discord', discordId: '111111111111111111' });
    expect(await verifyClientJwt(sessionJwt)).toBeNull();
    const res = await app.request('/api/player/cosmetics', {
      headers: { Authorization: `Bearer ${sessionJwt}` },
    });
    expect(res.status).toBe(401);
  });

  it('a session cookie still wins its own surface (regression: bearer support changed nothing for sessions)', async () => {
    const sessionJwt = await signJwt({ authMethod: 'mc_code', mcUuid: UUID_DASHED });
    const res = await app.request('/api/auth/me', {
      headers: { Cookie: `imperium_session=${sessionJwt}` },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { authMethod?: string }).authMethod).toBe('mc_code');
  });

  it('client tokens never resolve a staff actor, even for a LuckPerms-linked staff account', async () => {
    // Simulate a staff player: the linked account's LuckPerms primary_group
    // IS admin — without the mc_client guard in resolveStaffActor, this
    // session fallback would hand the launcher token panel powers.
    poolMocks.query.mockReset().mockImplementation(async (sql: string) =>
      sql.includes('luckperms_players')
        ? { rows: [{ primary_group: 'admin' }] }
        : { rows: [] },
    );
    try {
      const { resolveStaffActor, clientTokenAllowlist } = await import('../middleware/gates.js');
      const token = await freshClientToken();
      const c = {
        req: {
          method: 'GET',
          path: '/api/admin/server/status',
          header: (name: string) => (name === 'authorization' ? `Bearer ${token}` : undefined),
        },
        get: (k: string) => (k === 'user' ? { authMethod: 'mc_client', mcUuid: UUID_DASHED } : k === 'mcUuid' ? UUID_DASHED : undefined),
        set: () => {},
        json: (body: unknown, status: number) => ({ __status: status, __body: body }),
      } as unknown as Parameters<typeof resolveStaffActor>[0];
      const actor = await resolveStaffActor(c);
      expect(actor.role).toBe('none');
      expect(actor.rank).toBe(0);
      // And the allowlist itself refuses the route before any gate would run.
      const verdict = (await clientTokenAllowlist(c, async () => {})) as unknown as { __status: number; __body: { code?: string } };
      expect(verdict.__status).toBe(403);
      expect(verdict.__body.code).toBe('CLIENT_TOKEN_NOT_ALLOWED');
    } finally {
      poolMocks.query.mockReset().mockResolvedValue({ rows: [] });
    }
  });
});
