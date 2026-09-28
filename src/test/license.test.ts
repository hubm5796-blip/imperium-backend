import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * LICENSE ENDPOINTS (anti-piracy build 2026-09-26 + hardening #5):
 *   1. GET /api/license/status — public (no token); unknown id → valid:true; revoked id →
 *      valid:false + revokedAt + reason.
 *   2. The kill switch: a '__ALL__' row flips EVERY id to valid:false (key-rotation
 *      insurance if the private key ever leaks).
 *   3. POST /api/v2/admin/licenses/revoke — INTERNAL_SERVICE_TOKEN only (the shared bot
 *      token is refused); id '__ALL__' additionally demands confirm:"KILL-ALL".
 *   4. MOUNT ORDER (pinned against the full app): the public route needs no auth while the
 *      revoke route 401s without the service token — and, because it is mounted BEFORE the
 *      v2 sub-app, adminPanelV2's staff-session gate over '/admin*' does NOT layer on top
 *      (the service token alone must suffice).
 */

interface RevocationRow {
  id: string;
  revoked_at: number;
  reason: string | null;
}

const { rows } = vi.hoisted(() => ({ rows: [] as RevocationRow[] }));

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
              return null as T | null;
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
          return null as T | null;
        },
        async all<T>() {
          return { results: queryRows(sql, []) as T[] };
        },
      };
    },
  };
}

function applyWrite(sql: string, params: unknown[]): void {
  if (/^CREATE TABLE/i.test(sql)) return;
  if (/^INSERT INTO license_revocations/.test(sql)) {
    const [id, revokedAt, reason] = params as [string, number, string | null];
    // Mirror the ON CONFLICT upsert semantics: re-revoke refreshes reason/time.
    const existing = rows.find((r) => r.id === id);
    if (existing) {
      existing.revoked_at = revokedAt;
      existing.reason = reason;
    } else {
      rows.push({ id, revoked_at: revokedAt, reason });
    }
  }
}

function queryRows(sql: string, params: unknown[]): RevocationRow[] {
  if (/FROM license_revocations/.test(sql) && /id = \? OR id = \?/.test(sql)) {
    const [id, killAll] = params as [string, string];
    return rows.filter((r) => r.id === id || r.id === killAll);
  }
  return [];
}

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    getD1: vi.fn(() => fakeD1()),
  };
});

import { licenseStatusApi, licenseAdminApi, KILL_ALL_ID } from '../api/license.js';
import { createApp } from '../app.js';
import { __resetEnvForTests, initEnvFromBindings } from '../env.js';

const SERVICE = { 'X-Bot-Token': 'service-token-0123456789' };
const SHARED_BOT = { 'X-Bot-Token': 'bot-token-0123456789' };

let app: ReturnType<typeof createApp>;

function initEnv(): void {
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
    NODE_ENV: 'test',
  } as unknown as Record<string, unknown>);
}

beforeEach(() => {
  rows.length = 0;
  initEnv();
  app = createApp();
});

// ── Public status read ──────────────────────────────────────────────────────────────────

describe('GET /api/license/status', () => {
  it('an unknown license id is valid', async () => {
    const res = await licenseStatusApi.request('/license/status?id=imc-unknown');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ valid: true });
  });

  it('a revoked license id is invalid with reason and timestamp', async () => {
    rows.push({ id: 'imc-live01', revoked_at: 1_798_929_600_000, reason: 'stolen jar sweep' });
    const res = await licenseStatusApi.request('/license/status?id=imc-live01');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { valid: boolean; revokedAt: number; reason: string };
    expect(body.valid).toBe(false);
    expect(body.revokedAt).toBe(1_798_929_600_000);
    expect(body.reason).toBe('stolen jar sweep');
  });

  it('rejects missing or malformed ids', async () => {
    const missing = await licenseStatusApi.request('/license/status');
    expect(missing.status).toBe(400);
    const garbage = await licenseStatusApi.request('/license/status?id=' + encodeURIComponent('x; DROP TABLE'));
    expect(garbage.status).toBe(400);
    expect(rows).toHaveLength(0);
  });
});

// ── The global kill switch ──────────────────────────────────────────────────────────────

describe('kill-all row (__ALL__)', () => {
  it('a __ALL__ row marks EVERY license id invalid', async () => {
    rows.push({ id: KILL_ALL_ID, revoked_at: Date.now(), reason: 'private key leak — re-keying' });
    for (const id of ['imc-live01', 'imc-other02', 'imc-brand-new99']) {
      const res = await licenseStatusApi.request(`/license/status?id=${id}`);
      const body = (await res.json()) as { valid: boolean; global?: boolean };
      expect(body.valid, `id ${id} must be invalid under the kill switch`).toBe(false);
      expect(body.global).toBe(true);
    }
  });

  it('a specific revocation does NOT affect other ids', async () => {
    rows.push({ id: 'imc-live01', revoked_at: Date.now(), reason: 'one bad jar' });
    const other = await licenseStatusApi.request('/license/status?id=imc-other02');
    expect(((await other.json()) as { valid: boolean }).valid).toBe(true);
  });
});

