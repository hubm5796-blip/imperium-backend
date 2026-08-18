// 12c expansion: the Discord worker's backend surface —
//   POST /api/lfg/posts      (worker → plugin LFG board, bot-token auth)
//   GET  /api/bounties/top   (public bounty board, plugin Phase 9c table)
//   GET  /api/events/feed    (plugin → worker personal-event feed, bot-token)
//   GET  /api/vote/status    (pending vote rewards for a player, session/bot)
//
// Direction matters here:
//  - lfg_posts: the WORKER writes, the PLUGIN polls (web_queue inverted —
//    the row is not HMAC-signed because it grants nothing; the plugin treats
//    it as a display-only board entry and rate/volume-limits it by design).
//  - web_events: the PLUGIN writes (notifications producer), the worker polls
//    /api/events/feed every minute with ?since=.
//  - pvp_bounty_board is a LIVE plugin table (BountyBoardService, Phase 9c);
//    /api/bounties/top is a read-only public aggregate of OPEN bounties.
//
// Every not-yet-existing table degrades per-section like the seasons endpoint
// (see docs/api.md for the schemas the plugin side is expected to create).
import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { botTokenMatches } from '../../middleware/auth.js';
import { readRateLimit, writeRateLimit } from '../../middleware/rateLimit.js';
import { query } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { swrJson } from './cache.js';
import { lfgPostSchema, mcUuidSchema } from './schemas.js';
import type { AppContextVariables } from '../../types/index.js';

type ApiEnv = { Variables: AppContextVariables };

export const communityApi = new Hono<ApiEnv>();

/** 400 hook matching the repo's {error} shape for Zod failures. */
const validationHook = (result: { success: boolean }, c: Context) => {
  if (!result.success) {
    return c.json({ error: 'Validation failed' }, 400);
  }
};

/** Guard for machine-to-machine endpoints (Discord worker / edge proxies). */
function requireBot(c: Context): boolean {
  return botTokenMatches(c);
}

/** LFG posts live 15 minutes in-game (LfgService expiry) — mirror that TTL. */
const LFG_TTL_MINUTES = 15;

/* ------------------------------------------------------------------ LFG */

/**
 * POST /api/lfg/posts — the Discord bot's /lfg command lands here. The
 * backend inserts one row into `lfg_posts`; the plugin's poller picks it up
 * (~every few seconds), shows it on the in-game LFG board under the linked
 * Minecraft username, fires its LfgPostCreatedEvent, and marks the row
 * delivered. The backend never talks to the game directly.
 */
