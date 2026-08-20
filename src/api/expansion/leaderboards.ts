// 12a expansion: new leaderboard boards (rank / legion / colosseum)
// behind GET /api/leaderboards/:board. The route itself lives in routes.ts
// (registered there since before the expansion); this module owns the queries
// and response shapes for the new boards.
//
// Data sources:
//  - rank:   player_ranks (live table, updated by the plugin)
//  - legion: legions + legion_members (live tables)
//  - colosseum: leaderboard_stats, the plugin's generic leaderboard
//    table, under categories KOTH_WINS / COLOSSEUM_POINTS. The plugin must
//    record these categories for the boards to return live data (documented
//    in docs/api.md); until then the boards serve empty entries.
import { query } from '../../db/pool.js';

// KOTH board removed 2026-08-20 — the plugin feature is deleted (owner directive); the board
// served a category nothing writes anymore.
export const EXPANSION_BOARDS = ['rank', 'legion', 'colosseum'] as const;
export type ExpansionBoard = (typeof EXPANSION_BOARDS)[number];

export function isExpansionBoard(value: string): value is ExpansionBoard {
  return (EXPANSION_BOARDS as readonly string[]).includes(value);
}

/** leaderboard_stats categories exposed as public boards (allowlist — arbitrary categories stay private). */
const LEADERBOARD_CATEGORY_BY_BOARD: Record<'colosseum', string> = {
  colosseum: 'COLOSSEUM_POINTS',
};

export interface LeaderboardEntryBase {
  rank: number;
  uuid?: string;
  username?: string | null;
  value?: number;
  secondary?: number;
}

export interface LegionBoardEntry {
  rank: number;
  name: string;
  displayName: string | null;
  level: number;
  xp: number;
  members: number;
}

/** Fetch one of the four expansion boards. Throws on DB failure (caller decides fallback). */
export async function fetchExpansionBoard(
  board: ExpansionBoard,
  limit: number,
): Promise<{ entries: unknown[] }> {
  const cap = Math.min(Math.max(limit, 1), 100);

  if (board === 'rank') {
    const result = await query<{
      uuid: string;
      rank_level: string;
      rank_name: string;
      rank_progress: string;
      username: string | null;
    }>(
      `SELECT pr.uuid, pr.rank_level::text, pr.rank_name, pr.rank_progress::text, pn.username
         FROM player_ranks pr
         LEFT JOIN player_names pn ON pr.uuid = pn.uuid
        ORDER BY pr.rank_level DESC, pr.rank_progress DESC
        LIMIT $1`,
      [cap],
    );
    return {
      entries: result.rows.map((row, i) => ({
        rank: i + 1,
        uuid: row.uuid,
        username: row.username ?? row.uuid,
        value: Number(row.rank_level ?? 0),
        secondary: Number(row.rank_progress ?? 0),
        rankName: row.rank_name,
      })),
    };
  }

  if (board === 'legion') {
    const result = await query<{
      name: string;
      display_name: string | null;
      level: string;
      xp: string;
      members: string;
    }>(
      `SELECT l.name, l.display_name, l.level::text, l.xp::text,
              (SELECT COUNT(*) FROM legion_members m WHERE m.legion_name = l.name)::text AS members
         FROM legions l
        ORDER BY l.xp DESC, l.level DESC
        LIMIT $1`,
      [cap],
    );
    const entries: LegionBoardEntry[] = result.rows.map((row, i) => ({
      rank: i + 1,
      name: row.name,
      displayName: row.display_name,
      level: Number(row.level ?? 1),
      xp: Number(row.xp ?? 0),
      members: Number(row.members ?? 0),
    }));
    return { entries };
  }

  // koth / colosseum — generic leaderboard_stats bridge.
  const category = LEADERBOARD_CATEGORY_BY_BOARD[board];
  const result = await query<{ uuid: string; player_name: string | null; total: string }>(
    `SELECT s.uuid, s.player_name, SUM(s.value)::text AS total
       FROM leaderboard_stats s
      WHERE s.category = $1 AND s.period = 'ALL_TIME'
      GROUP BY s.uuid, s.player_name
      ORDER BY SUM(s.value) DESC
      LIMIT $2`,
    [category, cap],
  );
  return {
    entries: result.rows.map((row, i) => ({
      rank: i + 1,
      uuid: row.uuid,
      username: row.player_name ?? row.uuid,
      value: Number(row.total ?? 0),
    })),
  };
}
