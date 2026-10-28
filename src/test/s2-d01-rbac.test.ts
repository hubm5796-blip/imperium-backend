import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * S2-D01 — staff RBAC fail-closed (Season 2, Lane D wave 0).
 *
 * Regression tests that FAIL on the pre-packet code:
 *   1. the default-credential path no longer reaches any /admin/* route —
 *      /api/admin/ai-artifacts* accepted the bare shared bot/service token
 *      with NO staff role (every other admin surface declares one);
 *   2. a valid staff token reaches exactly its role's routes and nothing else;
 *   3. an admin dispatch (punish/broadcast/reload) writes an ATTRIBUTED
 *      action_log audit row — the v1 dispatches previously shipped with no
 *      backend audit row at all (logger.warn only);
 *   4. no credentials on any /admin/* route is a 401, never a silently-open path.
 */

const { sendCommandWithResponseMock, d1Stmts } = vi.hoisted(() => ({
  sendCommandWithResponseMock: vi.fn(),
  /** Every D1 statement executed through getD1(), with its bound params. */
  d1Stmts: [] as Array<{ sql: string; params: unknown[] }>,
}));

vi.mock('../db/redis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/redis.js')>();
  return {
    ...actual,
    sendCommandWithResponse: sendCommandWithResponseMock,
    getOnlinePlayerCount: vi.fn(async () => 7),
    getCachedJson: vi.fn(async () => null),
    setCachedJson: vi.fn(async () => undefined),
  };
});

/** D1 fake that records every statement (for the audit-row assertions). */
function makeRecordingD1() {
  return {
    prepare(sql: string) {
      const exec = {
        bind: (...params: unknown[]) => ({
          run: async () => {
            d1Stmts.push({ sql, params });
            return { meta: { changes: 1 } };
          },
          first: async () => null,
          all: async () => ({ results: [] }),
        }),
        run: async () => {
          d1Stmts.push({ sql, params: [] });
          return { meta: { changes: 1 } };
        },
        first: async () => null,
        all: async () => ({ results: [] }),
      };
      return exec;
    },
  };
}

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    getUuidByDiscordId: vi.fn(async () => null),
    query: vi.fn(async () => ({ rows: [] })),
  };
});

import { createApp } from '../app.js';
import { initEnvFromBindings } from '../env.js';
import { initD1 } from '../db/pool.js';
import { sendCommandWithResponse } from '../db/redis.js';

let app: ReturnType<typeof createApp>;

const STAFF_MAP = 'stafftok_helper:HelperHannah:helper,stafftok_mod:ModMarcus:mod,stafftok_admin:AdminAria:admin';

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
    STAFF_ACTOR_TOKEN_MAP: STAFF_MAP,
    // The ai-artifacts routes proxy the Pterodactyl panel; configured so the
    // authenticated-path assertions get a 200 rather than the setup hint.
    PANEL_URL: 'https://panel.example.test',
    PANEL_API_KEY: 'ptk_test',
    PANEL_SERVER_ID: 'srv1',
    D1_RATE_LIMIT: { stub: true },
  } as unknown as Record<string, unknown>);
  initD1(makeRecordingD1() as never);
  app = createApp();
});

/* ── 1+4: the default path is closed on EVERY /admin/* route ─────────────── */

const ADMIN_GET_ROUTES = [
  '/api/admin/server/status',
  '/api/admin/player?query=griefos',
  '/api/admin/liveops',
  '/api/admin/contraband/sweeps',
  '/api/admin/player-tools',
  '/api/admin/ai-artifacts',
  '/api/admin/ai-artifacts/content?name=face.png',
  '/api/v2/admin/anticheat/alerts',
  '/api/v2/admin/anticheat/summary',
  '/api/v2/admin/audit',
  '/api/v2/admin/actions',
  '/api/v2/admin/economy/transactions?uuid=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
];
const ADMIN_POST_ROUTES = ['/api/admin/punish', '/api/admin/broadcast', '/api/admin/reload'];

describe('S2-D01: no credential on /admin/* is 401', () => {
  it('every admin GET answers 401 with no credentials at all', async () => {
    for (const path of ADMIN_GET_ROUTES) {
      const res = await app.request(path);
      expect(res.status, path).toBe(401);
    }
  });

  it('every admin POST answers 401 with no credentials at all', async () => {
    for (const path of ADMIN_POST_ROUTES) {
      const res = await app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status, path).toBe(401);
    }
  });

  // THE REGRESSION: the two ai-artifacts routes accepted the bare shared bot
  // token (200) — the shared service credential must not substitute for a
  // declared staff role anywhere on /admin/*.
  it('the shared bot/service token alone does NOT open the role-less admin routes (403)', async () => {
    for (const path of ['/api/admin/ai-artifacts', '/api/admin/ai-artifacts/content?name=face.png']) {
      const res = await app.request(path, { headers: { 'X-Bot-Token': 'test-bot-token' } });
      expect(res.status, path).toBe(403);
    }
  });
});

/* ── 2: a valid staff token reaches exactly its role's routes ────────────── */

