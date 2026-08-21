/**
 * V6 02-04 — moderation history for the Discord staff commands. Bot-gated.
 *
 *   GET /api/v2/moderation/history?uuid=<mc uuid>
 *     → punishment rows from player_bans (the authoritative plugin record)
 *       newest-first, capped at 20.
 */
import { Hono } from 'hono';
import { query } from '../../db/pool.js';
import { botTokenMatches } from '../../middleware/auth.js';
import { readRateLimit } from '../../middleware/rateLimit.js';
import { logger } from '../../utils/logger.js';
import type { AppContextVariables } from '../../types/index.js';

type ApiEnv = { Variables: AppContextVariables };

export const moderationV2 = new Hono<ApiEnv>();

moderationV2.use('*', readRateLimit, async (c, next) => {
  if (!botTokenMatches(c)) return c.json({ error: 'Unauthorized' }, 401);
  await next();
});

moderationV2.get('/moderation/history', async (c) => {
  const uuid = (c.req.query('uuid') ?? '').trim();
  if (!/^[0-9a-fA-F-]{32,36}$/.test(uuid)) {
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
