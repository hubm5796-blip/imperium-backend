import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B-23 — the speak-as-the-server surfaces (DM enqueue, changelog post):
 *   1. The shared BOT token no longer suffices once INTERNAL_SERVICE_TOKEN is
 *      set — only the service principal may queue DMs or post changelogs.
 *   2. DM enqueue validates the uuid shape and allowlists the type.
 *   3. Per-target cap: a linked Discord already holding 10 pending rows gets
 *      429 + Retry-After, not an 11th queued message.
 *   4. Changelog: unconfigured channel → 503 (no silent fallback to the
 *      owner's real channel); configured posts carry allowed_mentions:[].
 *   5. Queue drain CLAIMS rows (status flip) before sending — an in-flight
 *      'sending' row is invisible to a second drain; a crashed drain's lease
 *      expires and the row is reclaimed.
 */

interface FakeRow {
  id: string;
  uuid: string;
  discord_id: string;
  type: string;
  title: string;
  message: string;
  color: number | null;
  status: string;
  attempts: number;
  created_at: number;
  sent_at: number | null;
  claimed_at: number | null;
}

const { rows, discordByUuid } = vi.hoisted(() => ({
  rows: [] as FakeRow[],
  discordByUuid: new Map<string, string>(),
}));

function fakeD1() {
  return {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async run() {
              applyWrite(sql, params);
              return { meta: { changes: 1 } };
            },
            async first<T>() {
              return queryFirst(sql, params) as T | null;
            },
            async all<T>() {
              return { results: queryRows(sql, params) as T[] };
            },
          };
        },
        async run() {
          applyWrite(sql, []);
          return { meta: { changes: 1 } };
        },
        async first<T>() {
          return queryFirst(sql, []) as T | null;
        },
        async all<T>() {
          return { results: queryRows(sql, []) as T[] };
        },
      };
    },
  };
}

function applyWrite(sql: string, params: unknown[]): void {
  if (/^ALTER TABLE/i.test(sql)) return; // claimed_at add — no-op in the fake
  if (/^CREATE TABLE/i.test(sql)) return;
  const insert = /^INSERT INTO dm_queue/.test(sql);
  if (insert) {
    const [id, uuid, discordId, type, title, message, color] = params as [string, string, string, string, string, string, number];
    rows.push({
      id, uuid, discord_id: discordId, type, title, message, color: color ?? null,
      status: 'pending', attempts: 0, created_at: Date.now(), sent_at: null, claimed_at: null,
    });
    return;
  }
  if (/SET status = 'sending'/.test(sql)) {
    const [now, id, leaseCutoff] = params as [number, string, number];
    const row = rows.find((r) => r.id === id);
    if (!row) return;
    const claimable =
      (row.status === 'pending' && row.attempts < 3) ||
      (row.status === 'sending' && row.claimed_at !== null && row.claimed_at < leaseCutoff);
    // The fake mirrors D1 semantics by NOT writing when the WHERE fails;
    // changes count is approximated by the route reading meta.changes — the
    // assertion layer checks the row state instead.
    if (claimable) {
      row.status = 'sending';
      row.claimed_at = now;
    }
    return;
  }
  if (/SET status = 'sent'/.test(sql)) {
    const [at, id] = params as [number, string];
    const row = rows.find((r) => r.id === id);
    if (row) { row.status = 'sent'; row.sent_at = at; }
    return;
  }
  if (/SET attempts = \?/.test(sql)) {
    const [attempts, status, id] = params as [number, string, string];
    const row = rows.find((r) => r.id === id);
    if (row) { row.attempts = attempts; row.status = status; }
    return;
  }
}

function queryRows(sql: string, params: unknown[]): FakeRow[] {
  if (/FROM dm_queue/.test(sql) && /status = 'pending'/.test(sql)) {
    const cutoff = params[0] as number;
    return rows
      .filter((r) => (r.status === 'pending' && r.attempts < 3) || (r.status === 'sending' && r.claimed_at !== null && r.claimed_at < cutoff))
      .sort((a, b) => a.created_at - b.created_at)
      .slice(0, 10);
  }
  return [];
}

