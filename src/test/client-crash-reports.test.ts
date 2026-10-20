import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ImperiumMC#3 — client crash-report endpoint:
 *   1. POST is anonymous: validation rejections (types, missing fields,
 *      non-object bodies), the 256 KB body cap (413 before parsing), and
 *      server-side hard truncation of logTail (32 KB) / crashReport (64 KB),
 *      including a multi-byte boundary cut.
 *   2. Rate limit: 5/hour per IP through the real D1 limiter — the 6th post
 *      from one IP is 429 + Retry-After, and nothing is stored.
 *   3. GET /client/crash-report/:id and /client/crash-reports are
 *      staff-gated: 401 without credentials, 403 for a token without a staff
 *      role, 200 for the authenticated staff path; the list is newest-first
 *      with counts by cause and rejects unknown query params.
 */

interface FakeRow {
  id: string;
  created_at: number;
  ip_hash: string;
  launcher: string;
  launcher_version: string;
  client_version: string | null;
  mc_version: string | null;
  platform: string;
  cause: string;
  mod: string | null;
  log_tail: string;
  crash_report: string | null;
}

const { rows, rlWindows } = vi.hoisted(() => ({
  rows: [] as FakeRow[],
  rlWindows: new Map<string, number>(),
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
              // The limiter's INSERT ... ON CONFLICT ... RETURNING executes its
              // increment THROUGH first() — mirror that (write, then read).
              if (/INSERT INTO rate_limit_windows/i.test(sql)) {
                applyWrite(sql, params);
                return { hits: rlWindows.get(String(params[0])) ?? 1 } as T;
              }
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
          if (/INSERT INTO rate_limit_windows/i.test(sql)) {
            applyWrite(sql, []);
            return { hits: 1 } as T;
          }
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
  if (/^CREATE (TABLE|INDEX)/i.test(sql)) return;
  if (/^DELETE FROM rate_limit_windows/i.test(sql)) return; // limiter's opportunistic cleanup
  if (/INSERT INTO rate_limit_windows/i.test(sql)) {
    // The real limiter's upsert-increment: first hit inserts 1, later hits +1.
    const key = String(params[0]);
    rlWindows.set(key, (rlWindows.get(key) ?? 0) + 1);
    return;
  }
  if (/INSERT INTO client_crash_reports/i.test(sql)) {
    const [id, createdAt, ipHash, launcher, launcherVersion, clientVersion, mcVersion, platform, cause, mod, logTail, crashReport] =
      params as [string, number, string, string, string, string | null, string | null, string, string, string | null, string, string | null];
    rows.push({
      id,
      created_at: createdAt,
      ip_hash: ipHash,
      launcher,
      launcher_version: launcherVersion,
      client_version: clientVersion,
      mc_version: mcVersion,
      platform,
      cause,
      mod,
      log_tail: logTail,
      crash_report: crashReport,
    });
    return;
  }
}

function queryRows(sql: string, params: unknown[]): unknown[] {
  if (/GROUP BY cause/i.test(sql)) {
    // counts by cause (top N by count)
    const limit = Number(params[0] ?? 10);
    const byCause = new Map<string, number>();
    for (const r of rows) byCause.set(r.cause, (byCause.get(r.cause) ?? 0) + 1);
    return [...byCause.entries()]
      .map(([cause, n]) => ({ cause, n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, limit);
  }
  if (/FROM client_crash_reports/i.test(sql) && /ORDER BY created_at DESC/i.test(sql)) {
    const limit = Number(params[0] ?? 50);
    return rows.slice().sort((a, b) => b.created_at - a.created_at).slice(0, limit);
  }
  return [];
}

function queryFirst(sql: string, params: unknown[]): unknown {
  if (/INSERT INTO rate_limit_windows/i.test(sql)) {
    const key = String(params[0]);
    return { hits: rlWindows.get(key) ?? 1 };
  }
  if (/FROM client_crash_reports/i.test(sql) && /WHERE id = \?/i.test(sql)) {
    return rows.find((r) => r.id === params[0]) ?? null;
  }
  if (/SELECT COUNT\(\*\) AS n FROM client_crash_reports/i.test(sql)) {
    return { n: rows.length };
  }
  return null;
}

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    getD1: vi.fn(() => fakeD1()),
  };
});

import { Hono } from 'hono';
import { crashReportsV2 } from '../api/v2/crashReports.js';
import { attachUser } from '../middleware/auth.js';
import { __resetEnvForTests, initEnvFromBindings } from '../env.js';
import type { AppContextVariables } from '../types/index.js';

// Production mounts attachUser before the v2 sub-app; without it `user` is
// UNDEFINED (not null) on a bare sub-app and isAuthenticated() misreads that
// as a credential. Route through the real middleware so the gate behaves
// exactly as deployed.
const app = new Hono<{ Variables: AppContextVariables }>();
app.use('*', attachUser);
app.route('/', crashReportsV2);

const STAFF = { 'X-Bot-Token': 'bot-token-0123456789', 'X-Staff-Role': 'helper' };
const BOT_NO_ROLE = { 'X-Bot-Token': 'bot-token-0123456789' };

const VALID = {
  launcher: 'imperium-launcher',
  launcherVersion: '0.1.2',
  clientVersion: '1.2.3',
  mcVersion: '1.21.4',
  platform: 'windows-x64',
  cause: 'Java heap space',
  mod: 'sodium',
  logTail: 'line1\nline2',
  crashReport: 'java.lang.OutOfMemoryError: Java heap space',
};

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
  } as unknown as Record<string, unknown>);
}

