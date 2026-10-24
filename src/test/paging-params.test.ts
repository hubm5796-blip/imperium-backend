import { beforeAll, describe, expect, it, vi } from 'vitest';

const { queries } = vi.hoisted(() => ({ queries: [] as Array<{ sql: string; params: unknown[] }> }));
vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    getUuidByDiscordId: vi.fn(async () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
    query: vi.fn(async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes('luckperms_players')) return { rows: [{ primary_group: 'admin' }] };
      if (sql.includes('COUNT(*)')) return { rows: [{ count: '0' }] };
      return { rows: [] };
    }),
  };
});

import { createApp } from '../app.js';
import { initEnvFromBindings } from '../env.js';
import { signJwt } from '../auth/jwt.js';
import { intParam, limitParam, pageParam } from '../utils/paging.js';

let app: ReturnType<typeof createApp>;

function lastLimitOffset(table: string): unknown[] {
  const q = [...queries].reverse().find((x) => x.sql.includes(`FROM ${table}`) && x.sql.includes('LIMIT'));
  if (!q) throw new Error(`no paged query against ${table}`);
  return q.params.slice(-2);
}

describe('paging helper', () => {
  it('falls back on non-integers and clamps to bounds', () => {
    expect(pageParam('abc')).toBe(1);
    expect(pageParam('')).toBe(1);
    expect(pageParam(undefined)).toBe(1);
    expect(pageParam('-4')).toBe(1);
    expect(pageParam('3')).toBe(3);
    expect(pageParam('99999999999999999999')).toBe(1);
    expect(limitParam('xyz', 20, 50)).toBe(20);
    expect(limitParam('0', 20, 50)).toBe(1);
    expect(limitParam('500', 20, 50)).toBe(50);
    expect(intParam('7', 20)).toBe(7);
  });
});

describe('v1 paged routes never send NaN to LIMIT/OFFSET', () => {
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

  async function staffCookie(): Promise<string> {
    return `imperium_session=${await signJwt({ authMethod: 'discord', discordId: '111111111111111111' })}`;
  }

  it('GET /api/tickets?page=abc&limit=xyz → defaults, not NaN', async () => {
    queries.length = 0;
    const res = await app.request('/api/tickets?page=abc&limit=xyz', { headers: { Cookie: await staffCookie() } });
    expect(res.status).toBe(200);
    expect(lastLimitOffset('support_tickets')).toEqual([20, 0]);
    const body = (await res.json()) as { page: unknown; limit: unknown };
    expect(body.page).toBe(1);
    expect(body.limit).toBe(20);
  });

  it('GET /api/marketplace/listings?page=abc&limit=xyz → defaults, not NaN', async () => {
    queries.length = 0;
    const res = await app.request('/api/marketplace/listings?page=abc&limit=xyz', { headers: { 'X-Bot-Token': 'test-bot-token' } });
    expect(res.status).toBe(200);
    const q = [...queries].reverse().find((x) => x.sql.includes('FROM marketplace_listings') && x.sql.includes('LIMIT'));
    expect(q?.params.slice(0, 2)).toEqual([20, 0]);
  });
});
