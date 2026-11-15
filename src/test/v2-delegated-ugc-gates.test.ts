/**
 * Q9 — the UGC write gates must accept DELEGATED principals.
 *
 * Finding (empirically reproduced before this fix): the frontend's
 * same-origin proxies (guide comments, gallery upload) authenticate to the
 * backend as DELEGATED service calls — X-Bot-Token = INTERNAL_SERVICE_TOKEN
 * plus X-Mc-Uuid — see imperium-frontend-fresh/src/lib/storeAuth.ts
 * (storeBackendHeaders) and the /api/v2/community/guides/:id/comments proxy.
 * But those backend routes gated on requireLinked, which only ever sees the
 * cookie/bearer identities attachUser resolves: a delegated call has
 * c.var.user === null and was 401'd BEFORE the handler ran. Every proxied
 * comment POST / gallery upload therefore failed with Unauthorized.
 *
 * The fix: gate these routes on requireMcIdentity (middleware/gates.ts),
 * which accepts exactly the two legitimate identities — a linked session
 * and a delegated service call — and normalizes/validates the asserted
 * uuid (B-06). These tests pin all three sides:
 *   1. delegated POST passes the gate (was 401 pre-fix);
 *   2. anonymous still 401s;
 *   3. an unlinked Discord session still gets the 403 linkRequired prompt.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Minimal D1 model: the comment create path needs (a) the guide to exist and
 * be published, (b) no recent comment by the same author, (c) the INSERT to
 * succeed. Everything else (schema ensure, rate limiter) succeeds no-op.
 */
const { fakeD1 } = vi.hoisted(() => {
  const fakeD1 = {
    prepare(sql: string) {
      const stmt = {
        sql,
        params: [] as unknown[],
        async first() {
          if (sql.includes("FROM guides WHERE id = ? AND status = 'published'")) {
            return { author_uuid: '11111111-2222-4333-8444-555555555555' };
          }
          return null; // no recent-comment row -> spam guard passes
        },
        async run() {
          return { meta: { changes: 1 } };
        },
        async all() {
          return { results: [] };
        },
        bind(...next: unknown[]) {
          stmt.params = next;
          return stmt;
        },
      };
      return stmt;
    },
    async batch(statements: Array<{ sql: string }>) {
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
  };
  return { fakeD1 };
});

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    getD1: () => fakeD1,
    getUuidByDiscordId: vi.fn(async () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
  };
});

import { createApp } from '../app.js';
import { initEnvFromBindings } from '../env.js';
import { signJwt } from '../auth/jwt.js';

let app: ReturnType<typeof createApp>;

const DELEGATED_UUID = '11111111-2222-4333-8444-555555555555';
const DELEGATED_HEADERS = {
  'Content-Type': 'application/json',
  'X-Bot-Token': 'test-service-token',
  'X-Mc-Uuid': DELEGATED_UUID,
};

async function linkedSessionCookie(): Promise<string> {
  const jwt = await signJwt({ authMethod: 'discord', discordId: '111111111111111111' });
  return `imperium_session=${jwt}`;
}

beforeAll(() => {
  initEnvFromBindings({
    JWT_SECRET: 'test-jwt-secret-0123456789abcdef0123456789abcdef',
    WEBPANEL_HMAC_SECRET: 'test-hmac-secret-0123456789abcdef0123456789abcdef',
    DISCORD_CLIENT_ID: 'test-client-id',
    DISCORD_CLIENT_SECRET: 'test-client-secret',
    BOT_API_TOKEN: 'test-bot-token',
    INTERNAL_SERVICE_TOKEN: 'test-service-token',
    PAYNOW_API_KEY: 'test-paynow-key',
    PAYNOW_STORE_ID: 'test-store',
    PAYNOW_WEBHOOK_SECRETS: 'test-webhook-secret',
    NODE_ENV: 'test',
  } as unknown as Record<string, unknown>);
  app = createApp();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Q9 — delegated principals pass the UGC write gates', () => {
  it('delegated comment POST passes the gate and creates (was 401 pre-fix)', async () => {
    const res = await app.request('/api/v2/community/guides/g_probe/comments', {
      method: 'POST',
      headers: DELEGATED_HEADERS,
      body: JSON.stringify({ body_md: 'delegated probe comment' }),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { id?: string }).id).toBeTruthy();
  });

  it('delegated gallery upload passes the gate (fails only on the missing R2 binding, never 401)', async () => {
    const res = await app.request('/api/v2/community/gallery', {
      method: 'POST',
      headers: { ...DELEGATED_HEADERS, 'Content-Length': '0' },
    });
    // No R2 binding in tests -> the route body's own 503 REGISTRY_UNAVAILABLE
    // proves the gate let the delegated identity THROUGH. Pre-fix this was 401.
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe('REGISTRY_UNAVAILABLE');
  });

  it('anonymous comment POST still 401s', async () => {
    const res = await app.request('/api/v2/community/guides/g_probe/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body_md: 'anon probe comment' }),
    });
    expect(res.status).toBe(401);
  });

  it('an unlinked Discord session still gets the link prompt (403 linkRequired)', async () => {
    const { getUuidByDiscordId } = await import('../db/pool.js');
    vi.mocked(getUuidByDiscordId).mockResolvedValueOnce(null);
    const res = await app.request('/api/v2/community/guides/g_probe/comments', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: await linkedSessionCookie(),
        Origin: 'https://romanica.net',
      },
      body: JSON.stringify({ body_md: 'unlinked session probe' }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { linkRequired?: boolean };
    expect(body.linkRequired).toBe(true);
  });

  it('the shared bot token alone (no identity) still cannot post comments', async () => {
    const res = await app.request('/api/v2/community/guides/g_probe/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bot-Token': 'test-bot-token' },
      body: JSON.stringify({ body_md: 'bare bot token probe' }),
    });
    expect(res.status).toBe(401);
  });
});