communityApi.post('/lfg/posts', writeRateLimit, zValidator('json', lfgPostSchema, validationHook), async (c) => {
  if (!requireBot(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const body = c.req.valid('json');

  const expires = new Date(Date.now() + LFG_TTL_MINUTES * 60_000);
  try {
    const result = await query<{ id: number | string }>(
      `INSERT INTO lfg_posts (dungeon_id, note, discord_id, username, created_at, expires_at, delivered_at)
       VALUES ($1, $2, $3, $4, NOW(), $5, NULL)
       RETURNING id`,
      [body.dungeon, body.note ?? null, body.discordId, body.username, expires.toISOString()],
    );
    const postId = String(result.rows[0]?.id ?? '');
    return c.json({ ok: true, postId, expiresAt: expires.toISOString() }, 202);
  } catch (err) {
    logger.error({ err, dungeon: body.dungeon }, 'lfg post insert failed');
    return c.json({ error: 'LFG board unavailable — try again shortly' }, 503);
  }
});

/* --------------------------------------------------------------- Bounties */

/**
 * GET /api/bounties/top — public top of the Phase 9c pooled bounty board:
 * OPEN rows grouped by target, pool total + placer count, names resolved
 * through player_names. SWR-cached 60s like the other public boards.
 * `state` allowlist = 'OPEN' only; claimed/voided pools never leak.
 */
communityApi.get('/bounties/top', readRateLimit, async (c) => {
  const limitRaw = Number.parseInt(c.req.query('limit') ?? '10', 10);
  const limit = Math.min(Math.max(Number.isNaN(limitRaw) ? 10 : limitRaw, 1), 25);
  try {
    return await swrJson(c, `bounties:top:${limit}:v1`, async () => {
      let rows: Array<{ target_uuid: string; pool: string; placers: string; username: string | null }>;
      try {
        const result = await query<{ target_uuid: string; pool: string; placers: string; username: string | null }>(
          `SELECT b.target_uuid, SUM(b.amount)::text AS pool,
                  COUNT(DISTINCT b.placer_uuid)::text AS placers,
                  pn.username
             FROM pvp_bounty_board b
             LEFT JOIN player_names pn ON pn.uuid = b.target_uuid
            WHERE b.state = 'OPEN'
            GROUP BY b.target_uuid, pn.username
            ORDER BY SUM(b.amount) DESC
            LIMIT $1`,
          [limit],
        );
        rows = result.rows;
      } catch (err) {
        // Plugin table not created yet (Phase 9c not live on this deployment).
        logger.warn({ err }, 'pvp_bounty_board unavailable — serving empty bounty board');
        return { available: false, entries: [] };
      }
      return {
        available: true,
        entries: rows.map((row, i) => ({
          rank: i + 1,
          target: row.username ?? row.target_uuid,
          amount: Number(row.pool ?? 0),
          placers: Number(row.placers ?? 0),
        })),
      };
    });
  } catch (err) {
    logger.error({ err }, 'bounties/top failed');
    return c.json({ error: 'Database unavailable' }, 503);
  }
});

/* ------------------------------------------------------------ Events feed */

const FEED_EVENT_TYPES = new Set(['contract_fulfilled', 'war_result', 'season_milestone']);

/**
 * GET /api/events/feed?since=ISO — the personal-events feed the worker's
 * notification cron polls (opt-in DMs: contract fulfilled / war result /
 * season milestone). Bot-token gated: this is server-to-server data carrying
 * player identifiers, not a public timeline. `since` is bounded to the last
 * hour so a stuck caller can't force an unbounded scan.
 */
communityApi.get('/events/feed', readRateLimit, async (c) => {
  if (!requireBot(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const sinceRaw = c.req.query('since') ?? '';
  const sinceMs = Date.parse(sinceRaw);
  if (Number.isNaN(sinceMs)) {
    return c.json({ error: "since must be an ISO 8601 timestamp" }, 400);
  }
  const minSince = Date.now() - 60 * 60_000;
  const since = new Date(Math.max(sinceMs, minSince)).toISOString();

  try {
    let rows: Array<{ id: number | string; event_type: string; uuid: string; message: string; at: Date }>;
    try {
      const result = await query<{ id: number | string; event_type: string; uuid: string; message: string; at: Date }>(
        `SELECT id, event_type, uuid, message, at
           FROM web_events
          WHERE at > $1
          ORDER BY at DESC
          LIMIT 200`,
        [since],
      );
      rows = result.rows;
    } catch (err) {
      // The plugin's events producer hasn't landed yet — degrade to an empty
      // feed (the worker treats "no events" as a no-op sweep, not an error).
      logger.warn({ err }, 'web_events unavailable — serving empty feed');
      return c.json({ available: false, events: [] });
    }
    return c.json({
      available: true,
      events: rows
        .filter((row) => FEED_EVENT_TYPES.has(row.event_type))
        .map((row) => ({
          id: String(row.id),
          type: row.event_type,
          uuid: row.uuid,
          message: row.message,
          at: row.at,
        })),
    });
  } catch (err) {
    logger.error({ err }, 'events/feed failed');
    return c.json({ error: 'Database unavailable' }, 503);
  }
});

/* ------------------------------------------------------------ Vote status */

/**
 * GET /api/vote/status?uuid= — pending vote rewards for one player: web_queue
 * rows with kind='vote' still in `pending` (queued by POST /api/vote/:site,
 * granted in-game by the plugin's queue consumer). The lifetime total counts
 * vote_claims when that plugin table exists.
 *
 * Auth: a linked session may read its OWN status (uuid omitted or matching);
 * the bot token may target any uuid (the frontend's edge proxy path).
 */
communityApi.get('/vote/status', readRateLimit, async (c) => {
  const queryUuid = c.req.param('uuid') ?? c.req.query('uuid') ?? '';
  let uuid: string | null = null;
  if (queryUuid) {
    const parsed = mcUuidSchema.safeParse(queryUuid);
    if (!parsed.success) {
      return c.json({ error: 'Invalid uuid parameter' }, 400);
    }
    uuid = parsed.data;
  }

  if (uuid) {
    // Targeted read: bot only (same rule as /api/player/profile).
    if (!requireBot(c)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
  } else {
    if (!c.var.user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (!c.var.mcUuid) {
      return c.json({ error: 'Minecraft account not linked', linkRequired: true }, 403);
    }
    uuid = c.var.mcUuid;
  }

  let pending: Array<{ site: string; queuedAt: Date }> = [];
  let available = false;
  try {
    const result = await query<{ site: string; created_at: Date }>(
      `SELECT site, created_at FROM web_queue
        WHERE kind = 'vote' AND status = 'pending' AND uuid = $1
        ORDER BY id DESC
        LIMIT 25`,
      [uuid],
    );
    pending = result.rows.map((row) => ({ site: row.site ?? 'unknown', queuedAt: row.created_at }));
    available = true;
  } catch (err) {
    logger.warn({ err }, 'web_queue unavailable — serving empty vote status');
  }

  let totalVotes: number | null = null;
  if (available) {
    try {
      const total = await query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM vote_claims WHERE uuid = $1',
        [uuid],
      );
      totalVotes = Number(total.rows[0]?.count ?? 0);
    } catch {
      // vote_claims not created yet — lifetime total stays absent.
    }
  }

  return c.json(
    { uuid, available, pending, ...(totalVotes !== null ? { totalVotes } : {}) },
    200,
    { 'Cache-Control': 'private, no-store' },
  );
});
