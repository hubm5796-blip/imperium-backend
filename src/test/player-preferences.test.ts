import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Same harness discipline as expansion-community.test.ts: mock the Postgres
// pool (query) and Redis, boot the real app, drive the HTTP surface.

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  return { ...actual, query };
});

vi.mock('../db/redis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/redis.js')>();
  return {
    ...actual,
    getCachedJson: vi.fn(async () => null),
    setCachedJson: vi.fn(async () => undefined),
    getOnlinePlayerCount: vi.fn(async () => 0),
  };
});

import { createApp } from '../app.js';
import { initEnvFromBindings } from '../env.js';
import { query as queryMock } from '../db/pool.js';

const TEST_UUID = '11111111-2222-4333-8444-555555555555';
const BOT_HEADERS = { 'X-Bot-Token': 'test-bot-token', 'Content-Type': 'application/json' };

let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  initEnvFromBindings({
    JWT_SECRET: 'test-secret-that-is-at-least-32-characters!',
    WEBPANEL_HMAC_SECRET: 'test-hmac',
    DISCORD_CLIENT_ID: 'test-client-id',
    DISCORD_CLIENT_SECRET: 'test-client-secret',
    BOT_API_TOKEN: 'test-bot-token',
    PAYNOW_API_KEY: 'test-paynow-key',
    PAYNOW_STORE_ID: 'test-store',
    PAYNOW_WEBHOOK_SECRETS: 'test-webhook-secret',
    NODE_ENV: 'test',
  } as never);
  app = createApp();
});

beforeEach(() => {
  vi.mocked(queryMock).mockReset();
  vi.mocked(queryMock).mockResolvedValue({ rows: [], rowCount: 0 } as never);
});

describe('GET/POST /api/player/preferences', () => {
  it('401 without the bot token (the site proxy is the only caller)', async () => {
    const res = await app.request(`/api/player/preferences?uuid=${TEST_UUID}`);
    expect(res.status).toBe(401);
  });

  it('400 on a malformed uuid', async () => {
    const res = await app.request('/api/player/preferences?uuid=not-a-uuid', { headers: BOT_HEADERS });
    expect(res.status).toBe(400);
  });

  it('GET returns the stored preferences, {} when absent', async () => {
    vi.mocked(queryMock).mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM player_preferences')) {
        return { rows: [{ preferences: { language: 'en', notifications: { events: true } } }], rowCount: 1 } as never;
      }
      return { rows: [], rowCount: 0 } as never; // CREATE TABLE IF NOT EXISTS + anything else
    });
    const res = await app.request(`/api/player/preferences?uuid=${TEST_UUID}`, { headers: BOT_HEADERS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { preferences: Record<string, unknown> };
    expect(body.preferences.language).toBe('en');

    // Absent: the default {}.
    vi.mocked(queryMock).mockImplementation(async () => ({ rows: [], rowCount: 0 } as never));
    const res2 = await app.request(`/api/player/preferences?uuid=${TEST_UUID}`, { headers: BOT_HEADERS });
    const body2 = (await res2.json()) as { preferences: unknown };
    expect(body2.preferences).toEqual({});
  });

  it('POST persists the payload via upsert and reports persisted: true', async () => {
    const res = await app.request('/api/player/preferences', {
      method: 'POST',
      headers: BOT_HEADERS,
      body: JSON.stringify({ uuid: TEST_UUID, preferences: { notifications: { events: true }, language: 'en' } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; persisted: boolean };
    expect(body).toEqual({ success: true, persisted: true });
    // One CREATE TABLE IF NOT EXISTS + one upsert with the serialized payload.
    const calls = vi.mocked(queryMock).mock.calls;
    const upsert = calls.find(([sql]) => String(sql).includes('ON CONFLICT (uuid) DO UPDATE'));
    expect(upsert).toBeDefined();
    expect(String(upsert![1]?.[1])).toContain('"language":"en"');
  });

  it('POST rejects hostile shapes (array, oversize, deep nesting) without touching the table', async () => {
    vi.mocked(queryMock).mockClear();
    const arrayRes = await app.request('/api/player/preferences', {
      method: 'POST', headers: BOT_HEADERS,
      body: JSON.stringify({ uuid: TEST_UUID, preferences: ['nope'] }),
    });
    expect(arrayRes.status).toBe(400);

    const oversize = { big: 'x'.repeat(9 * 1024) };
    const sizeRes = await app.request('/api/player/preferences', {
      method: 'POST', headers: BOT_HEADERS,
      body: JSON.stringify({ uuid: TEST_UUID, preferences: oversize }),
    });
    expect(sizeRes.status).toBe(413);

    const deep = { a: { b: { c: { d: true } } } };
    const deepRes = await app.request('/api/player/preferences', {
      method: 'POST', headers: BOT_HEADERS,
      body: JSON.stringify({ uuid: TEST_UUID, preferences: deep }),
    });
    expect(deepRes.status).toBe(400);
    // No upsert ran for any rejection.
    expect(vi.mocked(queryMock).mock.calls.some(([sql]) => String(sql).includes('ON CONFLICT'))).toBe(false);
  });

  it('POST with null preferences is a soft no-op (persisted: false), matching the proxy contract', async () => {
    const res = await app.request('/api/player/preferences', {
      method: 'POST', headers: BOT_HEADERS,
      body: JSON.stringify({ uuid: TEST_UUID, preferences: null }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { persisted: boolean };
    expect(body.persisted).toBe(false);
  });
});
