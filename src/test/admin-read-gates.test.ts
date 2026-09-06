import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * B-19/B-29 — admin READS are staff-gated (they used to be shared-token-only
 * despite their own comments): v2 adminPanel (helper+; ledger mod+), v2
 * moderation history (mod+), expansion admin views + drift alerts (helper+),
 * and v1 /admin/player + /admin/server/status (helper+). Plus B-26 — the
 * webcode brute-force bound is keyed on the token hash, so rotating
 * X-Original-Client-IP values no longer rotates buckets.
 */
vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    getUuidByDiscordId: vi.fn(async (discordId: string) =>
      discordId === '111111111111111111'
        ? 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        : discordId === '222222222222222222'
          ? '99999999-8888-7777-6666-555555555555'
          : null,
    ),
    query: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('luckperms_players')) {
        const uuid = String(params[0] ?? '');
        const group =
          uuid === 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
            ? 'admin'
            : uuid === '99999999-8888-7777-6666-555555555555'
              ? 'trainee'
              : 'default';
        return { rows: [{ primary_group: group }] };
      }
      if (sql.includes('COUNT(*)')) return { rows: [{ count: '0', n: '0' }] };
      return { rows: [] };
    }),
  };
});
vi.mock('../db/redis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/redis.js')>();
  return {
    ...actual,
    getOnlinePlayerCount: vi.fn(async () => 7),
    getCachedJson: vi.fn(async () => null),
    setCachedJson: vi.fn(async () => undefined),
  };
});

import { createApp } from '../app.js';
import { initEnvFromBindings } from '../env.js';
import { signJwt } from '../auth/jwt.js';
import { initD1 } from '../db/pool.js';

let app: ReturnType<typeof createApp>;

const ADMIN_DISCORD = '111111111111111111';
const PLAIN_DISCORD = '333333333333333333';

async function cookie(discordId: string): Promise<string> {
  const jwt = await signJwt({ authMethod: 'discord', discordId });
  return `imperium_session=${jwt}`;
}

describe('B-19/B-29 staff gates on admin reads', () => {
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

  it('v2 anticheat alerts: staff session 200, plain session 403, unauthenticated 401', async () => {
    expect(
      (await app.request('/api/v2/admin/anticheat/alerts', { headers: { Cookie: await cookie(ADMIN_DISCORD) } })).status,
    ).toBe(200);
    expect(
      (await app.request('/api/v2/admin/anticheat/alerts', { headers: { Cookie: await cookie(PLAIN_DISCORD) } })).status,
    ).toBe(403);
    expect((await app.request('/api/v2/admin/anticheat/alerts')).status).toBe(401);
  });

  it('v2 ledger is mod+ — a helper-rank session is refused', async () => {
    // discord 222 links to a trainee account (helper rank) — ledger needs mod.
    const res = await app.request('/api/v2/admin/economy/transactions?uuid=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', {
      headers: { Cookie: await cookie('222222222222222222') },
    });
    expect(res.status).toBe(403);
    const admin = await app.request('/api/v2/admin/economy/transactions?uuid=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', {
      headers: { Cookie: await cookie(ADMIN_DISCORD) },
    });
    expect(admin.status).toBe(200);
  });

  it('v2 moderation history is mod+', async () => {
    expect(
      (
        await app.request('/api/v2/moderation/history?uuid=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', {
          headers: { Cookie: await cookie(PLAIN_DISCORD) },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request('/api/v2/moderation/history?uuid=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', {
          headers: { Cookie: await cookie(ADMIN_DISCORD) },
        })
      ).status,
    ).toBe(200);
  });

  it('expansion admin view + drift alerts are helper+', async () => {
    expect(
      (await app.request('/api/admin/liveops', { headers: { Cookie: await cookie(ADMIN_DISCORD) } })).status,
    ).toBe(200);
    expect(
      (await app.request('/api/admin/liveops', { headers: { Cookie: await cookie(PLAIN_DISCORD) } })).status,
    ).toBe(403);
    expect(
      (await app.request('/api/economy/drift-alerts', { headers: { Cookie: await cookie(PLAIN_DISCORD) } })).status,
    ).toBe(403);
    expect(
      (await app.request('/api/economy/drift-alerts', { headers: { Cookie: await cookie(ADMIN_DISCORD) } })).status,
    ).toBe(200);
  });

  it('B-43: staff SWR views answer Cache-Control: private, no-store', async () => {
    for (const path of ['/api/admin/liveops', '/api/admin/contraband/sweeps', '/api/economy/drift-alerts']) {
      const res = await app.request(path, { headers: { Cookie: await cookie(ADMIN_DISCORD) } });
      expect(res.headers.get('cache-control')).toBe('private, no-store');
    }
    // The public flow-summary keeps the shared-cacheable policy.
    const pub = await app.request('/api/economy/flow-summary');
    expect(pub.headers.get('cache-control') ?? '').toContain('public');
  });

  it('v1 /admin/server/status + /admin/player are helper+', async () => {
    expect(
      (await app.request('/api/admin/server/status', { headers: { Cookie: await cookie(PLAIN_DISCORD) } })).status,
    ).toBe(403);
    expect(
      (await app.request('/api/admin/server/status', { headers: { Cookie: await cookie(ADMIN_DISCORD) } })).status,
    ).toBe(200);
    expect(
      (
        await app.request('/api/admin/player?query=griefos', {
          headers: { Cookie: await cookie(PLAIN_DISCORD) },
        })
      ).status,
    ).toBe(403);
  });

  it('exemption deleted: the bare shared bot token is refused on admin reads (403)', async () => {
    expect(
      (await app.request('/api/admin/server/status', { headers: { 'X-Bot-Token': 'test-bot-token' } })).status,
    ).toBe(403);
    expect(
      (await app.request('/api/v2/admin/anticheat/alerts', { headers: { 'X-Bot-Token': 'test-bot-token' } })).status,
    ).toBe(403);
  });
});

/* ── B-26: webcode brute-force bound is not rotatable via client headers ──── */

/** Minimal in-memory D1 for the rate_limit_windows upsert the limiter uses. */
function makeRateD1() {
  const windows = new Map<string, number>();
  return {
    windows,
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            first: async () => {
              if (sql.includes('RETURNING hits')) {
                const key = String(params[0]);
                const hits = (windows.get(key) ?? 0) + 1;
                windows.set(key, hits);
                return { hits };
              }
              return null;
            },
            run: async () => ({ meta: { changes: 1 } }),
          };
        },
        run: async () => ({ meta: { changes: 1 } }),
      };
    },
  };
}

describe('B-26 webcode limiter bucketing', () => {
  beforeAll(() => {
    initD1(makeRateD1() as never);
    // Fresh app so rateLimit's module-level schemaReady sees the working D1.
    app = createApp();
  });

  it('rotating X-Original-Client-IP values cannot rotate buckets — 9th guess 429s', async () => {
    const results: number[] = [];
    for (let i = 0; i < 9; i++) {
      const res = await app.request('/api/auth/webcode/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bot-Token': 'test-bot-token',
          'X-Original-Client-IP': `10.0.${i}.${i}`, // a fresh "IP" every time
        },
        body: JSON.stringify({ code: '000000' }),
      });
      results.push(res.status);
    }
    // Pre-fix every one of these landed in a distinct spoofed bucket (all 404).
    // Now they share the token-hash bucket: 8 pass the limiter, the 9th 429s.
    expect(results.filter((s) => s === 429)).toHaveLength(1);
    expect(results[8]).toBe(429);
  });
});
