import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Microsoft (Minecraft) website sign-in — the client's Azure app and MS ->
 * Xbox Live -> XSTS -> Minecraft chain, executed server-side.
 *
 * Every chain hop is MOCKED at fetch (the exact upstream URLs the client's
 * MSApi.kt uses); Redis is the in-memory stand-in honoring SET EX / GETDEL
 * semantics (same transport-mock pattern as client-auth.test.ts); the
 * Postgres pool is stubbed for the Discord-link enrichment. The app, routes,
 * PKCE machinery, session-code handoff and /api/auth/exchange under test are
 * the real ones.
 *
 * Covers: start requires and parks PKCE under the frontend state; the
 * authorize URL shape; callback success incl. UUID dashing + Discord
 * enrichment + redeemable exchange; replayed/unknown state; token failure;
 * every user-actionable XSTS XErr; profile-absent accounts.
 */

process.env.BUS_TRANSPORT = 'redis';

const { redis, chain, bodies } = vi.hoisted(() => {
  const store = new Map<string, { value: string; expiresAt: number }>();
  return {
    redis: {
      reset() {
        store.clear();
      },
      live(key: string) {
        const entry = store.get(key);
        if (!entry) return null;
        if (entry.expiresAt <= Date.now()) {
          store.delete(key);
          return null;
        }
        return entry;
      },
      set(key: string, value: string, ttlSeconds: number) {
        store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
      },
      take(key: string) {
        const entry = this.live(key);
        if (!entry) return null;
        store.delete(key);
        return entry.value;
      },
    },
    /** Switchable chain behavior: ok | token_failed | xerr:<code> | no_profile | upstream_error */
    chain: { mode: 'ok' as string },
    /** Captured upstream request bodies, for asserting the chain's shapes. */
    bodies: {} as Record<string, unknown>,
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

import { createApp } from '../app.js';
import { initEnvFromBindings } from '../env.js';

const UUID_UNDASHED = 'aaaaaaaabbbbccccddddeeeeeeeeeeee';
const UUID_DASHED = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

let app: ReturnType<typeof createApp>;

/** Drive /auth/ms/start and return { location, verifier } with the PKCE
 *  verifier lifted straight out of the mocked store. */
async function start(state = 'a'.repeat(43)): Promise<{ location: string; verifier: string | null }> {
  const res = await app.request(`/api/auth/ms/start?state=${encodeURIComponent(state)}`);
  const location = res.headers.get('location') ?? '';
  const entry = redis.live(`ImperiumMC:ms_oauth:${state}`);
  const verifier = entry ? (JSON.parse(entry.value) as { verifier: string }).verifier : null;
  return { location, verifier };
}

/** Drive /auth/ms/callback for a state whose verifier we already hold. */
async function callback(state: string, verifier: string | null, code = 'authcode-1'): Promise<Response> {
  const qs = new URLSearchParams({ state, code });
  return app.request(`/api/auth/ms/callback?${qs.toString()}`);
}

/** The error code a 302 callback landed the user on. */
async function loginError(res: Response): Promise<string> {
  expect(res.status).toBe(302);
  const loc = res.headers.get('location') ?? '';
  return new URL(loc).searchParams.get('error') ?? '';
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

  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    // postForm sends URLSearchParams (stringifies), postJson sends a string —
    // capture both shapes.
    const bodyText = init?.body == null ? '' : String(init.body);
    const json = () => Promise.resolve(JSON.parse(bodyText || '{}') as unknown);

    if (u.hostname === 'login.microsoftonline.com' && u.pathname.endsWith('/token')) {
      bodies.token = bodyText;
      if (chain.mode === 'token_failed') return new Response('{"error":"invalid_grant"}', { status: 400 });
      return new Response(JSON.stringify({ access_token: 'ms-at-1' }), { status: 200 });
    }
    if (u.hostname === 'user.auth.xboxlive.com') {
      bodies.xbl = await json();
      if (chain.mode === 'upstream_error') return new Response('{}', { status: 500 });
      return new Response(
        JSON.stringify({ Token: 'xbl-t-1', DisplayClaims: { xui: [{ uhs: 'uhs-1' }] } }),
        { status: 200 },
      );
    }
    if (u.hostname === 'xsts.auth.xboxlive.com') {
      bodies.xsts = await json();
      if (chain.mode.startsWith('xerr:')) {
        return new Response(JSON.stringify({ XErr: Number(chain.mode.slice(5)) }), { status: 401 });
      }
      if (chain.mode === 'upstream_error') return new Response('{}', { status: 500 });
      return new Response(JSON.stringify({ Token: 'xsts-t-1' }), { status: 200 });
    }
    if (u.hostname === 'api.minecraftservices.com' && u.pathname.endsWith('login_with_xbox')) {
      bodies.mcAuth = await json();
      return new Response(JSON.stringify({ access_token: 'mc-at-1' }), { status: 200 });
    }
    if (u.hostname === 'api.minecraftservices.com' && u.pathname.endsWith('/profile')) {
      if (chain.mode === 'no_profile') return new Response(null, { status: 404 });
      return new Response(JSON.stringify({ id: UUID_UNDASHED, name: 'Griefos' }), { status: 200 });
    }
    return new Response(JSON.stringify({ unexpected: String(url) }), { status: 500 });
  }));
});

