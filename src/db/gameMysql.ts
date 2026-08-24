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
 * Connection, two paths:
 *  - Node (dev/test): mysql2's own TCP pool. The birdflop MySQL allows remote
 *    connections (verified: the admin tooling connects from this machine) —
 *    this is also how the 2026-08-22 hybrid session "verified the connection",
 *    which is exactly why production breakage went unnoticed for a day.
 *  - Deployed Workers: mysql2 CANNOT open sockets there — its TCP layer rides
 *    node:net, whose workerd shim can't reach arbitrary hosts (the same wall
 *    worker.ts documents for Supabase TLS). Every gameQuery silently returned
 *    [] and the leaderboard served the stale Postgres mirror (22.3B
 *    pre-migration cents vs the real 241M whole units). Fix (2026-08-24):
 *    per-query connections through the minimal wire client (mysqlWire.ts)
 *    over a cloudflare:sockets TCP connection.
 *    No pool (each query opens one socket + handshake) — every gameQuery
 *    consumer sits behind SWR/D1 caches, so the query rate stays tiny.
 */
import mysql from 'mysql2/promise';
import { logger } from '../utils/logger.js';
import { env } from '../env.js';
import { wireQuery } from './mysqlWire.js';

let pool: mysql.Pool | null = null;
let poolConfig: {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
} | null = null;

export function initGamePool(config: {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}): void {
  if (pool) return;
  poolConfig = config;
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

// ── Workers transport (cloudflare:sockets → the eval-free wire client) ──────

type CfSocket = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  opened?: Promise<unknown>;
  close?: () => Promise<void>;
};
type CfConnect = (
  address: { hostname: string; port: number },
  options?: { secureTransport?: 'off' | 'starttls' | 'on' },
) => Promise<CfSocket>;

/** Resolved once per isolate: the connect() export when running under workerd,
 *  or null under Node (dynamic import of cloudflare:sockets fails there). */
let cfConnect: CfConnect | null | undefined;

async function resolveCfConnect(): Promise<CfConnect | null> {
  if (cfConnect !== undefined) return cfConnect;
  try {
    const mod = (await import('cloudflare:sockets')) as unknown as { connect: CfConnect };
    cfConnect = mod.connect;
  } catch {
    cfConnect = null;
  }
  return cfConnect;
}

/** In-flight worker-socket cap — polite to birdflop if a cache ever expires
 *  under load. Waiting acquires; release must run on both paths. */
let inFlight = 0;
const waiters: Array<() => void> = [];
async function acquireSlot(): Promise<void> {
  if (inFlight < 6) { inFlight++; return; }
  await new Promise<void>((resolve) => waiters.push(resolve));
  inFlight++;
}
function releaseSlot(): void {
  inFlight--;
  waiters.shift()?.();
}

async function workerQuery<T extends Record<string, unknown>>(
  sql: string,
  params: readonly unknown[],
  connect: CfConnect,
): Promise<T[]> {
  if (!poolConfig) throw new Error('Game MySQL pool not initialized — call initGamePool() first');
  await acquireSlot();
  try {
    return await wireQuery<T>(sql, params, poolConfig, connect);
  } finally {
    releaseSlot();
  }
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
    const connect = await resolveCfConnect();
    if (connect) {
      return await workerQuery<T>(sql, params, connect);
    }
    const [rows] = await getPool().execute(sql, params as never[]);
    return rows as T[];
  } catch (err) {
    const cause = err instanceof Error ? err.cause : undefined;
        logger.error(
      {
        err: String(err),
        stack: err instanceof Error ? err.stack : undefined,
        cause: cause ? String((cause as Error).stack ?? cause) : undefined,
        sql: sql.slice(0, 120),
      },
      'gameQuery failed',
    );
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
