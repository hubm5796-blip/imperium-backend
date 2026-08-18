// 12a expansion: personal player read endpoints —
//   GET /api/players/:uuid/codex   (lore chapter + enchant codex states, ETag)
//   GET /api/players/:uuid/fleet   (automata fleet + stats)
//   GET /api/dungeons/:id/stats    (personal clears/lockouts for one dungeon)
//
// Auth: personal data needs a session (plan doc), and the path uuid must be
// the caller's own linked account — a session may only read its own codex/
// fleet/dungeon stats. No caching for correctness; the codex (which changes
// rarely) gets an ETag so repeat dashboard loads are 304s.
import crypto from 'node:crypto';
import { Hono, type MiddlewareHandler } from 'hono';
import { requireAuth, requireLinked } from '../../middleware/auth.js';
import { readRateLimit } from '../../middleware/rateLimit.js';
import { query } from '../../db/pool.js';
import type { AppContextVariables } from '../../types/index.js';

type ApiEnv = { Variables: AppContextVariables };

export const playersApi = new Hono<ApiEnv>();

/** Matches the MC UUID forms accepted by mcUuidSchema (checked pre-parse for a clean 400). */
const UUID_PATTERN = /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/;


function normalizeUuid(raw: string): string {
  const hex = raw.replace(/-/g, '').toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Session gate for personal data: authenticated + linked, and the :uuid path
 * parameter must resolve to the caller's own Minecraft account. 403 (not 404)
 * on mismatch so probing other players' uuids yields a definite refusal.
 */
const selfOnly: MiddlewareHandler<ApiEnv> = async (c, next) => {
  const raw = c.req.param('uuid') ?? '';
  if (!UUID_PATTERN.test(raw)) {
    return c.json({ error: 'Invalid UUID parameter' }, 400);
  }
  if (normalizeUuid(raw) !== c.var.mcUuid) {
    return c.json({ error: 'You may only read your own data' }, 403);
  }
  await next();
};

// Note: middleware is applied per-route (not via .use('/:uuid/*')) — a wildcard
// use would also swallow /dungeons/:id/stats registered on the same sub-app
// (its first path segment binds to :uuid) and 400 it in selfOnly.

/* ------------------------------------------------------------ Codex */

interface CodexData {
  uuid: string;
  lore: {
    chapters: Array<{ chapterId: string; blockProgress: number }>;
  };
  enchants: {
    distinct: number;
    totalProcs: number;
    byEnchant: Array<{ enchantId: string; procs: number }>;
  };
}

/**
 * GET /api/players/:uuid/codex — lore chapter progress (player_story) and
 * per-enchant proc counts (enchant_stats). ETag'd: the dashboard polls this on
 * every profile view but the underlying data changes rarely, so repeat loads
 * with an unchanged codex are cheap 304s.
 */
playersApi.get('/:uuid/codex', requireAuth, requireLinked, selfOnly, readRateLimit, async (c) => {
  const uuid = normalizeUuid(c.req.param('uuid') ?? '');

  const data = await loadCodex(uuid);

  const etag = `"${crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0, 32)}"`;
  const ifNoneMatch = c.req.header('If-None-Match');
  if (ifNoneMatch) {
    const clientTags = ifNoneMatch.split(',').map((tag) => tag.trim());
    if (clientTags.includes(etag) || clientTags.includes(`W/${etag}`) || ifNoneMatch.trim() === '*') {
      return c.body(null, 304, { ETag: etag });
    }
  }
  // Personal data — explicitly not cacheable by shared caches.
  return c.json(data as unknown as Record<string, unknown>, 200, {
    ETag: etag,
    'Cache-Control': 'private, no-store',
  });
});

async function loadCodex(uuid: string): Promise<CodexData> {
  const lore = await query<{ chapter_id: string; block_progress: string }>(
    'SELECT chapter_id, block_progress::text FROM player_story WHERE uuid = $1 ORDER BY chapter_id',
    [uuid],
  );
  const enchants = await query<{ enchant_id: string; procs: string }>(
    'SELECT enchant_id, procs::text FROM enchant_stats WHERE uuid = $1 ORDER BY procs DESC, enchant_id',
    [uuid],
  );

  const byEnchant = enchants.rows.map((row) => ({
    enchantId: row.enchant_id,
    procs: Number(row.procs ?? 0),
  }));

  return {
    uuid,
    lore: {
      chapters: lore.rows.map((row) => ({
        chapterId: row.chapter_id,
        blockProgress: Number(row.block_progress ?? 0),
      })),
    },
    enchants: {
      distinct: byEnchant.length,
      totalProcs: byEnchant.reduce((sum, e) => sum + e.procs, 0),
      byEnchant,
    },
  };
}

/* ------------------------------------------------------------ Fleet */

/**
 * GET /api/players/:uuid/fleet — the caller's automata fleet from robot_data
 * (one row per (uuid, robot_type)), plus a summary. No cache (personal).
 */
playersApi.get('/:uuid/fleet', requireAuth, requireLinked, selfOnly, readRateLimit, async (c) => {
  const uuid = normalizeUuid(c.req.param('uuid') ?? '');
  const result = await query<{
    robot_type: string;
    count: string;
    level: string;
    active: boolean;
    last_collection: string;
    updated_at: Date;
  }>(
    `SELECT r.robot_type, r.count::text, r.level::text, r.active, r.last_collection::text, r.updated_at
       FROM robot_data r
      WHERE r.uuid = $1
      ORDER BY r.robot_type`,
    [uuid],
  );

  const robots = result.rows.map((row) => ({
    robotType: row.robot_type,
    count: Number(row.count ?? 0),
    level: Number(row.level ?? 0),
    active: Boolean(row.active),
    lastCollection: Number(row.last_collection ?? 0),
    updatedAt: row.updated_at,
  }));

  return c.json({
    uuid,
    robots,
    summary: {
      distinctTypes: robots.length,
      totalRobots: robots.reduce((sum, r) => sum + r.count, 0),
      activeTypes: robots.filter((r) => r.active).length,
      totalLevels: robots.reduce((sum, r) => sum + r.level, 0),
    },
  }, 200, { 'Cache-Control': 'private, no-store' });
});

/* ------------------------------------------------------ Dungeon stats */

/**
 * Own sub-app (NOT on playersApi): this route's path is /dungeons/:id/stats
 * with no :uuid segment, so it must be mounted at the expansion root, not
 * under /players.
 */
export const dungeonsApi = new Hono<ApiEnv>();

const DUNGEON_ID_PATTERN = /^[a-z0-9_-]{1,64}$/;

/**
 * GET /api/dungeons/:id/stats — the CALLING player's clears/lockouts for one
 * dungeon (session-auth; identity from the cookie, not the path). Reads the
 * plugin's player_dungeon_stats / dungeon_lockouts tables — until the plugin
 * creates them the endpoint degrades to a zero-state response with
 * available:false rather than erroring (matches the repo's degrade-gracefully
 * pattern for not-yet-existing tables).
 */
dungeonsApi.get('/:id/stats', requireAuth, requireLinked, readRateLimit, async (c) => {
  const dungeonId = (c.req.param('id') ?? '').toLowerCase();
  if (!DUNGEON_ID_PATTERN.test(dungeonId)) {
    return c.json({ error: 'Invalid dungeon id' }, 400);
  }
  const uuid = c.var.mcUuid!;

  let clears = 0;
  let bestTimeMs: number | null = null;
  let lastClearAt: Date | null = null;
  let lockedUntil: Date | null = null;
  let available = false;

  try {
    const stats = await query<{ total_clears: string; best_time_ms: string | null; last_clear_at: Date | null }>(
      `SELECT total_clears::text, best_time_ms::text, last_clear_at
         FROM player_dungeon_stats
        WHERE uuid = $1 AND dungeon_id = $2`,
      [uuid, dungeonId],
    );
    const row = stats.rows[0];
    if (row) {
      clears = Number(row.total_clears ?? 0);
      bestTimeMs = row.best_time_ms === null ? null : Number(row.best_time_ms);
      lastClearAt = row.last_clear_at;
    }
    const lockout = await query<{ locked_until: Date }>(
      `SELECT locked_until FROM dungeon_lockouts
        WHERE uuid = $1 AND dungeon_id = $2 AND locked_until > NOW()`,
      [uuid, dungeonId],
    );
    lockedUntil = lockout.rows[0]?.locked_until ?? null;
    available = true;
  } catch {
    // Tables not created yet (plugin-side) — serve zero-state.
  }

  return c.json({
    uuid,
    dungeonId,
    available,
    clears,
    bestTimeMs,
    lastClearAt,
    lockedUntil,
  }, 200, { 'Cache-Control': 'private, no-store' });
});
