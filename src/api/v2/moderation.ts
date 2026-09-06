/**
 * V6 02-04 — moderation history for the Discord staff commands. Bot-gated.
 *
 *   GET /api/v2/moderation/history?uuid=<mc uuid>
 *     → punishment rows from player_bans (the authoritative plugin record)
 *       newest-first, capped at 20.
 */
import { Hono } from 'hono';
import { query } from '../../db/pool.js';
import { requireStaffRole } from '../../middleware/gates.js';
import { parseMcUuid } from '../../middleware/gates.js';
import { readRateLimit } from '../../middleware/rateLimit.js';
import { logger } from '../../utils/logger.js';
import type { AppContextVariables } from '../../types/index.js';

type ApiEnv = { Variables: AppContextVariables };

export const moderationV2 = new Hono<ApiEnv>();

// B-19: punishment history is mod+ (the same doctrine as the v1 ledger).
moderationV2.use('/moderation*', readRateLimit, requireStaffRole('mod'));

moderationV2.get('/moderation/history', async (c) => {
  // B-54: canonical shape — dashed/undashed/any-case accepted + normalized
  // (the old length-range regex admitted 36 dashes as a "uuid").
  const uuid = parseMcUuid(c.req.query('uuid'));
  if (!uuid) {
    return c.json({ error: 'Invalid uuid' }, 400);
  }
  try {
    const rows = await query(
      `SELECT id::text, banned_by, reason, banned_at, expires_at, active
       FROM player_bans WHERE uuid = $1 ORDER BY id DESC LIMIT 20`,
      [uuid],
    );
    return c.json({ history: rows.rows });
  } catch (err) {
    logger.error({ err: String(err) }, 'v2 moderation history failed');
    return c.json({ error: 'History unavailable' }, 503);
  }
});
