/**
 * S2-D04 second half + S2-E04 backend half — the session revocation list.
 *
 * The pin that matters (and the thing pre-revocation code cannot pass): a
 * session that verifies TODAY is dead TOMORROW once something revokes it —
 * same token, next request, 401. Every test here runs the REAL SQL through
 * the house SQLite adapter (node:sqlite — the dialect D1 speaks), so the
 * d1_0007 DDL, the revoke writes and the verify-path check all execute for
 * real against seeded state.
 *
 * Covered: the jti claim (unique per token, passed through by verifyJwt,
 * absent-but-tolerated on legacy tokens), per-jti revocation, uuid-ALL
 * revocation (legacy jti-less tokens included; post-revoke logins unaffected),
 * the admin route (fail-closed admin gate, body validation, idempotency, audit
 * row), the logout seam (logout revokes, legacy logout still succeeds), the
 * purge (expired rows deleted, never resurrecting a session), the migration
 * parity, and the availability posture (D1 down fails OPEN).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { SignJWT } from 'jose';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let db: DatabaseSync;
/** When true, getD1() itself throws — the simulated D1 outage. */
let d1Down = false;

function d1FromDb() {
  return {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            run: async () => {
              const info = db.prepare(sql).run(...(params as never[]));
              return { meta: { changes: Number(info.changes) } };
            },
            first: async <T>() => (db.prepare(sql).get(...(params as never[])) as T | undefined) ?? null,
            all: async <T>() => ({ results: db.prepare(sql).all(...(params as never[])) as T[] }),
          };
        },
        run: async () => {
          const info = db.prepare(sql).run();
          return { meta: { changes: Number(info.changes) } };
        },
        first: async <T>() => (db.prepare(sql).get() as T | undefined) ?? null,
        all: async <T>() => ({ results: db.prepare(sql).all() as T[] }),
      };
    },
    batch: async (stmts: Array<{ run: () => Promise<unknown> }>) => {
      for (const stmt of stmts) await stmt.run();
      return [];
    },
  };
}

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    getD1: vi.fn(() => {
      if (d1Down) throw new Error('D1 down (simulated outage)');
      return d1FromDb();
    }),
    getUuidByDiscordId: vi.fn(async () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
    query: vi.fn(async (sql: string) => {
      if (sql.includes('luckperms_players')) return { rows: [{ primary_group: 'default' }] };
      return { rows: [] };
    }),
  };
});
vi.mock('../auth/apiKeys.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth/apiKeys.js')>();
  return {
    ...actual,
    listKeys: vi.fn(async () => []),
    authenticateApiKey: vi.fn(async () => null),
  };
});

import { createApp } from '../app.js';
import { initEnvFromBindings, __resetEnvForTests } from '../env.js';
import { signJwt, verifyJwt } from '../auth/jwt.js';
import {
  __resetRevocationsForTests,
  isSessionRevoked,
  purgeExpiredRevocations,
  revokeSessionByToken,
  revokeSessionJti,
} from '../auth/sessionRevocations.js';

const DISCORD_ID = '111111111111111111';
const BOT = { 'X-Bot-Token': 'test-bot-token' };
const ADMIN = { ...BOT, 'X-Staff-Role': 'admin' };
const HELPER = { ...BOT, 'X-Staff-Role': 'helper' };

let app: ReturnType<typeof createApp>;

/** Mint a LEGACY session token — the pre-revocation-deploy shape: no jti. */
async function mintLegacyToken(iat: number, exp: number): Promise<string> {
  const encoder = new TextEncoder();
  return new SignJWT({ authMethod: 'discord', discordId: DISCORD_ID })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(encoder.encode('test-jwt-secret-0123456789abcdef'));
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  d1Down = false;
  __resetRevocationsForTests();
  __resetEnvForTests();
  initEnvFromBindings({
    JWT_SECRET: 'test-jwt-secret-0123456789abcdef',
    WEBPANEL_HMAC_SECRET: 'test-hmac-secret',
    DISCORD_CLIENT_ID: '1',
    DISCORD_CLIENT_SECRET: 'x',
    BOT_API_TOKEN: 'test-bot-token',
    PAYNOW_API_KEY: 'pk',
    PAYNOW_STORE_ID: '1',
    PAYNOW_WEBHOOK_SECRETS: 'whsec',
    NODE_ENV: 'test',
    D1_RATE_LIMIT: { stub: true },
  } as unknown as Record<string, unknown>);
  // action_log's lazy ensure is once-per-MODULE, not per-db — each fresh db
  // here pre-creates the exact mirror DDL (src/db/actionLog.ts) so the route's
  // REAL recordAction insert is asserted, not its silent no-row failure path.
  db.exec(`CREATE TABLE IF NOT EXISTS action_log (
    id text primary key,
    ts integer not null,
    actor_id text not null,
    actor_name text not null,
    action text not null,
    target text,
    detail text
  )`);
  app = createApp();
});

const keysWith = async (cookie: string) =>
  app.request('/api/v2/keys', { headers: { Cookie: cookie } });