describe('S2-D01: staff tokens reach exactly their role tier', () => {
  function staff(token: string, actor: string): Record<string, string> {
    return { 'X-Staff-Token': token, 'X-Staff-Actor': actor };
  }

  it('helper: broadcast + ai-artifacts yes; punish + reload no', async () => {
    sendCommandWithResponseMock.mockResolvedValue({ ok: true, status: 'OK' });
    const h = staff('stafftok_helper', 'HelperHannah');
    expect(
      (await app.request('/api/admin/broadcast', { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify({ message: 'Hail' }) })).status,
    ).toBe(200);
    const artifacts = await app.request('/api/admin/ai-artifacts', { headers: h });
    expect(artifacts.status).toBe(200);
    expect(
      (await app.request('/api/admin/punish', { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify({ target: 'x', action: 'ban' }) })).status,
    ).toBe(403);
    expect((await app.request('/api/admin/reload', { method: 'POST', headers: h })).status).toBe(403);
  });

  it('mod: punish yes; reload still no', async () => {
    sendCommandWithResponseMock.mockResolvedValue({ ok: true, status: 'OK' });
    const h = staff('stafftok_mod', 'ModMarcus');
    expect(
      (await app.request('/api/admin/punish', { method: 'POST', headers: { 'Content-Type': 'application/json', ...h }, body: JSON.stringify({ target: 'griefos', action: 'ban', reason: 'test' }) })).status,
    ).toBe(200);
    expect((await app.request('/api/admin/reload', { method: 'POST', headers: h })).status).toBe(403);
  });

  it('admin: reload yes', async () => {
    sendCommandWithResponseMock.mockResolvedValue({ ok: true, status: 'OK' });
    expect(
      (await app.request('/api/admin/reload', { method: 'POST', headers: staff('stafftok_admin', 'AdminAria') })).status,
    ).toBe(200);
  });

  it('a spoofed body actor never rides the dispatch or the audit trail', async () => {
    sendCommandWithResponseMock.mockClear();
    sendCommandWithResponseMock.mockResolvedValue({ ok: true, status: 'OK' });
    // A mod token punishes; the body claims a different actor.
    const res = await app.request('/api/admin/punish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...staff('stafftok_mod', 'ModMarcus') },
      body: JSON.stringify({ target: 'griefos', action: 'ban', actor: 'SomeoneElse' }),
    });
    expect(res.status).toBe(200);
    const cmd = sendCommandWithResponseMock.mock.calls.find(([type]) => type === 'PUNISH_PLAYER');
    expect(cmd?.[1]).toMatchObject({ actor: 'ModMarcus' }); // resolved principal, never the body value
  });
});

/* ── 3: admin dispatches write attributed audit rows ─────────────────────── */

describe('S2-D01: admin actions write attributed audit rows', () => {
  it('a successful punish writes an action_log row naming the acting staff', async () => {
    d1Stmts.length = 0;
    sendCommandWithResponseMock.mockResolvedValue({ ok: true, status: 'OK' });
    const res = await app.request('/api/admin/punish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Staff-Token': 'stafftok_mod', 'X-Staff-Actor': 'ModMarcus' },
      body: JSON.stringify({ target: 'griefos', action: 'ban', reason: 'S2-D01 audit' }),
    });
    expect(res.status).toBe(200);
    const insert = d1Stmts.find((s) => s.sql.includes('INSERT INTO action_log'));
    expect(insert, 'expected an action_log INSERT — admin dispatches must leave an attributed audit row').toBeTruthy();
    const params = insert!.params as string[];
    // (id, ts, actor_id, actor_name, action, target, detail)
    expect(params[2]).toBe('named:ModMarcus');
    expect(params[3]).toBe('ModMarcus');
    expect(params[4]).toBe('admin.punish');
    expect(params[5]).toBe('griefos');
  });

  it('broadcast and reload write attributed rows too', async () => {
    d1Stmts.length = 0;
    sendCommandWithResponseMock.mockResolvedValue({ ok: true, status: 'OK' });
    await app.request('/api/admin/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Staff-Token': 'stafftok_helper', 'X-Staff-Actor': 'HelperHannah' },
      body: JSON.stringify({ message: 'Hail, Rome' }),
    });
    await app.request('/api/admin/reload', {
      method: 'POST',
      headers: { 'X-Staff-Token': 'stafftok_admin', 'X-Staff-Actor': 'AdminAria' },
    });
    const actions = d1Stmts
      .filter((s) => s.sql.includes('INSERT INTO action_log'))
      .map((s) => (s.params as string[])[4]);
    expect(actions).toContain('admin.broadcast');
    expect(actions).toContain('admin.reload');
  });

  it('a refused dispatch writes no audit row (rows record actions that happened)', async () => {
    d1Stmts.length = 0;
    sendCommandWithResponseMock.mockClear();
    await app.request('/api/admin/punish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Staff-Token': 'stafftok_helper', 'X-Staff-Actor': 'HelperHannah' },
      body: JSON.stringify({ target: 'griefos', action: 'ban' }),
    });
    expect(sendCommandWithResponseMock).not.toHaveBeenCalled();
    expect(d1Stmts.find((s) => s.sql.includes('INSERT INTO action_log'))).toBeUndefined();
  });
});
