/**
 * GAME MYSQL READER (hybrid architecture, owner 2026-08-22):
 * Reads game data (profiles, balances, stats, transactions) directly from the
 * live birdflop MySQL — the same database the plugin writes to — in real-time.
 * No more 5-minute WebSync staleness: what the plugin writes is what the
 * website sees, immediately.
 *
 * Web-only data (guides, tickets, changelog, gallery) stays in Postgres/D1.
 * This module ONLY serves game-data reads.
 *
 * Connection: uses mysql2 with a small pool. The birdflop MySQL allows remote
 * connections (verified: the admin tooling connects from this machine).
 * For Workers, the connection goes through Hyperdrive's MySQL binding if
 * configured, or a direct TCP connection via cloudflare:sockets.
 */
import mysql from 'mysql2/promise';
import { logger } from '../utils/logger.js';
import { env } from '../env.js';

let pool: mysql.Pool | null = null;

export function initGamePool(config: {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}): void {
  if (pool) return;
  pool = mysql.createPool({
    ...config,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    connectTimeout: 10_000,
  });
  logger.info('Game MySQL pool initialized (real-time game data reads)');
}

function getPool(): mysql.Pool {
  if (!pool) {
    throw new Error('Game MySQL pool not initialized — call initGamePool() first');
  }
  return pool;
}

export async function closeGamePool(): Promise<void> {
  if (pool) { await pool.end(); pool = null; }
}

/**
 * Parameterized query on the game MySQL. Uses `?` placeholders (MySQL style).
 * Returns rows as an array (mysql2 convention), not { rows } (pg convention).
 */
export async function gameQuery<T extends Record<string, unknown>>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  try {
    const [rows] = await getPool().execute(sql, params as never[]);
    return rows as T[];
  } catch (err) {
    logger.error({ err: String(err), sql: sql.slice(0, 120) }, 'gameQuery failed');
    return [];
  }
}

// ── Game-data reads (previously went to Postgres with 5-min staleness) ─────

export interface GamePlayerProfile {
  uuid: string;
  username: string | null;
  rank_level: number;
  rank_name: string;
  rank_progress: number;
  prestige_level: number;
  blocks_mined: number;
  play_time: number;
  pvp_kills: number;
  pvp_deaths: number;
  pvp_trophies: number;
}

export async function getGamePlayerProfile(uuid: string): Promise<GamePlayerProfile | null> {
  const rows = await gameQuery<GamePlayerProfile & Record<string, unknown>>(
    `SELECT pn.username,
            pr.rank_level, pr.rank_name, pr.rank_progress,
            COALESCE(pd.prestige_level, 0) AS prestige_level,
            COALESCE(ps.blocks_mined, 0) AS blocks_mined,
            COALESCE(ps.play_time, 0) AS play_time,
            COALESCE(ps.pvp_kills, 0) AS pvp_kills,
            COALESCE(ps.pvp_deaths, 0) AS pvp_deaths,
            COALESCE(ps.pvp_trophies, 0) AS pvp_trophies
       FROM player_ranks pr
       LEFT JOIN player_names pn ON pr.uuid = pn.uuid
       LEFT JOIN prestige_data pd ON pr.uuid = pd.uuid
       LEFT JOIN player_stats ps ON pr.uuid = ps.uuid
      WHERE pr.uuid = ?
      LIMIT 1`,
    [uuid],
  );
  return rows[0] ?? null;
}

export async function getGamePlayerBalances(uuid: string): Promise<Array<{ currency: string; balance: string }>> {
  return gameQuery<{ currency: string; balance: string }>(
    'SELECT currency, balance FROM currency_balances WHERE uuid = ?',
    [uuid],
  );
}

export async function getGameRecentTransactions(uuid: string, limit = 20): Promise<Array<Record<string, unknown>>> {
  return gameQuery<Record<string, unknown>>(
    `SELECT currency, amount, reason, timestamp
       FROM economy_transactions
      WHERE uuid = ?
      ORDER BY timestamp DESC
      LIMIT ?`,
    [uuid, limit],
  );
}

export async function getGameLeaderboard(
  currency: string,
  limit: number,
): Promise<Array<{ uuid: string; balance: string; username: string | null }>> {
  return gameQuery<{ uuid: string; balance: string; username: string | null }>(
    `SELECT cb.uuid, cb.balance, pn.username
       FROM currency_balances cb
       LEFT JOIN player_names pn ON cb.uuid = pn.uuid
      WHERE cb.currency = ?
      ORDER BY CAST(cb.balance AS UNSIGNED) DESC
      LIMIT ?`,
    [currency, limit],
  );
}

export async function getGameBlocksLeaderboard(limit: number): Promise<Array<Record<string, unknown>>> {
  return gameQuery<Record<string, unknown>>(
    `SELECT ps.uuid, ps.blocks_mined, pn.username
       FROM player_stats ps
       LEFT JOIN player_names pn ON ps.uuid = pn.uuid
      ORDER BY ps.blocks_mined DESC
      LIMIT ?`,
    [limit],
  );
}

export async function getGamePlayerCount(): Promise<number> {
  const rows = await gameQuery<{ n: number }>('SELECT COUNT(*) AS n FROM player_names');
  return Number(rows[0]?.n ?? 0);
}
