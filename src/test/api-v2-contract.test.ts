import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * V6 05-01 contract tests for the v2 scaffold:
 *   1. Envelope discipline — ping proves {data} / {error:{code,message}}.
 *   2. Unknown query params are REJECTED (v1 ignores them; v2 must not).
 *   3. Cursor pagination — 25 seeded rows page through limit-10 cursors with
 *      exact coverage, no dupes/gaps, and stability when a new top row lands
 *      mid-iteration (keyset, not offset).
 *   4. openapi.json serves a parseable 3.1 document listing the live v2 paths.
 */

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    // In-memory board backing getLeaderboardPage: value DESC, uuid ASC.
    getLeaderboardPage: vi.fn(async (_type: string, limit: number, cursor: { value: number; uuid: string } | null) => {
      let rows = BOARD.slice();
      if (cursor) {
        rows = rows.filter((r) => r.value < cursor.value || (r.value === cursor.value && r.uuid > cursor.uuid));
      }
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        rows: page,
        nextCursor: page.length === limit && last ? { value: last.value, uuid: last.uuid } : null,
        approxTotal: null,
      };
    }),
  };
});

interface Row {
  uuid: string;
  name: string | null;
  value: number;
}

let BOARD: Row[] = [];

import { createApp } from '../app.js';
import { initEnvFromBindings } from '../env.js';

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  initEnvFromBindings({
    JWT_SECRET: 'unit-test-jwt-secret-0123456789abcdef0123',
    WEBPANEL_HMAC_SECRET: 'unit-test-webpanel-secret-0123456789abcdef',
    DISCORD_CLIENT_ID: 'test-client-id',
    DISCORD_CLIENT_SECRET: 'test-client-secret',
    PAYNOW_API_KEY: 'test-paynow-key',
    PAYNOW_STORE_ID: 'test-store',
    PAYNOW_WEBHOOK_SECRETS: 'test-webhook-secret',
    NODE_ENV: 'test',
  } as never);
  app = createApp();
});

beforeEach(() => {
  BOARD = Array.from({ length: 25 }, (_, i) => ({
    uuid: `u${String(i).padStart(3, '0')}`,
    name: `Player${i}`,
    value: 1000 - i * 10,
  }));
});

function ip(): string {
  return `198.51.100.${Math.floor(Math.random() * 250)}`;
}

async function get(path: string): Promise<Response> {
  return app.request(path, { headers: { 'CF-Connecting-IP': ip() } });
}

describe('GET /api/v2/ping', () => {
  it('returns the success envelope', async () => {
    const res = await get('/api/v2/ping');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { pong: boolean; v: number } };
    expect(body.data.pong).toBe(true);
    expect(body.data.v).toBe(2);
  });
});

describe('GET /api/v2/leaderboards/:board', () => {
  it('rejects unknown query params with the allowed set', async () => {
    const res = await get('/api/v2/leaderboards/blocks?foo=1');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details: { allowed: string[] } } };
    expect(body.error.code).toBe('UNKNOWN_PARAM');
    expect(body.error.details.allowed).toContain('limit');
  });

  it('404s unknown boards with the allowed list', async () => {
    const res = await get('/api/v2/leaderboards/nonsense');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('rejects malformed cursors', async () => {
    const res = await get('/api/v2/leaderboards/blocks?cursor=%%%not-base64%%%');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('INVALID_CURSOR');
  });

  it('pages all 25 rows through limit-10 cursors with exact coverage', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 4; page++) {
      const res = await get(`/api/v2/leaderboards/blocks?limit=10${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ uuid: string }>; meta: { nextCursor: string | null } };
      seen.push(...body.data.map((d) => d.uuid));
      cursor = body.meta.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25); // no dupes
    expect(seen).toEqual(BOARD.map((r) => r.uuid)); // order preserved
  });

  it('cursor pages are stable when a new top row lands mid-iteration', async () => {
    const first = (await (await get('/api/v2/leaderboards/blocks?limit=10')).json()) as {
      data: Array<{ uuid: string }>;
      meta: { nextCursor: string };
    };
    // A new top entry arrives between page 1 and page 2.
    BOARD.unshift({ uuid: 'uNEW', name: 'NewTop', value: 9999 });
    const second = (await (await get(`/api/v2/leaderboards/blocks?limit=10&cursor=${first.meta.nextCursor}`)).json()) as {
      data: Array<{ uuid: string }>;
    };
    // Page 2 continues EXACTLY where page 1 ended — no repeat, no gap.
    expect(second.data[0]!.uuid).toBe('u010');
    expect(second.data).toHaveLength(10);
  });
});

describe('GET /api/v2/openapi.json', () => {
  it('serves a parseable OpenAPI 3.1 document covering the live v2 paths', async () => {
    const res = await get('/api/v2/openapi.json');
    expect(res.status).toBe(200);
    const spec = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(spec.openapi).toBe('3.1.0');
    for (const path of [
      '/api/v2/ping',
      '/api/v2/leaderboards/{board}',
      '/api/v2/public/player/{username}',
      '/api/v2/member',
      '/api/v2/events/stream',
      '/api/v2/webhooks/subscriptions',
    ]) {
      expect(spec.paths[path], `missing ${path} in spec`).toBeDefined();
    }
  });
});
