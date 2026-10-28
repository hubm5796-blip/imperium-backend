/**
 * S2-D04 (backend half; frontend counterpart S2-E04) — the session revocation
 * list.
 *
 * Session JWTs live 7 days (JWT_EXPIRY_SECONDS) and were unkillable: clearing
 * the auth cookie deletes the browser's copy, but the token still verifies
 * until exp. This module is the durable kill switch, keyed two ways (one D1
 * table, migrations/d1_0007_session_revocations.sql):
 *
 *   jti:<token-id>  ONE specific token. signJwt stamps every new session with
 *                   a randomUUID jti; the verify path checks the list, so a
 *                   revoked token dies on its NEXT request. Legacy tokens
 *                   (pre-jti) carry no jti and are out of this key's reach.
 *   uuid:<identity> EVERY session for an identity (discordId or mcUuid) issued
 *                   BEFORE the revocation instant. Tokens signed after the
 *                   revoke have iat past the horizon and stay valid — this is
 *                   a forced logout, not a login ban. This key catches legacy
 *                   tokens too (the iat comparison does not need a jti).
 *
 * Availability posture (the rateLimitV2 convention): the check is BOUNDED
 * (~1.5s) and FAILS OPEN with a loud log when D1 is down — a revocation-list
 * blip must not sign the whole site out of a 7-day session fleet. The list is
 * defense in depth on top of the expiry; the expiry never blips.
 */
import { getD1 } from '../db/pool.js';
import { logger } from '../utils/logger.js';
import { JWT_EXPIRY_SECONDS, verifyJwt } from './jwt.js';

/* ── Schema (mirrors migrations/d1_0007_session_revocations.sql) ──────────── */