function queryFirst(sql: string, params: unknown[]): unknown {
  if (/SELECT COUNT\(\*\)/.test(sql)) {
    const [discordId, since] = params as [string, number];
    return { n: rows.filter((r) => r.discord_id === discordId && r.created_at > since && r.status === 'pending').length };
  }
  return null;
}

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    getD1: vi.fn(() => fakeD1()),
    getDiscordIdByUuid: vi.fn(async (uuid: string) => discordByUuid.get(uuid) ?? null),
  };
});

import { dmApi, changelogApi, processDmQueue } from '../api/v2/dms.js';
import { __resetEnvForTests, initEnvFromBindings } from '../env.js';

const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SERVICE = { 'X-Bot-Token': 'service-token-0123456789' };
const SHARED_BOT = { 'X-Bot-Token': 'bot-token-0123456789' };

let fetchCalls: Array<{ url: string; body: Record<string, unknown> }> = [];

function initEnv(withChannel: boolean): void {
  __resetEnvForTests();
  initEnvFromBindings({
    JWT_SECRET: 'test-jwt-secret-0123456789abcdef',
    DISCORD_CLIENT_ID: '1',
    DISCORD_CLIENT_SECRET: 'x',
    DISCORD_BOT_TOKEN: 'discord-bot-token',
    WEBPANEL_HMAC_SECRET: 'test-hmac-secret',
    PAYNOW_API_KEY: 'pk_test',
    PAYNOW_STORE_ID: '1',
    PAYNOW_WEBHOOK_SECRETS: 'whsec_test',
    BOT_API_TOKEN: 'bot-token-0123456789',
    INTERNAL_SERVICE_TOKEN: 'service-token-0123456789',
    ...(withChannel ? { CHANGELOG_CHANNEL_ID: '1234567890' } : {}),
  } as unknown as Record<string, unknown>);
}

beforeEach(() => {
  rows.length = 0;
  discordByUuid.clear();
  discordByUuid.set(UUID, '9990001111222333');
  fetchCalls = [];
  initEnv(false);
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    fetchCalls.push({
      url: String(url),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    return new Response(JSON.stringify({ id: '1' }), { status: 200 });
  }));
});

