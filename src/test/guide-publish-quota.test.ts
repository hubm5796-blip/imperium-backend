/**
 * B-34 — guides publish with a per-author cooldown + daily quota.
 *
 * Guides published instantly (status='published' on insert) with nothing
 * per-author beyond the shared 10/min IP bucket — instant-public spam/
 * defacement, while both sibling UGC surfaces are stricter (gallery: 3/day
 * + pending-until-approve; comments: 1/30 s/player/guide).
 *
 * Post-fix contract (modeled-table D1 fake, same harness style as
 * guide-vote-atomic.test.ts):
 *   - a guide published within the cooldown window → 429, nothing inserted;
 *   - the daily quota (5/day per author) → 429, nothing inserted;
 *   - a quota-check failure (D1 down) → 503, never a silent skip;
 *   - a clean author still publishes (201) with status='published'.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { fakeD1, guidesTable, d1State } = vi.hoisted(() => {
  const guidesTable = new Map<string, { author_uuid: string; created_at: number }>();
  const d1State = { failure: false };

  function makeStmt(sql: string, params: unknown[] = []) {
    return {
      sql,
      params,
      async first() {
        if (d1State.failure) throw new Error('D1 down');
        if (sql.includes('SELECT id FROM guides') && sql.includes('created_at > ?')) {
          // Cooldown probe: any of the author's guides newer than the cutoff?
          const [uuid, cutoff] = params as [string, number];
          for (const g of guidesTable.values()) {
            if (g.author_uuid === uuid && g.created_at > cutoff) return { id: 'g_recent' };
          }
          return null;
        }
        return null;
      },
      async all() {
        if (d1State.failure) throw new Error('D1 down');
        if (sql.includes('SELECT COUNT(*) AS n FROM guides')) {
          const [uuid, since] = params as [string, number];
          let n = 0;
          for (const g of guidesTable.values()) {
            if (g.author_uuid === uuid && g.created_at > since) n++;
          }
          return { results: [{ n }] };
        }
        return { results: [] };
      },
      async run() {
        if (d1State.failure) throw new Error('D1 down');
        return { meta: { changes: 1 } };
      },
      bind(...next: unknown[]) {
        return makeStmt(sql, next);
      },
    };
  }

  const fakeD1 = {
    prepare(sql: string) {
      return makeStmt(sql);
    },
    async batch(statements: Array<{ sql: string; params: unknown[] }>) {
      if (d1State.failure) throw new Error('D1 down');
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
  };

  return { fakeD1, guidesTable, d1State };
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
import { initEnvFromBindings, __resetEnvForTests } from '../env.js';
import { signJwt } from '../auth/jwt.js';

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  __resetEnvForTests();
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
  } as unknown as Record<string, unknown>);
  app = createApp();
});

beforeEach(() => {
  guidesTable.clear();
  d1State.failure = false;
});

const AUTHOR = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

async function publish(): Promise<Response> {
  const jwt = await signJwt({ authMethod: 'discord', discordId: '111111111111111111' });
  return app.request('/api/v2/community/guides', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `imperium_session=${jwt}` },
    body: JSON.stringify({ title: 'A guide', category: 'economy', body_md: 'content' }),
  });
}

describe('B-34: guide publish quota', () => {
  it('a clean author publishes (201)', async () => {
    const res = await publish();
    expect(res.status).toBe(201);
  });

  it('a guide published within the 60s cooldown is refused with 429 — nothing inserted', async () => {
    guidesTable.set('g_recent', { author_uuid: AUTHOR, created_at: Date.now() - 5_000 });
    const res = await publish();
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error?: string }).error).toMatch(/wait a minute/);
    expect(guidesTable.size).toBe(1);
  });

  it('the 5/day per-author quota is refused with 429 — nothing inserted', async () => {
    for (let i = 0; i < 5; i++) {
      guidesTable.set(`g_day_${i}`, { author_uuid: AUTHOR, created_at: Date.now() - (10 + i) * 60_000 });
    }
    // All 5 older than the cooldown but inside the 24h window.
    const res = await publish();
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error?: string }).error).toMatch(/Daily guide limit reached/);
    expect(guidesTable.size).toBe(5);
  });

  it('quota rows older than 24h do not count against the author', async () => {
    guidesTable.set('g_old', { author_uuid: AUTHOR, created_at: Date.now() - 25 * 3600 * 1000 });
    const res = await publish();
    expect(res.status).toBe(201);
  });

  it('a D1 failure during the quota check is a 503, never a silent skip', async () => {
    d1State.failure = true;
    const res = await publish();
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error?: string }).error).toMatch(/Guides unavailable/);
  });
});
