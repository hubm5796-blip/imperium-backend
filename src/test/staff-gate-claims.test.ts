import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Staff-gate trust protocol (Phase 1, B-01 + X-04 backend half):
 *   - forged X-Staff-Role without any authentication → denied
 *   - valid session + X-Staff-Role header → allowed (the panel's forwarded,
 *     LuckPerms-verified role)
 *   - no header + valid session with a linked staff role → allowed via the
 *     claim/linkage fallback
 *   - a session with NO staff role is never promoted (anonymous, deny)
 *   - the bare shared bot token keeps its TRANSITIONAL exemption until the
 *     frontend ships the header (asserted explicitly so the deletion commit
 *     must update this file).
 *
 * The Redis command bus and Postgres reads are mocked: the luckperms lookup
 * feeds the session fallback, getUuidByDiscordId feeds attachUser linkage.
 */
const { sent } = vi.hoisted(() => ({ sent: [] as Array<{ type: string; payload: Record<string, unknown> }> }));
vi.mock('../db/redis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/redis.js')>();
  return {
    ...actual,
    sendCommandWithResponse: vi.fn(async (type: string, payload: Record<string, unknown>) => {
      sent.push({ type, payload });
      return { status: 'OK', data: null };
    }),
  };
});
vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    // attachUser linkage: discord id 111... → the test player's uuid.
    getUuidByDiscordId: vi.fn(async (discordId: string) =>
      discordId === '111111111111111111'
        ? 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        : null,
    ),
    // The session fallback's LuckPerms read: uuid A → admin, uuid B → no staff group.
    query: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('luckperms_players')) {
        const uuid = String(params[0] ?? '');
        const group = uuid === 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' ? 'admin' : 'default';
        return { rows: [{ primary_group: group }] };
      }
      return { rows: [] };
    }),
  };
});

import { createApp } from '../app.js';
import { initEnvFromBindings } from '../env.js';
import { signJwt } from '../auth/jwt.js';
import { sendCommandWithResponse } from '../db/redis.js';

let app: ReturnType<typeof createApp>;

const BOT = { 'X-Bot-Token': 'test-bot-token' };
const punishBody = { target: 'griefos', action: 'ban', reason: 'test' };
const ADMIN_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';


async function sessionCookie(payload: Parameters<typeof signJwt>[0]): Promise<string> {
  const jwt = await signJwt(payload);
  return `imperium_session=${jwt}`;
}

describe('staff gate — X-Staff-Role trust protocol', () => {
  beforeAll(() => {
    initEnvFromBindings({
      JWT_SECRET: 'test-jwt-secret-0123456789abcdef0123456789abcdef',
      WEBPANEL_HMAC_SECRET: 'test-hmac-secret-0123456789abcdef0123456789abcdef',
      DISCORD_CLIENT_ID: 'test-client-id',
      DISCORD_CLIENT_SECRET: 'test-client-secret',
      BOT_API_TOKEN: 'test-bot-token',
      PAYNOW_API_KEY: 'test-paynow-key',
      PAYNOW_STORE_ID: 'test-store',
      PAYNOW_WEBHOOK_SECRETS: 'test-webhook-secret',
      NODE_ENV: 'test',
      D1_RATE_LIMIT: { stub: true },
    } as unknown as Record<string, unknown>);
    app = createApp();
  });

  it('a forged X-Staff-Role header without any authentication is denied (401)', async () => {
    const res = await app.request('/api/admin/punish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Staff-Role': 'admin' },
      body: JSON.stringify(punishBody),
    });
    expect(res.status).toBe(401);
  });

  it('valid session + X-Staff-Role header → allowed; the attributed actor rides the dispatch (X-03)', async () => {
    (sendCommandWithResponse as ReturnType<typeof vi.fn>).mockClear();
    sent.length = 0;
    // A session whose linked account has NO staff group — the header is the
    // panel's verified claim and must be sufficient on an authenticated call.
    const cookie = await sessionCookie({
      authMethod: 'discord',
      discordId: '222222222222222222',
    });
    const res = await app.request('/api/admin/punish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-Staff-Role': 'mod',
        'X-Admin-Uuid': ADMIN_UUID,
      },
      body: JSON.stringify(punishBody),
    });
    expect(res.status).toBe(200);
    const cmd = sent.find((c) => c.type === 'PUNISH_PLAYER');
    expect(cmd?.payload.actor).toBe(ADMIN_UUID);
  });

  it('no header + valid session with a linked staff role → allowed via claim fallback', async () => {
    sent.length = 0;
    // Linked (discord 111… → uuid A) and uuid A's LuckPerms primary_group is
    // admin, so the session fallback alone authorizes the reload.
    const cookie = await sessionCookie({
      authMethod: 'discord',
      discordId: '111111111111111111',
    });
    const res = await app.request('/api/admin/reload', {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
  });

  it('a session with NO staff role and no header is denied (never the service exemption)', async () => {
    // discord 222… is linked to a plain player (no staff group); that session
    // must not fall into the panel-service exemption.
    const pool = await import('../db/pool.js');
    vi.mocked(pool.getUuidByDiscordId).mockResolvedValueOnce('99999999-8888-7777-6666-555555555555');
    const cookie = await sessionCookie({
      authMethod: 'discord',
      discordId: '222222222222222222',
    });
    const res = await app.request('/api/admin/punish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(punishBody),
    });
    expect(res.status).toBe(403);
  });

  it('TRANSITIONAL: the bare shared bot token still passes the gates until the exemption-deletion commit', async () => {
    sent.length = 0;
    const res = await app.request('/api/admin/punish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...BOT },
      body: JSON.stringify(punishBody),
    });
    expect(res.status).toBe(200);
    const cmd = sent.find((c) => c.type === 'PUNISH_PLAYER');
    expect(cmd?.payload.actor).toBe('panel-service');
  });

  it('X-Staff-Role on a bot-token-authenticated request is honored (the bot forwards its verified staff gate)', async () => {
    sent.length = 0;
    const res = await app.request('/api/admin/punish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...BOT, 'X-Staff-Role': 'mod' },
      body: JSON.stringify(punishBody),
    });
    expect(res.status).toBe(200);
  });

  it('X-Staff-Role garbage values are ignored (not even read as a role)', async () => {
    const cookie = await sessionCookie({
      authMethod: 'discord',
      discordId: '222222222222222222',
    });
    const res = await app.request('/api/admin/punish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-Staff-Role': 'superadmin',
      },
      body: JSON.stringify(punishBody),
    });
    expect(res.status).toBe(403);
  });
});
