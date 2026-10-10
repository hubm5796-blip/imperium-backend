import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Per-actor audit attribution (2026-10-06) — audit rows must answer "WHO did
 * this", not just "the bot did this":
 *   1. parseActorRef enforces the closed id vocabulary — garbage refs never
 *      reach an audit row as-is.
 *   2. A v2 ticket staff note with the bot-forwarded Discord actor lands in
 *      action_log with that human's discord:<snowflake> identity.
 *   3. A garbage/forged actor ref falls back to the shared-bot attribution
 *      (the note itself still succeeds — audit never blocks the action).
 *   4. A ticket PATCH with no actor at all (the cron sweep) keeps the
 *      shared-bot attribution.
 *   5. The changelog poster records the acting human when per-staff token
 *      headers ride the request, and the service identity otherwise.
 *
 * D1 is faked (the dms-gates pattern) capturing action_log INSERTs; the
 * Postgres query() used by the ticket routes is mocked to succeed.
 */

interface ActionRow {
  id: string;
  ts: number;
  actor_id: string;
  actor_name: string;
  action: string;
  target: string | null;
  detail: string | null;
}

const { actionRows } = vi.hoisted(() => ({ actionRows: [] as ActionRow[] }));

function fakeD1() {
  return {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async run() {
              if (/^CREATE TABLE/i.test(sql)) return { meta: { changes: 1 } };
              if (/^INSERT INTO action_log/.test(sql)) {
                const [id, ts, actorId, actorName, action, target, detail] = params as [
                  string, number, string, string, string, string | null, string | null,
                ];
                actionRows.push({ id, ts, actor_id: actorId, actor_name: actorName, action, target, detail });
              }
              return { meta: { changes: 1 } };
            },
            async first<T>() {
              if (/SELECT COUNT\(\*\)/.test(sql)) return { n: actionRows.length } as T;
              return null;
            },
            async all<T>() {
              if (/FROM action_log/.test(sql)) return { results: [...actionRows].reverse() as unknown as T[] };
              return { results: [] as T[] };
            },
          };
        },
        async run() {
          return { meta: { changes: 1 } };
        },
        async first<T>() {
          return null;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
      };
    },
  };
}

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    getD1: vi.fn(() => fakeD1()),
    getDiscordIdByUuid: vi.fn(async () => null),
    // The ticket routes' Postgres writes: notes INSERT and ticket UPDATE both
    // succeed with one row.
    query: vi.fn(async () => ({ rows: [{ id: 'note-1' }], rowCount: 1 })),
  };
});

import { parseActorRef } from '../utils/auditActor.js';
import { ticketsV2 } from '../api/v2/tickets.js';
import { changelogApi } from '../api/v2/dms.js';
import { adminPanelV2 } from '../api/v2/adminPanel.js';
import { __resetEnvForTests, initEnvFromBindings } from '../env.js';

const BOT = { 'X-Bot-Token': 'bot-token-0123456789', 'Content-Type': 'application/json' };
const SERVICE = { 'X-Bot-Token': 'service-token-0123456789', 'Content-Type': 'application/json' };

function initEnv(extra: Record<string, unknown> = {}): void {
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
    STAFF_ACTOR_TOKEN_MAP: 'stafftok1:SenatorBrukus:mod',
    ...extra,
  } as unknown as Record<string, unknown>);
}

beforeEach(() => {
  actionRows.length = 0;
  initEnv();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: '1' }), { status: 200 })));
});

describe('parseActorRef (closed id vocabulary)', () => {
  it('accepts the real shapes', () => {
    expect(parseActorRef('discord:111111111111111111', 'Brukus')).toEqual({
      id: 'discord:111111111111111111',
      name: 'Brukus',
    });
    expect(parseActorRef('mc:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'aaaa')).toEqual({
      id: 'mc:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      name: 'aaaa',
    });
    expect(parseActorRef('named:panel-service', 'panel-service')).toEqual({
      id: 'named:panel-service',
      name: 'panel-service',
    });
    expect(parseActorRef('service:bot', 'bot')).toEqual({ id: 'service:bot', name: 'bot' });
  });

  it('rejects garbage, injection and oversize values', () => {
    expect(parseActorRef('discord:not-a-snowflake', 'x')).toBeNull();
    expect(parseActorRef('admin:1', 'x')).toBeNull(); // unknown prefix
    expect(parseActorRef('discord:111111111111111111', '<script>alert(1)</script>')).toBeNull(); // name empties after charset clean
    expect(parseActorRef('', '')).toBeNull();
    expect(parseActorRef(undefined, 'x')).toBeNull();
    expect(parseActorRef('discord:111111111111111111', 42 as unknown as string)).toBeNull();
  });
});