// ── Admin revoke ────────────────────────────────────────────────────────────────────────

describe('POST /api/v2/admin/licenses/revoke', () => {
  it('demands the INTERNAL_SERVICE_TOKEN — the shared bot token is refused', async () => {
    const shared = await licenseAdminApi.request('/revoke', {
      method: 'POST',
      headers: { ...SHARED_BOT, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'imc-live01' }),
    });
    expect(shared.status).toBe(401);
    expect(rows).toHaveLength(0);
  });

  it('the service token revokes an id (idempotent upsert)', async () => {
    const first = await licenseAdminApi.request('/revoke', {
      method: 'POST',
      headers: { ...SERVICE, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'imc-live01', reason: 'stolen jar sweep' }),
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ revoked: true, id: 'imc-live01', global: false });
    expect(rows).toHaveLength(1);

    // Re-revoke refreshes the reason, does not duplicate the row.
    await licenseAdminApi.request('/revoke', {
      method: 'POST',
      headers: { ...SERVICE, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'imc-live01', reason: 'updated reason' }),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'imc-live01', reason: 'updated reason' });

    // And the status read now sees it.
    const status = await licenseStatusApi.request('/license/status?id=imc-live01');
    expect(((await status.json()) as { valid: boolean }).valid).toBe(false);
  });

  it('revoking __ALL__ demands the explicit confirmation', async () => {
    const unconfirmed = await licenseAdminApi.request('/revoke', {
      method: 'POST',
      headers: { ...SERVICE, 'content-type': 'application/json' },
      body: JSON.stringify({ id: KILL_ALL_ID, reason: 'fat finger' }),
    });
    expect(unconfirmed.status).toBe(400);
    expect(rows).toHaveLength(0);

    const confirmed = await licenseAdminApi.request('/revoke', {
      method: 'POST',
      headers: { ...SERVICE, 'content-type': 'application/json' },
      body: JSON.stringify({ id: KILL_ALL_ID, reason: 'private key leak', confirm: 'KILL-ALL' }),
    });
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({ revoked: true, global: true });
    expect(rows.map((r) => r.id)).toEqual([KILL_ALL_ID]);
  });

  it('rejects malformed bodies', async () => {
    const noId = await licenseAdminApi.request('/revoke', {
      method: 'POST',
      headers: { ...SERVICE, 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'no id' }),
    });
    expect(noId.status).toBe(400);
    const badJson = await licenseAdminApi.request('/revoke', {
      method: 'POST',
      headers: { ...SERVICE, 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(badJson.status).toBe(400);
  });
});

// ── Mount order (the v2-mount scoping lesson, pinned end-to-end) ────────────────────────

describe('mount order through the full app', () => {
  function ip(): string {
    return `198.51.100.${Math.floor(Math.random() * 250)}`;
  }

  it('the public status route needs NO token through the real app', async () => {
    const res = await app.request('/api/license/status?id=imc-live01', {
      headers: { 'CF-Connecting-IP': ip() },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { valid: boolean }).valid).toBe(true);
  });

  it('the revoke route 401s without a token and accepts the service token alone (no staff session)', async () => {
    const denied = await app.request('/api/v2/admin/licenses/revoke', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': ip(), 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'imc-live01' }),
    });
    expect(denied.status).toBe(401);
    expect(rows).toHaveLength(0);

    // No cookies, no session — the service token is the ONLY credential. If adminPanelV2's
    // staff gate over '/admin*' had claimed this path, this call would 401/403 even WITH
    // the token.
    const allowed = await app.request('/api/v2/admin/licenses/revoke', {
      method: 'POST',
      headers: { ...SERVICE, 'CF-Connecting-IP': ip(), 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'imc-live01', reason: 'mount-order test' }),
    });
    expect(allowed.status).toBe(200);
    expect(rows).toHaveLength(1);
  });

  it('a revoke through the real app is visible through the public status route', async () => {
    await app.request('/api/v2/admin/licenses/revoke', {
      method: 'POST',
      headers: { ...SERVICE, 'CF-Connecting-IP': ip(), 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'imc-e2e', reason: 'end to end' }),
    });
    const status = await app.request('/api/license/status?id=imc-e2e', {
      headers: { 'CF-Connecting-IP': ip() },
    });
    const body = (await status.json()) as { valid: boolean; reason: string };
    expect(body.valid).toBe(false);
    expect(body.reason).toBe('end to end');
  });
});
