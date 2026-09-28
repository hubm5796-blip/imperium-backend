/**
 * LICENSE ENDPOINTS (anti-piracy build 2026-09-26 + hardening addendum #5).
 *
 * Two surfaces, deliberately split by mount so their auth never bleeds:
 *
 *   GET /api/license/status?id=<licenseId>   (src/api/routes.ts — v1, PUBLIC read)
 *     → 200 { valid: boolean, revokedAt?: number, reason?: string }
 *     A license is valid unless a revocation row exists for its id OR the kill-all row
 *     ('__ALL__') exists — the key-rotation insurance: if the Ed25519 private key ever
 *     leaks, one revoke call bricks every jar in existence until we re-key + re-mint.
 *     Public because revocation status is not secret (the token itself is the secret-proof)
 *     and the plugin must be able to check it from a bare server with no auth ceremony;
 *     rate-limited like every other read.
 *
 *   POST /api/v2/admin/licenses/revoke        (app.ts — mounted BEFORE the v2 sub-app)
 *     Body: { id, reason?, confirm? }
 *     Requires INTERNAL_SERVICE_TOKEN (requireServiceToken — the dms.ts middleware). The
 *     id '__ALL__' additionally demands confirm:"KILL-ALL" so a fat-fingered curl cannot
 *     take the whole network down. Idempotent: re-revoking updates reason/revoked_at.
 *
 * D1 (CACHE_DB) table, ensured on demand with the same schema-ensure pattern as dm_queue:
 *   license_revocations (id TEXT PRIMARY KEY, revoked_at INTEGER NOT NULL, reason TEXT)
 */
import { Hono } from 'hono';
import { getD1 } from '../db/pool.js';
import { readRateLimit, writeRateLimit } from '../middleware/rateLimit.js';
import { requireServiceToken } from '../middleware/serviceToken.js';
import { logger } from '../utils/logger.js';
import type { AppContextVariables } from '../types/index.js';

type ApiEnv = { Variables: AppContextVariables };

/** The kill-all row id — revoking it marks EVERY license invalid. */
export const KILL_ALL_ID = '__ALL__';
/** Body confirmation demanded for the kill-all id only. */
const KILL_ALL_CONFIRM = 'KILL-ALL';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS license_revocations (
  id text primary key,
  revoked_at integer not null,
  reason text
)`;

async function ensureSchema(): Promise<void> {
  await getD1().prepare(SCHEMA).run();
}

// ── Public status read (mounted under /api) ────────────────────────────────────────────
export const licenseStatusApi = new Hono<ApiEnv>();

licenseStatusApi.get('/license/status', readRateLimit, async (c) => {
  const id = (c.req.query('id') ?? '').trim();
  if (!id || id.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(id)) {
    return c.json({ error: 'id query parameter required (license id, 1-128 chars)' }, 400);
  }

  try {
    await ensureSchema();
    // One row for this id + the kill-all row in a single round trip.
    const { results } = await getD1()
      .prepare('SELECT id, revoked_at, reason FROM license_revocations WHERE id = ? OR id = ?')
      .bind(id, KILL_ALL_ID)
      .all<{ id: string; revoked_at: number; reason: string | null }>();
    const rows = results ?? [];
    const own = rows.find((r) => r.id === id);
    const killAll = rows.find((r) => r.id === KILL_ALL_ID);
    const hit = own ?? killAll;
    if (!hit) {
      return c.json({ valid: true });
    }
    return c.json({
      valid: false,
      revokedAt: hit.revoked_at,
      reason: hit.reason ?? (killAll ? 'license network globally revoked (__ALL__)' : 'license revoked'),
      global: hit.id === KILL_ALL_ID,
    });
  } catch (err) {
    logger.error({ err: String(err), id }, 'license status read failed');
    // Fail CLOSED on a broken D1 read: an unreadable revocation table must not report
    // valid:true for a possibly-revoked license. The plugin treats non-200 as a network
    // error and applies its grace window — a stale-but-correct lean.
    return c.json({ error: 'License status unavailable' }, 503);
  }
});

// ── Admin revoke (mounted at /api/v2/admin/licenses) ───────────────────────────────────
export const licenseAdminApi = new Hono<ApiEnv>();

// Path-scoped middleware ONLY — a bare '*' here would gate the public status router above
// if they ever shared a mount point (the v2-mount scoping lesson from adminPanel.ts).
licenseAdminApi.use('*', readRateLimit, requireServiceToken);

licenseAdminApi.post('/revoke', writeRateLimit, async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const id = (typeof body.id === 'string' ? body.id : '').trim();
  const reason = typeof body.reason === 'string' ? body.reason.slice(0, 500) : null;

  if (!id || id.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(id)) {
    return c.json({ error: 'id is required (1-128 chars, [A-Za-z0-9_.:-])' }, 400);
  }
  // The kill switch demands an explicit confirmation so it cannot fire by accident.
  if (id === KILL_ALL_ID && body.confirm !== KILL_ALL_CONFIRM) {
    return c.json({ error: `Revoking '${KILL_ALL_ID}' requires confirm: "${KILL_ALL_CONFIRM}"` }, 400);
  }

  try {
    await ensureSchema();
    await getD1()
      .prepare(
        'INSERT INTO license_revocations (id, revoked_at, reason) VALUES (?, ?, ?) ' +
          'ON CONFLICT(id) DO UPDATE SET revoked_at = excluded.revoked_at, reason = excluded.reason',
      )
      .bind(id, Date.now(), reason)
      .run();
    logger.warn({ id, reason }, 'license revoked');
    return c.json({ revoked: true, id, global: id === KILL_ALL_ID });
  } catch (err) {
    logger.error({ err: String(err), id }, 'license revoke failed');
    return c.json({ error: 'Revoke failed' }, 500);
  }
});