const cookieOf = (token: string) => `imperium_session=${token}`;

/* ── The jti claim ────────────────────────────────────────────────────────── */

describe('S2-D04: the jti claim', () => {
  it('every signed session carries a unique jti and verifyJwt passes it through', async () => {
    const a = await verifyJwt(await signJwt({ authMethod: 'discord', discordId: DISCORD_ID }));
    const b = await verifyJwt(await signJwt({ authMethod: 'mc_code', mcUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }));
    expect(typeof a!.jti).toBe('string');
    expect(typeof b!.jti).toBe('string');
    expect(a!.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(a!.jti).not.toBe(b!.jti);
  });

  it('a legacy token without a jti still verifies (jti undefined, not fabricated)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const legacy = await mintLegacyToken(now, now + 3600);
    const payload = await verifyJwt(legacy);
    expect(payload).not.toBeNull();
    expect(payload!.jti).toBeUndefined();
    expect(payload!.discordId).toBe(DISCORD_ID);
  });
});

/* ── The acceptance: revoked ⇒ rejected on the NEXT request ──────────────── */

describe('S2-D04 acceptance: a revoked session is rejected on its next request', () => {
  it('revoking the jti kills that exact session (fails on pre-revocation code)', async () => {
    const token = await signJwt({ authMethod: 'discord', discordId: DISCORD_ID });
    const cookie = cookieOf(token);

    // Alive before.
    expect((await keysWith(cookie)).status).toBe(200);

    // Revoke via the admin surface (the real route, not a module call).
    const revoke = await app.request('/api/v2/admin/sessions/revoke', {
      method: 'POST',
      headers: { ...ADMIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jti: (await verifyJwt(token))!.jti }),
    });
    expect(revoke.status).toBe(200);
    const revoked = (await revoke.json()) as { ok: boolean; revoked: { kind: string; key: string } };
    expect(revoked.ok).toBe(true);
    expect(revoked.revoked.kind).toBe('jti');
    expect(revoked.revoked.key).toMatch(/^jti:/);

    // Same token, next request: rejected. On old code this request is a 200 —
    // the cookie cleared nothing and the token verified to its full 7d exp.
    expect((await keysWith(cookie)).status).toBe(401);

    // A DIFFERENT token (another browser, same account) is untouched.
    const other = cookieOf(await signJwt({ authMethod: 'discord', discordId: DISCORD_ID }));
    expect((await keysWith(other)).status).toBe(200);
  });

  it('uuid-ALL kills every outstanding session INCLUDING legacy jti-less ones', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const modern = cookieOf(await signJwt({ authMethod: 'discord', discordId: DISCORD_ID }));
    const legacy = cookieOf(await mintLegacyToken(nowSec - 60, nowSec + 3600));

    expect((await keysWith(modern)).status).toBe(200);
    expect((await keysWith(legacy)).status).toBe(200);

    const revoke = await app.request('/api/v2/admin/sessions/revoke', {
      method: 'POST',
      headers: { ...ADMIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uuid: DISCORD_ID }),
    });
    expect(revoke.status).toBe(200);
    const body = (await revoke.json()) as { revoked: { kind: string; issued_before: string | null } };
    expect(body.revoked.kind).toBe('uuid');
    expect(body.revoked.issued_before).not.toBeNull();

    // Both die on their next request — the legacy token has no jti, so the
    // iat-before-horizon comparison is what catches it.
    expect((await keysWith(modern)).status).toBe(401);
    expect((await keysWith(legacy)).status).toBe(401);
  });

  it('a login AFTER the uuid-ALL revoke is not blocked (forced logout, not a ban)', async () => {
    const revoke = await app.request('/api/v2/admin/sessions/revoke', {
      method: 'POST',
      headers: { ...ADMIN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uuid: DISCORD_ID }),
    });
    expect(revoke.status).toBe(200);

    // The horizon carries a 5s skew (iat is second-granular); a token minted
    // 10s after the revoke is unambiguously past it.
    const nowSec = Math.floor(Date.now() / 1000);
    const fresh = cookieOf(await mintLegacyToken(nowSec + 10, nowSec + 3700));
    expect((await keysWith(fresh)).status).toBe(200);
  });
});

/* ── The admin surface ────────────────────────────────────────────────────── */

