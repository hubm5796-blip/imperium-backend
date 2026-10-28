/**
 * S2-D04 (backend half) + S2-E04 (backend half) — the session revocation
 * surface. Sessions are 7-day JWTs; until this route existed, "log this
 * person out everywhere" had no answer (clearing a cookie kills one browser's
 * copy, the token itself verified until exp).
 *
 * CONTRACT FOR LANE E (S2-E04 frontend half — surfacing the forced logout):
 *
 *   POST /api/v2/admin/sessions/revoke        (admin rank, S2-D01 RBAC)
 *     body (exactly one of):
 *       { "jti":  "<token id>" }              kill ONE session token
 *       { "uuid": "<mc-uuid | discord-id>" }  kill EVERY session that identity
 *                                             holds, i.e. all tokens issued
 *                                             before the revoke; logins after
 *                                             it are NOT blocked
 *     200 → { ok: true, revoked: { kind, key, issued_before, expires_at } }
 *     400 → bad/ambiguous body; 401/403 → not admin.
 *
 *   Detection is pull, not push — there is no push channel to the browser.
 *   A revoked session dies at its NEXT request: every authenticated request
 *   runs attachUser → isSessionRevoked, and a revoked cookie answers 401 on
 *   routes that require auth. The frontend should treat a sudden 401 on a
 *   previously-working session as "signed out (possibly forced)", clear local
 *   state and route to login — the S2-E04 banner copy is the owner's call.
 *
 *   jti values are on every token signed since the revocation deploy (signJwt
 *   stamps randomUUID); the frontend can read its own token's jti only by
 *   decoding the cookie payload (httpOnly — normally the BACKEND revokes via
 *   uuid, e.g. from the player admin view; { jti } exists for targeted ops).
 *
 * Gated by the S2-D01 fail-closed RBAC at admin rank — killing sessions is a
 * moderation-grade action.
 */
import { Hono } from 'hono';
import {
  revokeAllSessionsForIdentity,
  revokeSessionJti,
  type RevokeResult,
} from '../../auth/sessionRevocations.js';
import { recordAction } from '../../db/actionLog.js';
import { resolveAuditActor } from '../../utils/auditActor.js';
import { requireStaffRole } from '../../middleware/gates.js';
import { writeRateLimit } from '../../middleware/rateLimit.js';
import { logger } from '../../utils/logger.js';
import type { AppContextVariables } from '../../types/index.js';

type ApiEnv = { Variables: AppContextVariables };

export const sessionsV2 = new Hono<ApiEnv>();

/** jti: the shapes signJwt mints (randomUUID, hyphens or stripped). */
const JTI_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** uuid: dashed/undashed MC UUID, or a Discord snowflake. */
const MC_UUID_RE = /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/;
const DISCORD_ID_RE = /^\d{15,20}$/;

function shapeForTests(r: RevokeResult): {
  kind: string;
  key: string;
  issued_before: string | null;
  expires_at: string;
} {
  return {
    kind: r.kind,
    key: r.key,
    issued_before: r.issued_before_ms === null ? null : new Date(r.issued_before_ms).toISOString(),
    expires_at: new Date(r.expires_at_ms).toISOString(),
  };
}

sessionsV2.post('/admin/sessions/revoke', writeRateLimit, requireStaffRole('admin'), async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return c.json({ error: 'Expected a JSON object' }, 400);
  }
  const b = body as { jti?: unknown; uuid?: unknown; reason?: unknown };
  const jti = typeof b.jti === 'string' ? b.jti.trim() : undefined;
  const uuid = typeof b.uuid === 'string' ? b.uuid.trim() : undefined;

  if (jti !== undefined && uuid !== undefined) {
    return c.json({ error: 'Pass exactly one of: jti (one session) or uuid (all sessions for that identity)' }, 400);
  }
  if (jti === undefined && uuid === undefined) {
    return c.json(
      { error: 'Missing target: pass { jti } to revoke one session or { uuid } to revoke all sessions for an identity' },
      400,
    );
  }
  if (jti !== undefined && !JTI_RE.test(jti)) {
    return c.json({ error: "Invalid 'jti' (8..64 chars of [A-Za-z0-9_-])" }, 400);
  }
  if (uuid !== undefined && !MC_UUID_RE.test(uuid) && !DISCORD_ID_RE.test(uuid)) {
    return c.json({ error: "Invalid 'uuid' (MC UUID or Discord id)" }, 400);
  }
  // Optional audit context — free text; recordAction clips it hard.
  const reason = typeof b.reason === 'string' ? b.reason : undefined;

  const now = Date.now();
  try {
    const result =
      jti !== undefined
        ? await revokeSessionJti(jti, { revokedBy: (c.var.staffActor?.name ?? 'admin').slice(0, 80), reason }, now)
        : await revokeAllSessionsForIdentity(
            uuid as string,
            { revokedBy: (c.var.staffActor?.name ?? 'admin').slice(0, 80), reason },
            now,
          );
    // Attributed audit row (never blocks the response — recordAction swallows
    // its own failures; resolveAuditActor is wrapped so a hiccup cannot 500 a
    // completed revocation).
    try {
      await recordAction({
        actor: await resolveAuditActor(c),
        // ACTION_RE is strictly two-segment (admin.punish, ticket.note) —
        // 'session.revoke' fits the closed shape; a three-segment name is
        // silently dropped and the audit row would never land.
        action: 'session.revoke',
        target: result.key.slice(0, 120),
        detail: `kind=${result.kind}${reason ? '; reason=' + reason.slice(0, 200) : ''}`,
      });
    } catch (err) {
      logger.warn({ err: String(err) }, 'session revoke: audit row skipped');
    }
    return c.json({
      ok: true,
      revoked: shapeForTests(result),
      // The operator-facing semantics, spelled out (E04 renders these):
      effect:
        result.kind === 'uuid'
          ? 'Every session this identity held before the revoke is rejected on its next request. New logins are not blocked.'
          : 'This exact session token is rejected on its next request.',
    });
  } catch (err) {
    logger.error({ err: String(err) }, 'admin sessions/revoke: D1 write failed');
    return c.json({ error: 'Revocation store unavailable' }, 503);
  }
});