describe('B-23 DM enqueue gates', () => {
  it('the shared BOT token is refused once INTERNAL_SERVICE_TOKEN is set', async () => {
    const res = await dmApi.request('/notifications/dm', {
      method: 'POST',
      headers: { ...SHARED_BOT, 'content-type': 'application/json' },
      body: JSON.stringify({ uuid: UUID, type: 'purchase', title: 't', message: 'm' }),
    });
    expect(res.status).toBe(401);
  });

  it('the service token is accepted and queues the DM', async () => {
    const res = await dmApi.request('/notifications/dm', {
      method: 'POST',
      headers: { ...SERVICE, 'content-type': 'application/json' },
      body: JSON.stringify({ uuid: UUID, type: 'purchase', title: 't', message: 'm' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { queued: boolean; id: string };
    expect(body.queued).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ uuid: UUID, discord_id: '9990001111222333', type: 'purchase', status: 'pending' });
  });

  it('rejects unknown notification types and garbage uuids', async () => {
    const badType = await dmApi.request('/notifications/dm', {
      method: 'POST',
      headers: { ...SERVICE, 'content-type': 'application/json' },
      body: JSON.stringify({ uuid: UUID, type: 'evacuate_the_server', title: 't', message: 'm' }),
    });
    expect(badType.status).toBe(400);

    const badUuid = await dmApi.request('/notifications/dm', {
      method: 'POST',
      headers: { ...SERVICE, 'content-type': 'application/json' },
      body: JSON.stringify({ uuid: 'not-a-uuid', type: 'purchase', title: 't', message: 'm' }),
    });
    expect(badUuid.status).toBe(400);
    expect(rows).toHaveLength(0);
  });

  it('per-target cap: 10 pending rows for the recipient → 429 + Retry-After', async () => {
    for (let i = 0; i < 10; i++) {
      rows.push({
        id: `existing-${i}`, uuid: UUID, discord_id: '9990001111222333', type: 'purchase',
        title: 't', message: 'm', color: null, status: 'pending', attempts: 0,
        created_at: Date.now(), sent_at: null, claimed_at: null,
      });
    }
    const res = await dmApi.request('/notifications/dm', {
      method: 'POST',
      headers: { ...SERVICE, 'content-type': 'application/json' },
      body: JSON.stringify({ uuid: UUID, type: 'vote', title: 't', message: 'm' }),
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('3600');
    expect(rows).toHaveLength(10); // nothing added
  });
});

describe('B-23 changelog', () => {
  it('unconfigured channel → 503, no fallback post', async () => {
    const res = await changelogApi.request('/changelog/post', {
      method: 'POST',
      headers: { ...SERVICE, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'v2', changes: ['one'] }),
    });
    expect(res.status).toBe(503);
    expect(fetchCalls).toHaveLength(0); // nothing posted anywhere, owner channel included
  });

  it('shared bot token cannot post; service token posts with allowed_mentions locked', async () => {
    initEnv(true);
    const denied = await changelogApi.request('/changelog/post', {
      method: 'POST',
      headers: { ...SHARED_BOT, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'v2', changes: ['one'] }),
    });
    expect(denied.status).toBe(401);

    const res = await changelogApi.request('/changelog/post', {
      method: 'POST',
      headers: { ...SERVICE, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'v2', changes: ['one'] }),
    });
    expect(res.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toContain('/channels/1234567890/messages');
    expect(fetchCalls[0]!.body.allowed_mentions).toEqual({ parse: [] });
  });
});

describe('B-23/B-39 DM queue claims', () => {
  function seedRow(overrides: Partial<FakeRow> = {}): FakeRow {
    const row: FakeRow = {
      id: 'dm_test1', uuid: UUID, discord_id: '9990001111222333', type: 'purchase',
      title: 't', message: 'm', color: null, status: 'pending', attempts: 0,
      created_at: Date.now(), sent_at: null, claimed_at: null,
      ...overrides,
    };
    rows.push(row);
    return row;
  }

  it('delivers a pending row and marks it sent', async () => {
    seedRow();
    const out = await processDmQueue('bot-token');
    expect(out.sent).toBe(1);
    expect(rows[0]!.status).toBe('sent');
    expect(fetchCalls.length).toBeGreaterThanOrEqual(2); // channel open + message
    const msgPost = fetchCalls.find((c) => c.url.includes('/messages'));
    expect(msgPost!.body.allowed_mentions).toEqual({ parse: [] });
  });

  it('a row held by another isolate (fresh sending lease) is not re-sent', async () => {
    seedRow({ status: 'sending', claimed_at: Date.now() });
    const out = await processDmQueue('bot-token');
    expect(out.sent).toBe(0);
    expect(fetchCalls).toHaveLength(0);
    expect(rows[0]!.status).toBe('sending');
  });

  it('a crashed drain (expired lease) is reclaimed and delivered', async () => {
    seedRow({ status: 'sending', claimed_at: Date.now() - 5 * 60_000 });
    const out = await processDmQueue('bot-token');
    expect(out.sent).toBe(1);
    expect(rows[0]!.status).toBe('sent');
  });

  it('failed sends retry twice then go failed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 403 })));
    seedRow();
    await processDmQueue('bot-token');
    expect(rows[0]).toMatchObject({ attempts: 1, status: 'pending' });
    await processDmQueue('bot-token');
    expect(rows[0]).toMatchObject({ attempts: 2, status: 'pending' });
    await processDmQueue('bot-token');
    expect(rows[0]).toMatchObject({ attempts: 3, status: 'failed' });
  });
});
