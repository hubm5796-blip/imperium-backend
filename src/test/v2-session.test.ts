import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * B-49: the v2 sub-app never ran attachUser, so every linked-gated v2 route
// * (keys, gallery, guides, comments, storeOrders' session path) always
 * 401/403'd for a real browser session. Now /api/v2/* attaches the user
 * (before rateLimitV2, so the limiter sees the principal), and
 * cookie-authenticated mutations carry a CSRF Origin guard.
 */
vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    getUuidByDiscordId: vi.fn(async () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
    query: vi.fn(async (sql: string) => {
      if (sql.includes('luckperms_players')) return { rows: [{ primary_group: 'default' }] };
      return { rows: [] };
    }),
  };
});
vi.mock('../auth/apiKeys.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth/apiKeys.js')>();
  return {
    ...actual,
    listKeys: vi.fn(async () => []),
    authenticateApiKey: vi.fn(async () => null),
  };
});

import { createApp } from '../app.js';
import { initEnvFromBindings } from '../env.js';
import { signJwt } from '../auth/jwt.js';

let app: ReturnType<typeof createApp>;

async function linkedSessionCookie(): Promise<string> {
  const jwt = await signJwt({ authMethod: 'discord', discordId: '111111111111111111' });
  return `imperium_session=${jwt}`;
}

describe('B-49 — v2 sub-app attaches the user', () => {
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

  it('a linked session lists its API keys (was a guaranteed 401 pre-fix)', async () => {
    const res = await app.request('/api/v2/keys', {
      headers: { Cookie: await linkedSessionCookie() },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { keys?: unknown[] }).keys).toEqual([]);
  });

  it('no session still 401s on the gated route', async () => {
    const res = await app.request('/api/v2/keys');
    expect(res.status).toBe(401);
  });

  it('a session-cookie mutation with a foreign Origin is blocked (CSRF guard)', async () => {
    const res = await app.request('/api/v2/keys', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: await linkedSessionCookie(),
        Origin: 'https://evil.example.com',
      },
      body: JSON.stringify({ name: 'x', scopes: ['read:profile'] }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe('CSRF_ORIGIN_REJECTED');
  });

  it('a session-cookie mutation from the site origin is not CSRF-blocked', async () => {
    const res = await app.request('/api/v2/keys', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: await linkedSessionCookie(),
        Origin: 'https://romanica.net',
      },
      // scopes missing -> the route's own 400, NOT the CSRF 403
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(400);
  });

  it('a session-cookie mutation from the retired imperiummc.net origin is CSRF-blocked', async () => {
    const res = await app.request('/api/v2/keys', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: await linkedSessionCookie(),
        Origin: 'https://imperiummc.net',
      },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code?: string }).code).toBe('CSRF_ORIGIN_REJECTED');
  });

  it('non-cookie mutations are untouched by the CSRF guard (bot token, no Origin)', async () => {
    const res = await app.request('/api/v2/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bot-Token': 'test-bot-token' },
      body: JSON.stringify({ uuid: 'not-a-uuid', subject: 's', body: 'b' }),
    });
    expect(res.status).toBe(400); // uuid validation — passed the guard
  });
});