beforeEach(() => {
  redis.reset();
  chain.mode = 'ok';
  for (const k of Object.keys(bodies)) delete bodies[k];
  poolMocks.getDiscordIdByUuid.mockReset().mockResolvedValue(null);
});

describe('Microsoft sign-in — start', () => {
  it('requires a well-formed state and refuses to mint a flow without one', async () => {
    const missing = await app.request('/api/auth/ms/start');
    expect(missing.status).toBe(400);
    const short = await app.request('/api/auth/ms/start?state=abc');
    expect(short.status).toBe(400);
  });

  it('redirects to the consumers authorize endpoint with PKCE S256 and the client app id', async () => {
    const { location, verifier } = await start('Stat3-abc123_abc123_abc123_xy');
    const u = new URL(location);
    expect(u.hostname).toBe('login.microsoftonline.com');
    expect(u.pathname).toContain('/oauth2/v2_0/authorize');
    expect(u.searchParams.get('client_id')).toBe('938592fc-8e01-4c6d-b56d-428c7d9cf5ea');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('scope')).toBe('XboxLive.signin');
    expect(u.searchParams.get('state')).toBe('Stat3-abc123_abc123_abc123_xy');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('redirect_uri')).toBe('http://localhost/api/auth/ms/callback');
    // The verifier is parked under the state, single-use, and the challenge is
    // its S256 digest (43-char base64url both sides).
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get('code_challenge')).not.toBe(verifier);
  });
});

describe('Microsoft sign-in — callback chain', () => {
  it('success: dashed UUID, Discord enrichment, and a session code redeemable via /auth/exchange', async () => {
    poolMocks.getDiscordIdByUuid.mockResolvedValue('222222222222222222');
    const state = 'ok-state-abcdefghijklmnop';
    const { verifier } = await start(state);
    const res = await callback(state, verifier);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    // NODE_ENV=test -> the dev frontend host; prod flips to romanica.net.
    expect(loc.host).toBe('localhost:3000');
    expect(loc.pathname).toBe('/api/auth/ms/callback');

    // The chain called each upstream with the client's exact shapes.
    expect(new URLSearchParams(String(bodies.token)).get('code_verifier')).toBe(verifier);
    expect((bodies.xbl as { Properties: { RpsTicket: string } }).Properties.RpsTicket).toBe('d=ms-at-1');
    expect((bodies.xsts as { Properties: { SandboxId: string } }).Properties.SandboxId).toBe('RETAIL');
    expect((bodies.mcAuth as { identityToken: string }).identityToken).toBe('XBL3.0 x=uhs-1;xsts-t-1');

    // Redeem the one-time session code through the real exchange route.
    const sessionCode = loc.searchParams.get('session');
    expect(sessionCode).toBeTruthy();
    const exchange = await app.request('/api/auth/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: sessionCode }),
    });
    expect(exchange.status).toBe(200);
    const data = (await exchange.json()) as { mcUuid?: string; mcUsername?: string; discordId?: string };
    expect(data.mcUuid).toBe(UUID_DASHED);
    expect(data.mcUsername).toBe('Griefos');
    expect(data.discordId).toBe('222222222222222222');
  });

  it('unknown or replayed state never reaches the chain', async () => {
    expect(await loginError(await callback('never-started-state', null))).toBe('ms_state');
    const state = 'replay-state-abcdefghij';
    const { verifier } = await start(state);
    expect((await callback(state, verifier)).status).toBe(302); // first use consumes
    expect(await loginError(await callback(state, verifier))).toBe('ms_state');
  });

  it('a failed token exchange maps to ms_token_failed', async () => {
    chain.mode = 'token_failed';
    const state = 'tokenfail-state-abcdefg';
    const { verifier } = await start(state);
    expect(await loginError(await callback(state, verifier))).toBe('ms_token_failed');
  });

  it('user-actionable XSTS XErr codes map to distinct errors, others collapse', async () => {
    const cases: [string, string][] = [
      ['xerr:2148916233', 'ms_no_xbox'],
      ['xerr:2148916238', 'ms_child'],
      ['xerr:2148916235', 'ms_region'],
      ['xerr:9999999999', 'ms_chain_failed'],
    ];
    for (const [mode, expected] of cases) {
      chain.mode = mode;
      const state = `xerr-${mode.replace(/[^a-z0-9]/g, '')}statepadding`;
      const { verifier } = await start(state);
      expect(await loginError(await callback(state, verifier))).toBe(expected);
    }
  });

  it('an account with no Java profile maps to ms_no_profile', async () => {
    chain.mode = 'no_profile';
    const state = 'noprofile-state-abcdef';
    const { verifier } = await start(state);
    expect(await loginError(await callback(state, verifier))).toBe('ms_no_profile');
  });

  it('a generic upstream failure collapses to ms_chain_failed and never leaks details', async () => {
    chain.mode = 'upstream_error';
    const state = 'upstream-state-abcdefgh';
    const { verifier } = await start(state);
    const res = await callback(state, verifier);
    const err = await loginError(res);
    expect(err).toBe('ms_chain_failed');
    expect(res.headers.get('location')).not.toContain('500');
  });

  it('Microsoft cancels map to ms_denied and a missing code to missing_code', async () => {
    const denied = await app.request('/api/auth/ms/callback?error=access_denied&state=x');
    expect(await loginError(denied)).toBe('ms_denied');
    const bare = await app.request('/api/auth/ms/callback?state=x');
    expect(await loginError(bare)).toBe('missing_code');
  });
});
