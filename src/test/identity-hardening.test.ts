import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Identity hardening (B-13 + B-02 + B-06 + B-54). Runs with a SPLIT token
 * setup (INTERNAL_SERVICE_TOKEN distinct from BOT_API_TOKEN — the state the
 * split was designed for and the old code made unreachable):
 *   - resolvePrincipal: service token + X-Mc-Uuid → delegated (the old code
 *     resolved this to anonymous — B-02's unreachable branch); bot token +
 *     X-Mc-Uuid → plain bot (identity never trusted under the shared token).
 *   - requireMcIdentity on the v1 player routes: linked session → self;
 *     service-token delegation → allowed; bot token + X-Mc-Uuid → 403;
 *     garbage uuid under the service token → 400; unlinked session → 403.
 *   - parseMcUuid normalization (undashed/uppercase → dashed lowercase).
 */
const { queries } = vi.hoisted(() => ({ queries: [] as Array<{ sql: string; params: unknown[] }> }));
vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    getUuidByDiscordId: vi.fn(async (discordId: string) =>
      discordId === '111111111111111111' ? 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' : null,
    ),
    query: vi.fn(async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes('luckperms_players')) return { rows: [{ primary_group: 'default' }] };
      if (sql.includes('player_crate_keys')) return { rows: [] };
      if (sql.includes('COUNT(*)')) return { rows: [{ count: '0' }] };
      return { rows: [] };
    }),
  };
});

import { createApp } from '../app.js';
import { initEnvFromBindings } from '../env.js';
import { signJwt } from '../auth/jwt.js';
import { parseMcUuid, resolvePrincipal } from '../middleware/gates.js';
import type { Context } from 'hono';

let app: ReturnType<typeof createApp>;

const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

/** Header-only Context stub for direct resolvePrincipal tests. */
function ctx(headers: Record<string, string>): Context {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    req: { header: (name: string) => h[name.toLowerCase()] },
    get: (_key: string) => undefined,
  } as unknown as Context;
}

describe('B-02 delegated split (INTERNAL_SERVICE_TOKEN distinct)', () => {
  beforeAll(() => {
    initEnvFromBindings({
      JWT_SECRET: 'test-jwt-secret-0123456789abcdef0123456789abcdef',
      WEBPANEL_HMAC_SECRET: 'test-hmac-secret-0123456789abcdef0123456789abcdef',
      DISCORD_CLIENT_ID: 'test-client-id',
      DISCORD_CLIENT_SECRET: 'test-client-secret',
      BOT_API_TOKEN: 'bot-secret',
      INTERNAL_SERVICE_TOKEN: 'svc-secret',
      PAYNOW_API_KEY: 'test-paynow-key',
      PAYNOW_STORE_ID: 'test-store',
      PAYNOW_WEBHOOK_SECRETS: 'test-webhook-secret',
      NODE_ENV: 'test',
      D1_RATE_LIMIT: { stub: true },
    } as unknown as Record<string, unknown>);
    app = createApp();
  });

  it('service token + X-Mc-Uuid resolves to the DELEGATED principal (was anonymous pre-fix)', async () => {
    const p = await resolvePrincipal(ctx({ 'X-Bot-Token': 'svc-secret', 'X-Mc-Uuid': UUID }));
    expect(p.kind).toBe('delegated');
    expect(p).toMatchObject({ mcUuid: UUID });
  });

  it('bot token + X-Mc-Uuid resolves to plain bot — the uuid is NOT trusted', async () => {
    const p = await resolvePrincipal(ctx({ 'X-Bot-Token': 'bot-secret', 'X-Mc-Uuid': UUID }));
    expect(p.kind).toBe('bot');
  });

  it('service token without X-Mc-Uuid is service scope (bot principal)', async () => {
    const p = await resolvePrincipal(ctx({ 'X-Bot-Token': 'svc-secret' }));
    expect(p.kind).toBe('bot');
  });

  it('parseMcUuid normalizes undashed/uppercase and rejects garbage (B-06)', () => {
    expect(parseMcUuid('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE')).toBe(UUID);
    expect(parseMcUuid(UUID.replace(/-/g, ''))).toBe(UUID);
    expect(parseMcUuid('not-a-uuid')).toBeNull();
    expect(parseMcUuid('------------------------------------')).toBeNull();
    expect(parseMcUuid('')).toBeNull();
    expect(parseMcUuid(undefined)).toBeNull();
  });
});

describe('requireMcIdentity on the v1 player routes (B-13)', () => {
  it('linked session reads its own crates (self-scope stays session-allowed)', async () => {
    const jwt = await signJwt({ authMethod: 'discord', discordId: '111111111111111111' });
    const res = await app.request('/api/player/crates', {
      headers: { Cookie: `imperium_session=${jwt}` },
    });
    expect(res.status).toBe(200);
  });

  it('service-token delegation reads the asserted player (200)', async () => {
    queries.length = 0;
    const res = await app.request('/api/player/crates', {
      headers: { 'X-Bot-Token': 'svc-secret', 'X-Mc-Uuid': UUID.toUpperCase() },
    });
    expect(res.status).toBe(200);
    const q = queries.find((x) => x.sql.includes('player_crate_keys'));
    expect(q?.params[0]).toBe(UUID); // normalized
  });

  it('shared bot token + X-Mc-Uuid is refused once the split is active (403)', async () => {
    const res = await app.request('/api/player/crates', {
      headers: { 'X-Bot-Token': 'bot-secret', 'X-Mc-Uuid': UUID },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('IDENTITY_NEEDS_SERVICE_TOKEN');
  });

  it('garbage X-Mc-Uuid under the service token is a 400, not a silent miss', async () => {
    const res = await app.request('/api/player/crates', {
      headers: { 'X-Bot-Token': 'svc-secret', 'X-Mc-Uuid': '------------------------------------' },
    });
    expect(res.status).toBe(400);
  });

  it('unlinked session gets linkRequired 403; no credentials get 401', async () => {
    const jwt = await signJwt({ authMethod: 'discord', discordId: '222222222222222222' });
    const unlinked = await app.request('/api/player/crates', {
      headers: { Cookie: `imperium_session=${jwt}` },
    });
    expect(unlinked.status).toBe(403);
    expect(((await unlinked.json()) as { linkRequired?: boolean }).linkRequired).toBe(true);

    expect((await app.request('/api/player/crates')).status).toBe(401);
  });

  it('storeAuth rejects X-Mc-Uuid under the shared bot token once the split is active', async () => {
    const res = await app.request('/api/store/subscription', {
      headers: { 'X-Bot-Token': 'bot-secret', 'X-Mc-Uuid': UUID },
    });
    expect(res.status).toBe(403);
  });
});