describe('v2 ticket staff note attribution', () => {
  it('records the bot-forwarded Discord actor in action_log', async () => {
    const res = await ticketsV2.request('/tickets/tk-1/notes', {
      method: 'POST',
      headers: BOT,
      body: JSON.stringify({
        author: 'staff',
        body: 'looked into it',
        actorId: 'discord:222222222222222222',
        actorName: 'SenatorBrukus',
      }),
    });
    expect(res.status).toBe(201);
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      actor_id: 'discord:222222222222222222',
      actor_name: 'SenatorBrukus',
      action: 'ticket.note',
      target: 'tk-1',
    });
  });

  it('a forged/garbage actor ref falls back to the shared-bot attribution and the note still succeeds', async () => {
    const res = await ticketsV2.request('/tickets/tk-1/notes', {
      method: 'POST',
      headers: BOT,
      body: JSON.stringify({
        author: 'staff',
        body: 'note',
        actorId: 'discord:totally-fake',
        actorName: 'Mister Spoof',
      }),
    });
    expect(res.status).toBe(201);
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({ actor_id: 'service:bot', actor_name: 'bot', action: 'ticket.note' });
  });

  it('a player-class note is content, not a staff action — no action_log row', async () => {
    const res = await ticketsV2.request('/tickets/tk-1/notes', {
      method: 'POST',
      headers: BOT,
      body: JSON.stringify({ author: 'player', body: 'still broken' }),
    });
    expect(res.status).toBe(201);
    expect(actionRows).toHaveLength(0);
  });
});

describe('v2 ticket PATCH attribution', () => {
  it('records the human when the bot forwards one', async () => {
    const res = await ticketsV2.request('/tickets/tk-1', {
      method: 'PATCH',
      headers: BOT,
      body: JSON.stringify({
        status: 'closed',
        actorId: 'discord:222222222222222222',
        actorName: 'SenatorBrukus',
      }),
    });
    expect(res.status).toBe(200);
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      actor_id: 'discord:222222222222222222',
      action: 'ticket.patch',
      target: 'tk-1',
    });
    expect(actionRows[0]!.detail).toContain('status');
  });

  it('the cron sweep (no actor at all) keeps the shared-bot attribution', async () => {
    const res = await ticketsV2.request('/tickets/tk-1', {
      method: 'PATCH',
      headers: BOT,
      body: JSON.stringify({ discordThreadId: '123' }),
    });
    expect(res.status).toBe(200);
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({ actor_id: 'service:bot', action: 'ticket.patch' });
  });
});

describe('changelog poster attribution', () => {
  it('names the human when a per-staff token rides the request', async () => {
    initEnv({ CHANGELOG_CHANNEL_ID: '1234567890' });
    const res = await changelogApi.request('/changelog/post', {
      method: 'POST',
      headers: { ...SERVICE, 'X-Staff-Token': 'stafftok1', 'X-Staff-Actor': 'SenatorBrukus' },
      body: JSON.stringify({ title: 'October fixes', changes: ['- one'] }),
    });
    expect(res.status).toBe(200);
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({
      actor_id: 'named:SenatorBrukus',
      actor_name: 'SenatorBrukus',
      action: 'changelog.post',
      target: 'October fixes',
    });
    const body = (await res.json()) as { actor: string };
    expect(body.actor).toBe('named:SenatorBrukus');
  });

  it('the bare service token (owner script) gets the shared-bot attribution', async () => {
    initEnv({ CHANGELOG_CHANNEL_ID: '1234567890' });
    const res = await changelogApi.request('/changelog/post', {
      method: 'POST',
      headers: SERVICE,
      body: JSON.stringify({ title: 'October fixes', changes: ['- one'] }),
    });
    expect(res.status).toBe(200);
    expect(actionRows).toHaveLength(1);
    expect(actionRows[0]).toMatchObject({ actor_id: 'service:bot', action: 'changelog.post' });
  });
});

describe('panel action-log reader', () => {
  it('serves the trail to a staff token (helper+ gate) with the actor mapped', async () => {
    actionRows.push({
      id: 'act_1', ts: Date.now(), actor_id: 'discord:222222222222222222',
      actor_name: 'SenatorBrukus', action: 'ticket.note', target: 'tk-1', detail: 'chars=5',
    });
    const res = await adminPanelV2.request('/admin/actions', {
      method: 'GET',
      headers: { ...BOT, 'X-Staff-Token': 'stafftok1', 'X-Staff-Actor': 'SenatorBrukus' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: Array<{ actorId: string; actorName: string; action: string }>;
      total: number;
    };
    expect(body.total).toBeGreaterThanOrEqual(1);
    const row = body.entries.find((e) => e.actorId === 'discord:222222222222222222');
    expect(row).toBeDefined();
    expect(row).toMatchObject({ actorName: 'SenatorBrukus', action: 'ticket.note' });
  });

  it('refuses an unranked identity (403)', async () => {
    const res = await adminPanelV2.request('/admin/actions', { method: 'GET', headers: BOT });
    expect(res.status).toBe(403);
  });
});
