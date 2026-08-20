// V6 05-01 — v2 leaderboards: the first envelope-native route.
//
// GET /api/v2/leaderboards/:board?limit=20&cursor=<opaque>
//   → { data: [{rank, uuid, username, value, secondary?}],
//       meta: { nextCursor: string | null } }
//
// Keyset cursor (encodeCursor/decodeCursor): stable across inserts, unlike
// the v1 top-N window. `rank` is derived within the page window (offset +
// index) — a global rank would reintroduce the instability cursors exist to
// avoid; consumers that need global position use the v1 board or the
// approxTotal hint later.
import { Hono } from 'hono';
import { getLeaderboardPage } from '../../db/pool.js';
import { readRateLimit } from '../../middleware/rateLimit.js';
import { decodeCursor, encodeCursor, fail, ok, parseLimit, unknownParams } from './respond.js';
import type { AppContextVariables } from '../../types/index.js';

type ApiEnv = { Variables: AppContextVariables };

export const leaderboardsV2 = new Hono<ApiEnv>();

const BOARDS = ['denarius', 'blocks', 'prestige', 'playtime'] as const;
type Board = (typeof BOARDS)[number];
const ALLOWED_PARAMS = new Set(['limit', 'cursor']);

leaderboardsV2.get('/leaderboards/:board', readRateLimit, async (c) => {
  const url = new URL(c.req.url);
  const offenders = unknownParams(url, ALLOWED_PARAMS);
  if (offenders.length > 0) {
    return fail(c, 400, 'UNKNOWN_PARAM', `Unknown query parameter(s): ${offenders.join(', ')}`, {
      allowed: [...ALLOWED_PARAMS],
    });
  }

  const boardParam = c.req.param('board') ?? '';
  if (!(BOARDS as readonly string[]).includes(boardParam)) {
    return fail(c, 404, 'NOT_FOUND', `Unknown board '${boardParam}'`, { allowed: BOARDS });
  }
  const board = boardParam as Board;

  const limit = parseLimit(c.req.query('limit'));
  const decoded = decodeCursor(c.req.query('cursor'));
  if (decoded === 'invalid') {
    return fail(c, 400, 'INVALID_CURSOR', 'cursor must be a base64url keyset token from meta.nextCursor');
  }

  try {
    const page = await getLeaderboardPage(board, limit, decoded);
    return ok(
      c,
      page.rows.map((r, i) => ({
        rank: i + 1,
        uuid: r.uuid,
        username: r.name ?? r.uuid,
        value: r.value,
        ...(r.secondary !== undefined ? { secondary: r.secondary } : {}),
      })),
      { nextCursor: page.nextCursor ? encodeCursor(page.nextCursor) : null },
    );
  } catch {
    return fail(c, 503, 'REGISTRY_UNAVAILABLE', 'Leaderboard source unavailable');
  }
});