export const SESSION_REVOCATIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS session_revocations (
  revocation_key   TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('jti', 'uuid')),
  issued_before_ms INTEGER,
  expires_at_ms    INTEGER NOT NULL,
  revoked_by       TEXT,
  reason           TEXT,
  revoked_at_ms    INTEGER NOT NULL
)`;

const SCHEMA_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_sr_expires ON session_revocations (expires_at_ms)',
];

let schemaEnsured = false;
async function ensureSchema(): Promise<void> {
  if (schemaEnsured) return;
  const d1 = getD1();
  await d1.prepare(SESSION_REVOCATIONS_SCHEMA).run();
  for (const idx of SCHEMA_INDEXES) await d1.prepare(idx).run();
  schemaEnsured = true;
}

/** Test hook — the next ensureSchema runs for real again. */
export function __resetRevocationsForTests(): void {
  schemaEnsured = false;
}

/* ── Key shape ────────────────────────────────────────────────────────────── */

export function jtiKey(jti: string): string {
  return `jti:${jti}`;
}

/** identity = the session's discordId or mcUuid, whichever the token carries. */
export function uuidKey(identity: string): string {
  return `uuid:${identity}`;
}

/** Purge horizon for a row written now: past it, every token the row could
 *  reject is dead by its own 7-day exp. */
export const REVOCATION_TTL_MS = JWT_EXPIRY_SECONDS * 1000;
/** uuid rows revoke tokens with iat strictly before this horizon; the 5s
 *  forward skew absorbs same-second mint/revoke ordering (iat is seconds). */
const UUID_HORIZON_SKEW_MS = 5_000;

export interface RevokeResult {
  kind: 'jti' | 'uuid';
  /** The full revocation key as stored (audit + the frontend's echo). */
  key: string;
  /** uuid rows: tokens with iat (s) before this ms are revoked; null on jti. */
  issued_before_ms: number | null;
  /** Purge horizon (the row self-deletes after this; tokens are dead by exp). */
  expires_at_ms: number;
}

export interface RevokeOptions {
  revokedBy?: string;
  reason?: string;
}

/**
 * Revoke ONE token by its jti. Idempotent (INSERT OR IGNORE — the first
 * revocation of a key wins, a re-revoke is a no-op). Opportunistically purges
 * expired rows so the table stays bounded without a cron.
 */
export async function revokeSessionJti(
  jti: string,
  opts: RevokeOptions = {},
  now: number = Date.now(),
): Promise<RevokeResult> {
  await ensureSchema();
  const expiresAt = now + REVOCATION_TTL_MS;
  await getD1()
    .prepare(
      `INSERT INTO session_revocations
         (revocation_key, kind, issued_before_ms, expires_at_ms, revoked_by, reason, revoked_at_ms)
       VALUES (?, 'jti', NULL, ?, ?, ?, ?)
       ON CONFLICT (revocation_key) DO NOTHING`,
    )
    .bind(jtiKey(jti), expiresAt, opts.revokedBy ?? null, opts.reason ?? null, now)
    .run();
  await purgeExpiredRevocations(now);
  return { kind: 'jti', key: jtiKey(jti), issued_before_ms: null, expires_at_ms: expiresAt };
}

/**
 * Revoke EVERY outstanding session for an identity (discordId or mcUuid):
 * all tokens issued before now (+ a 5s skew for iat's second granularity)
 * die on their next request; logins AFTER the revoke mint fresh tokens past
 * the horizon and are unaffected.
 */
export async function revokeAllSessionsForIdentity(
  identity: string,
  opts: RevokeOptions = {},
  now: number = Date.now(),
): Promise<RevokeResult> {
  await ensureSchema();
  const issuedBefore = now + UUID_HORIZON_SKEW_MS;
  const expiresAt = now + REVOCATION_TTL_MS;
  await getD1()
    .prepare(
      `INSERT INTO session_revocations
         (revocation_key, kind, issued_before_ms, expires_at_ms, revoked_by, reason, revoked_at_ms)
       VALUES (?, 'uuid', ?, ?, ?, ?, ?)
       ON CONFLICT (revocation_key) DO NOTHING`,
    )
    .bind(uuidKey(identity), issuedBefore, expiresAt, opts.revokedBy ?? null, opts.reason ?? null, now)
    .run();
  await purgeExpiredRevocations(now);
  return { kind: 'uuid', key: uuidKey(identity), issued_before_ms: issuedBefore, expires_at_ms: expiresAt };
}

/**
 * Logout seam: revoke the session presented by a token. Only tokens carrying
 * a jti (any token signed since this deploy) are revocable individually — a
 * legacy token would need a uuid-ALL revoke, which would kill the user's
 * OTHER sessions and is far too aggressive for a logout. Returns the result
 * or null when the token is invalid or jti-less (cookie clearing remains the
 * legacy story; such a token dies at exp within 7 days of the deploy).
 * NEVER throws — a logout must not fail on a revocation blip.
 */
export async function revokeSessionByToken(
  token: string | undefined | null,
  opts: RevokeOptions = {},
  now: number = Date.now(),
): Promise<RevokeResult | null> {
  try {
    const payload = await verifyJwt(token);
    if (!payload?.jti) return null;
    return await revokeSessionJti(payload.jti, opts, now);
  } catch (err) {
    logger.error({ err: String(err) }, 'session revocations: logout revoke failed (logout still succeeds)');
    return null;
  }
}

/* ── The verify-path check ────────────────────────────────────────────────── */

/** Session payload slice the check needs (JwtPayload satisfies this). */
export interface RevocationCheckPayload {
  jti?: string;
  discordId?: string;
  mcUuid?: string;
  iat?: number;
}

/** A slow D1 must not stall every authenticated request — fail open past it. */
const CHECK_BUDGET_MS = 1_500;

/**
 * Is this session on the revocation list? TRUE = the request must be treated
 * as unauthenticated. Bounded and fail-open: any error or budget overrun
 * answers false (not revoked) and logs loudly — availability over limiting,
 * the rateLimitV2 convention. Never throws (the auth path calls this on
 * EVERY session request; a throw here would 500 the whole site).
 */
export async function isSessionRevoked(
  payload: RevocationCheckPayload,
  now: number = Date.now(),
): Promise<boolean> {
  const keys: string[] = [];
  if (payload.jti) keys.push(jtiKey(payload.jti));
  if (payload.discordId) keys.push(uuidKey(payload.discordId));
  if (payload.mcUuid && payload.mcUuid !== payload.discordId) keys.push(uuidKey(payload.mcUuid));
  if (keys.length === 0) return false;

  // The raced promise never rejects (everything is caught inside), so the
  // timeout loser cannot surface an unhandled rejection (the 1101 class).
  const check = (async (): Promise<boolean | null> => {
    try {
      await ensureSchema();
      const placeholders = keys.map(() => '?').join(', ');
      const rows = await getD1()
        .prepare(
          `SELECT kind, issued_before_ms, expires_at_ms
             FROM session_revocations
            WHERE revocation_key IN (${placeholders})`,
        )
        .bind(...keys)
        .all<{ kind: string; issued_before_ms: number | null; expires_at_ms: number }>();
      for (const row of rows.results ?? []) {
        if (Number(row.expires_at_ms) <= now) continue; // purge-lagging row; tokens dead by exp anyway
        if (row.kind === 'jti') return true;
        // uuid row: revoke only tokens ISSUED BEFORE the horizon. A token
        // with no iat cannot prove it is post-revoke — treat as revoked
        // (verifyJwt already rejects iat-less tokens; this is defense).
        if (typeof payload.iat !== 'number') return true;
        if (payload.iat * 1000 < Number(row.issued_before_ms ?? Number.MAX_SAFE_INTEGER)) return true;
      }
      return false;
    } catch (err) {
      logger.warn({ err: String(err) }, 'session revocations: check failed — failing open');
      return null; // unknown → not revoked (availability over limiting)
    }
  })();
  let handle: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    handle = setTimeout(() => resolve(null), CHECK_BUDGET_MS);
  });
  try {
    const answer = await Promise.race([check, deadline]);
    return answer === true;
  } finally {
    clearTimeout(handle); // a settled race must not leave a live timer on the isolate
  }
}

/**
 * DELETE rows whose purge horizon passed — every token they could reject is
 * dead by exp, so deletion cannot re-open a session. Best-effort (a failure
 * only costs table size, logged); called opportunistically from the revoke
 * writes.
 */
export async function purgeExpiredRevocations(now: number = Date.now()): Promise<number> {
  try {
    await ensureSchema();
    const res = await getD1()
      .prepare(`DELETE FROM session_revocations WHERE expires_at_ms <= ?`)
      .bind(now)
      .run();
    return Number(res.meta?.changes ?? 0);
  } catch (err) {
    logger.warn({ err: String(err) }, 'session revocations: purge failed');
    return 0;
  }
}
