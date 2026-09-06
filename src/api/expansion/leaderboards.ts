// 12a expansion: new leaderboard boards (rank / legion / colosseum)
// behind GET /api/leaderboards/:board. The route itself lives in routes.ts
// (registered there since before the expansion); this module owns the queries
// and response shapes for the new boards.
//
// Data sources:
//  - rank:   player_ranks (game MySQL live — the plugin creates/updates it there;
//            Postgres mirror kept as fallback)
//  - legion: legions + legion_members (game MySQL live, same tables the plugin owns;
//            Postgres mirror kept as fallback)
//  - colosseum: leaderboard_stats, the plugin's generic leaderboard
//    table, under category COLOSSEUM_POINTS (Postgres — web-data surface).
import { gameQuery, GameMySqlUnavailableError } from '../../db/gameMysql.js';
import { query } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';

/**
 * B-11: gameQuery THROWS on outage (it used to swallow failures into [], so a
 * dead game DB was indistinguishable from "no rows" and the Postgres fallback
 * below never engaged). Every game-first board wraps the read in this guard:
 * outage → distinct-tag log → explicit fall-through to the Postgres mirror.
 * The mirror may itself be stale, but it is now a CHOSEN degradation, and the
 * log says which database answered.
 */
async function gameRowsOrFallback<T extends Record<string, unknown>>(
  board: string,
  sql: string,
  params: readonly unknown[],
): Promise<T[]> {
  try {
    return await gameQuery<T>(sql, params);
  } catch (err) {
    if (err instanceof GameMySqlUnavailableError) {
      logger.warn({ board, err: err.message }, '[game-mysql] board read failed — falling back to the Postgres mirror');
      return [];
    }
    throw err;
  }
}

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
  /** Legion XP — whole units, exactly as stored. Never a civitas proxy. */
  xp: number;
  members: number;
  /**
   * OWNER DIRECTIVE: the legion board ranks by CIVITAS — the summed whole-unit
   * civitas balances of each legion's members (currency_balances WHOLE-UNIT
   * STORAGE per publicProfiles.ts: no ÷100 anywhere — B-37 killed the game
   * path's /100). Both DB paths compute the identical subquery so the board
   * answers with the SAME order and magnitude whichever database serves it.
   */
  value: number;
}

/** Fetch one of the four expansion boards. Throws on DB failure (caller decides fallback). */
export async function fetchExpansionBoard(
  board: ExpansionBoard,
  limit: number,
): Promise<{ entries: unknown[] }> {
  const cap = Math.min(Math.max(limit, 1), 100);

  if (board === 'rank') {
    // GAME MYSQL FIRST (2026-08-25): the plugin's live player_ranks. On outage
    // (GameMySqlUnavailableError) gameRowsOrFallback returns [] — the Postgres
    // mirror below is the fallback (B-11).
    const gameRows = await gameRowsOrFallback<{
      uuid: string;
      rank_level: string | number;
      rank_name: string;
      rank_progress: string | number;
      username: string | null;
    }>(
      'rank',
      `SELECT pr.uuid, pr.rank_level, pr.rank_name, pr.rank_progress, pn.username
         FROM player_ranks pr
         LEFT JOIN player_names pn ON pr.uuid = pn.uuid
        ORDER BY pr.rank_level DESC, pr.rank_progress DESC
        LIMIT ?`,
      [cap],
    );
    if (gameRows.length > 0) {
      return {
        entries: gameRows.map((row, i) => ({
          rank: i + 1,
          uuid: row.uuid,
          username: row.username ?? row.uuid,
          value: Number(row.rank_level ?? 0),
          secondary: Number(row.rank_progress ?? 0),
          rankName: row.rank_name,
        })),
      };
    }
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
    // GAME MYSQL FIRST (2026-08-25): legions/legion_members are plugin-owned tables in
    // the game DB. OWNER DIRECTIVE: legion top ranks by CIVITAS — the summed civitas
    // balances of each legion's members — NOT by XP. `value` carries the civitas
    // total (whole units — WHOLE-UNIT STORAGE, no ÷100 per the repo rule;
    // B-37 removed the old /100 that made the game path 100x smaller than the
    // fallback), and BOTH paths run the identical civitas subquery so the
    // board has ONE ranking key and ONE unit path whichever DB answers (the
    // fallback used to order by raw l.xp — different order per database).
    const gameRows = await gameRowsOrFallback<{
      name: string;
      display_name: string | null;
      level: string | number;
      xp: string | number;
      civitas: string | number;
      members: string | number;
    }>(
      'legion',
      `SELECT l.name, l.display_name, l.level, l.xp,
              (SELECT COUNT(*) FROM legion_members m WHERE m.legion_name = l.name) AS members,
              COALESCE((SELECT SUM(CAST(cb.balance AS UNSIGNED)) FROM legion_members m2
                 JOIN currency_balances cb ON cb.uuid = m2.player_uuid AND cb.currency = 'civitas'
                WHERE m2.legion_name = l.name), 0) AS civitas
         FROM legions l
        ORDER BY civitas DESC, l.xp DESC, l.level DESC
        LIMIT ?`,
      [cap],
    );
    if (gameRows.length > 0) {
      const entries: LegionBoardEntry[] = gameRows.map((row, i) => ({
        rank: i + 1,
        name: row.name,
        displayName: row.display_name,
        level: Number(row.level ?? 1),
        xp: Number(row.xp ?? 0),
        members: Number(row.members ?? 0),
        value: Number(row.civitas ?? 0),
      }));
      return { entries };
    }
    const result = await query<{
      name: string;
      display_name: string | null;
      level: string;
      xp: string;
      civitas: string;
      members: string;
    }>(
      `SELECT l.name, l.display_name, l.level::text, l.xp::text,
              (SELECT COUNT(*) FROM legion_members m WHERE m.legion_name = l.name)::text AS members,
              COALESCE((SELECT SUM(cb.balance) FROM legion_members m2
                 JOIN currency_balances cb ON cb.uuid = m2.player_uuid AND cb.currency = 'civitas'
                WHERE m2.legion_name = l.name), 0)::text AS civitas
         FROM legions l
        ORDER BY civitas DESC, l.xp DESC, l.level DESC
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
      value: Number(row.civitas ?? 0),
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