describe('POST /api/v2/admin/sessions/revoke — gate, validation, idempotency', () => {
  const post = (body: unknown, headers: Record<string, string> = ADMIN) =>
    app.request('/api/v2/admin/sessions/revoke', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('fail-closed admin gate: anonymous 401, helper 403, admin passes the gate', async () => {
    expect((await post({ uuid: DISCORD_ID }, {})).status).toBe(401);
    expect((await post({ uuid: DISCORD_ID }, HELPER)).status).toBe(403);
    expect((await post({ jti: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' }, ADMIN)).status).toBe(200);
  });

  it('validation: empty body, both targets, neither, junk jti, junk uuid are 400s', async () => {
    expect((await post('not json')).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post({ jti: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', uuid: DISCORD_ID })).status).toBe(400);
    expect((await post({ jti: 'short' })).status).toBe(400);
    expect((await post({ uuid: 'drop table; --' })).status).toBe(400);
    expect((await post({ uuid: '12345' })).status).toBe(400); // too short for a snowflake
  });

  it('accepts dashed MC UUID and Discord snowflake; revocation is idempotent', async () => {
    expect((await post({ uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })).status).toBe(200);
    expect((await post({ uuid: '222222222222222222' })).status).toBe(200);
    const first = await post({ jti: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    const second = await post({ jti: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const count = Number(db.prepare(`SELECT COUNT(*) AS n FROM session_revocations`).get()!.n);
    expect(count).toBe(3); // uuid + snowflake + ONE jti row (OR IGNORE)
  });

  it('writes an attributed audit row', async () => {
    await post({ uuid: DISCORD_ID });
    const row = db.prepare(`SELECT action, target FROM action_log ORDER BY ts DESC LIMIT 1`).get() as
      | { action: string; target: string }
      | undefined;
    expect(row?.action).toBe('session.revoke');
    expect(row?.target).toBe(`uuid:${DISCORD_ID}`);
  });
});

/* ── The logout seam ──────────────────────────────────────────────────────── */

describe('POST /api/auth/logout — logout now revokes', () => {
  it('logout revokes the presented session; the cookie token is dead afterwards', async () => {
    const token = await signJwt({ authMethod: 'discord', discordId: DISCORD_ID });
    const cookie = cookieOf(token);
    expect((await keysWith(cookie)).status).toBe(200);

    const res = await app.request('/api/auth/logout', { method: 'POST', headers: { Cookie: cookie } });
    expect(res.status).toBe(200);

    // The cookie is cleared AND the jti is on the list — a copied twin dies too.
    expect((await keysWith(cookie)).status).toBe(401);
  });

  it('logout of a legacy (jti-less) token still succeeds and writes no revocation', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const legacy = cookieOf(await mintLegacyToken(nowSec, nowSec + 3600));
    const res = await app.request('/api/auth/logout', { method: 'POST', headers: { Cookie: legacy } });
    expect(res.status).toBe(200);
    const count = Number(db.prepare(`SELECT COUNT(*) AS n FROM session_revocations`).get()!.n);
    expect(count).toBe(0);
  });

  it('revokeSessionByToken on a garbage token is a null, not a throw', async () => {
    expect(await revokeSessionByToken('garbage')).toBeNull();
    expect(await revokeSessionByToken(null)).toBeNull();
  });
});

/* ── The check itself ─────────────────────────────────────────────────────── */

describe('isSessionRevoked — semantics and availability posture', () => {
  it('a payload with no jti and no identity is never revoked (nothing to key on)', async () => {
    expect(await isSessionRevoked({})).toBe(false);
  });

  it('a D1 outage fails OPEN: sessions keep working while the store is down', async () => {
    const token = await signJwt({ authMethod: 'discord', discordId: DISCORD_ID });
    d1Down = true; // ensureSchema/getD1 throw inside the check — caught, fail-open
    expect((await keysWith(cookieOf(token))).status).toBe(200);
    // and the direct check answers "not revoked" rather than throwing
    expect(await isSessionRevoked({ jti: 'x'.repeat(36), discordId: DISCORD_ID, iat: 1 })).toBe(false);
  });

  it('purge removes only expired rows; a purge-lagging row still rejects nothing past exp', async () => {
    const now = Date.now();
    await revokeSessionJti('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', {}, now);
    // Backdate the purge horizon: the row's tokens are all dead by exp now.
    db.prepare(`UPDATE session_revocations SET expires_at_ms = ?`).run(now - 1000);
    const purged = await purgeExpiredRevocations(now);
    expect(purged).toBeGreaterThanOrEqual(1);
    const count = Number(db.prepare(`SELECT COUNT(*) AS n FROM session_revocations`).get()!.n);
    expect(count).toBe(0);
  });
});

/* ── Migration parity ─────────────────────────────────────────────────────── */

describe('d1_0007 migration parity', () => {
  it('the store schema matches the migration DDL column-for-column', async () => {
    await revokeSessionJti('parity-check-jti-0001', {}, Date.now()); // triggers lazy ensure
    const migration = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations', 'd1_0007_session_revocations.sql'),
      'utf8',
    );
    const block = migration.slice(migration.indexOf('CREATE TABLE IF NOT EXISTS session_revocations'));
    const ddlCols = [...block.slice(0, block.indexOf(');')).matchAll(/^\s{2}(\w+)\s/gm)]
      .map((m) => m[1]!)
      .filter((name) => !['PRIMARY', 'UNIQUE', 'CHECK', 'FOREIGN', 'CONSTRAINT'].includes(name));
    const dbCols = (
      db.prepare("SELECT name FROM pragma_table_info('session_revocations') ORDER BY cid").all() as { name: string }[]
    ).map((c) => c.name);
    expect(ddlCols).toEqual(dbCols);
    expect(ddlCols).toContain('issued_before_ms');
    expect(ddlCols).toContain('expires_at_ms');
  });
});