/** Fresh IP per call — each POST test needs its own 5/hour bucket. */
let ipCounter = 0;
function freshIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter % 250}`;
}

async function post(body: unknown, ip = freshIp()): Promise<Response> {
  return app.request('/client/crash-report', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  rows.length = 0;
  rlWindows.clear();
  initEnv();
});

/** True when the cut left a surrogate half without its pair (invalid Unicode). */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      const prev = i - 1 >= 0 ? s.charCodeAt(i - 1) : -1;
      if (!(prev >= 0xd800 && prev <= 0xdbff)) return true;
    }
  }
  return false;
}

describe('POST /client/crash-report — validation', () => {
  it('accepts an anonymous report and stores the row', async () => {
    const res = await post(VALID);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { id: string; url: string; truncated: { logTail: boolean; crashReport: boolean } } };
    expect(body.data.id).toMatch(/^[a-f0-9]{16}$/);
    expect(body.data.url).toBe(`/api/v2/client/crash-report/${body.data.id}`);
    expect(body.data.truncated).toEqual({ logTail: false, crashReport: false });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      launcher: 'imperium-launcher',
      launcher_version: '0.1.2',
      client_version: '1.2.3',
      mc_version: '1.21.4',
      platform: 'windows-x64',
      cause: 'Java heap space',
      mod: 'sodium',
      log_tail: 'line1\nline2',
    });
    expect(rows[0]!.ip_hash).toMatch(/^[a-f0-9]{16}$/);
  });

  it('rejects missing required fields', async () => {
    const { cause: _cause, ...noCause } = VALID;
    const missingCause = await post(noCause);
    expect(missingCause.status).toBe(400);
    expect(((await missingCause.json()) as { error: { code: string } }).error.code).toBe('INVALID_PARAM');

    const { logTail: _logTail, ...noLog } = VALID;
    const missingLog = await post(noLog);
    expect(missingLog.status).toBe(400);
    expect(rows).toHaveLength(0);
  });

  it('rejects wrong types on required and optional fields', async () => {
    for (const patch of [
      { platform: 42 },
      { launcher: ['a'] },
      { launcherVersion: 0.1 },
      { cause: null },
      { logTail: 12345 },
      { clientVersion: 7 },
      { mcVersion: true },
      { mod: {} },
      { crashReport: 9 },
    ]) {
      const res = await post({ ...VALID, ...patch });
      expect(res.status, JSON.stringify(patch)).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INVALID_PARAM');
    }
    expect(rows).toHaveLength(0);
  });

  it('rejects non-object and unparseable bodies', async () => {
    const array = await post('[1,2,3]');
    expect(array.status).toBe(400);
    const garbage = await post('not json at all');
    expect(garbage.status).toBe(400);
    expect(rows).toHaveLength(0);
  });

  it('rejects bodies over 256 KB with 413 before storing anything', async () => {
    const res = await post(JSON.stringify({ ...VALID, logTail: 'x'.repeat(280 * 1024) }));
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(rows).toHaveLength(0);
  });
});

describe('POST /client/crash-report — truncation', () => {
  it('hard-truncates logTail to 32 KB and crashReport to 64 KB', async () => {
    const res = await post({
      ...VALID,
      logTail: 'a'.repeat(100 * 1024),
      crashReport: 'b'.repeat(90 * 1024),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { truncated: { logTail: boolean; crashReport: boolean } } };
    expect(body.data.truncated).toEqual({ logTail: true, crashReport: true });
    expect(Buffer.byteLength(rows[0]!.log_tail, 'utf8')).toBe(32 * 1024);
    expect(Buffer.byteLength(rows[0]!.crash_report!, 'utf8')).toBe(64 * 1024);
  });

  it('cuts on a byte boundary for multi-byte content without splitting a codepoint', async () => {
    // 'é' is 2 UTF-8 bytes: 20 000 chars = 40 000 bytes → must come down to 32 768.
    const res = await post({ ...VALID, logTail: 'é'.repeat(20_000) });
    expect(res.status).toBe(200);
    const stored = rows[0]!.log_tail;
    expect(Buffer.byteLength(stored, 'utf8')).toBe(32 * 1024);
    expect(hasLoneSurrogate(stored)).toBe(false);
  });

  it('drops a trailing high surrogate when the budget lands mid-surrogate-pair', async () => {
    // Astral char (4 bytes each): 9 000 chars = 36 000 bytes. The proportional
    // cut lands on a char boundary in JS terms; the guard must still ensure no
    // lone high surrogate survives the final byte shave.
    const res = await post({ ...VALID, logTail: '𝕊'.repeat(9_000) });
    expect(res.status).toBe(200);
    const stored = rows[0]!.log_tail;
    expect(Buffer.byteLength(stored, 'utf8')).toBeLessThanOrEqual(32 * 1024);
    expect(hasLoneSurrogate(stored)).toBe(false);
  });
});

describe('POST /client/crash-report — rate limit', () => {
  it('allows 5 per hour per IP, then 429 + Retry-After with nothing stored', async () => {
    const ip = '203.0.113.9';
    for (let i = 0; i < 5; i++) {
      const res = await post({ ...VALID, cause: `cause-${i}` }, ip);
      expect(res.status, `post ${i + 1}`).toBe(200);
    }
    expect(rows).toHaveLength(5);

    const sixth = await post(VALID, ip);
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get('Retry-After')).toBeTruthy();
    expect(rows).toHaveLength(5); // the refused request stored nothing
  });

  it('a different IP is unaffected (per-IP buckets)', async () => {
    const ip = '203.0.113.10';
    for (let i = 0; i < 5; i++) await post(VALID, ip);
    const other = await post(VALID, '203.0.113.11');
    expect(other.status).toBe(200);
  });
});

describe('GET /client/crash-report/:id — staff gate', () => {
  it('401 without any credentials, 403 with a token but no staff role', async () => {
    const seeded = (await (await post(VALID)).json()) as { data: { id: string } };
    const id = seeded.data.id;

    const anon = await app.request(`/client/crash-report/${id}`);
    expect(anon.status).toBe(401);

    const noRole = await app.request(`/client/crash-report/${id}`, { headers: BOT_NO_ROLE });
    expect(noRole.status).toBe(403);
  });

  it('returns the full record for staff', async () => {
    const seeded = (await (await post(VALID)).json()) as { data: { id: string } };
    const id = seeded.data.id;

    const res = await app.request(`/client/crash-report/${id}`, { headers: STAFF });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; cause: string; platform: string; logTail: string; ipHash: string; createdAt: string; launcherVersion: string };
    };
    expect(body.data.id).toBe(id);
    expect(body.data.cause).toBe('Java heap space');
    expect(body.data.platform).toBe('windows-x64');
    expect(body.data.logTail).toBe('line1\nline2');
    expect(body.data.ipHash).toMatch(/^[a-f0-9]{16}$/);
    expect(body.data.createdAt).toBeTruthy();
    expect(body.data.launcherVersion).toBe('0.1.2');
  });

  it('404s unknown ids and 400s malformed ids', async () => {
    const missing = await app.request('/client/crash-report/ffffffffffffffff', { headers: STAFF });
    expect(missing.status).toBe(404);

    const malformed = await app.request('/client/crash-report/not-an-id', { headers: STAFF });
    expect(malformed.status).toBe(400);
  });
});

describe('GET /client/crash-reports — staff triage list', () => {
  it('is staff-gated the same way', async () => {
    const anon = await app.request('/client/crash-reports');
    expect(anon.status).toBe(401);
    const noRole = await app.request('/client/crash-reports', { headers: BOT_NO_ROLE });
    expect(noRole.status).toBe(403);
  });

  it('lists newest first with counts by cause, honoring limit', async () => {
    await post({ ...VALID, cause: 'Java heap space' });
    await new Promise((r) => setTimeout(r, 3));
    await post({ ...VALID, cause: 'Mod incompatibility' });
    await new Promise((r) => setTimeout(r, 3));
    await post({ ...VALID, cause: 'Java heap space' });

    const res = await app.request('/client/crash-reports', { headers: STAFF });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        reports: Array<{ id: string; cause: string; createdAt: string }>;
        total: number;
        countsByCause: Array<{ cause: string; count: number }>;
      };
    };
    expect(body.data.total).toBe(3);
    expect(body.data.reports).toHaveLength(3);
    // Newest first: the last-posted report leads.
    expect(body.data.reports[0]!.cause).toBe('Java heap space');
    expect(body.data.reports[0]!.id).toBe(rows[2]!.id);
    expect(body.data.reports[2]!.id).toBe(rows[0]!.id);
    const heap = body.data.countsByCause.find((x) => x.cause === 'Java heap space');
    const modIncomp = body.data.countsByCause.find((x) => x.cause === 'Mod incompatibility');
    expect(heap?.count).toBe(2);
    expect(modIncomp?.count).toBe(1);

    const limited = await app.request('/client/crash-reports?limit=1', { headers: STAFF });
    expect(limited.status).toBe(200);
    const limitedBody = (await limited.json()) as { data: { reports: unknown[]; total: number } };
    expect(limitedBody.data.reports).toHaveLength(1);
    expect(limitedBody.data.total).toBe(3);
  });

  it('rejects unknown query params (v2 discipline)', async () => {
    const res = await app.request('/client/crash-reports?foo=1', { headers: STAFF });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details: { allowed: string[] } } };
    expect(body.error.code).toBe('UNKNOWN_PARAM');
    expect(body.error.details.allowed).toContain('limit');
  });
});
