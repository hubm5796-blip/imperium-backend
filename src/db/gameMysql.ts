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
 * Typed failure for every game-MySQL outage (transport, auth, schema, syntax).
 *
 * B-11: gameQuery used to swallow EVERY failure into `[]`, which callers
 * cannot distinguish from a valid empty result — the leaderboard served a
 * frozen mirror, /store/subscription served `subscription: null`, and this
 * repo's own schema drift (legion_members queried with wrong column names)
 * errored on every call with nobody able to tell. Now gameQuery THROWS this
 * type; every call site degrades explicitly (Postgres fallback where one
 * exists, an `available:false`/degraded signal where it doesn't).
 */
export class GameMySqlUnavailableError extends Error {
  constructor(
    message: string,
    /** The underlying transport/protocol error, for callers that log cause. */
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'GameMySqlUnavailableError';
  }
}

/**
 * Parameterized query on the game MySQL. Uses `?` placeholders (MySQL style).
 * Returns rows as an array (mysql2 convention), not { rows } (pg convention).
 *
 * THROWS GameMySqlUnavailableError on any failure — an empty array is always
 * a real (valid) empty result, never a swallowed outage (B-11).
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
    // Distinct tag so game-MySQL outages are greppable apart from Postgres
    // failures — the swallow-all previously made these invisible.
    logger.error(
      {
        err: String(err),
        stack: err instanceof Error ? err.stack : undefined,
        cause: cause ? String((cause as Error).stack ?? cause) : undefined,
        sql: sql.slice(0, 120),
      },
      '[game-mysql] gameQuery failed — throwing GameMySqlUnavailableError to the caller',
    );
    throw new GameMySqlUnavailableError(`game-mysql unavailable: ${String(err)}`, err);
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

// ── Dashboard player-data functions (2026-08-30) ─────────────────────────
// These mirror the Postgres pool.ts shapes so the API routes can use
// game MySQL (real-time) with Postgres as fallback.

export async function getGamePlayerStats(uuid: string): Promise<{ blocks_mined: number; play_time: number; pvp_kills: number; pvp_deaths: number; pvp_trophies: number } | null> {
  const rows = await gameQuery<{ blocks_mined: number; play_time: number; pvp_kills: number; pvp_deaths: number; pvp_trophies: number }>(
    `SELECT ps.blocks_mined,
            COALESCE(pl.total_secs, 0) AS play_time,
            ps.pvp_kills, ps.pvp_deaths, ps.pvp_trophies
       FROM player_stats ps
       LEFT JOIN player_playtime pl ON pl.uuid = ps.uuid
      WHERE ps.uuid = ?
      LIMIT 1`,
    [uuid],
  );
  return rows[0] ?? null;
}

export async function getGamePlayerAchievements(uuid: string): Promise<Array<{ achievement_id: string; progress: number; completed: boolean; claimed: boolean }>> {
  return gameQuery(
    'SELECT achievement_id, progress, completed, claimed FROM player_achievements WHERE uuid = ?',
    [uuid],
  );
}

export async function getGamePlayerSkills(uuid: string): Promise<Array<{ branch: string; node_id: string }>> {
  return gameQuery(
    'SELECT branch, node_id FROM player_skills WHERE uuid = ? ORDER BY branch, node_id',
    [uuid],
  );
}

export async function getGamePlayerRankAndPrestige(uuid: string): Promise<{ rank_level: number; prestige_level: number }> {
  const rows = await gameQuery<{ rank_level: number; prestige_level: number }>(
    `SELECT pr.rank_level, COALESCE(pd.prestige_level, 0) AS prestige_level
       FROM player_ranks pr
       LEFT JOIN prestige_data pd ON pr.uuid = pd.uuid
      WHERE pr.uuid = ? LIMIT 1`,
    [uuid],
  );
  return rows[0] ?? { rank_level: 0, prestige_level: 0 };
}

export async function getGamePlayerFactions(uuid: string): Promise<Array<{ faction_id: string; reputation: number }>> {
  return gameQuery(
    'SELECT faction_id, reputation FROM player_faction_rep WHERE uuid = ? ORDER BY reputation DESC',
    [uuid],
  );
}

export async function getGameParkourRecords(uuid: string): Promise<Array<{ course_id: string; best_time_ms: number; completions: number }>> {
  return gameQuery(
    'SELECT course_id, best_time_ms, completions FROM parkour_records WHERE player_uuid = ? ORDER BY best_time_ms ASC',
    [uuid],
  );
}

// ── Legion (reconciled with the plugin schema, B-11) ────────────────────────
// The plugin's SchemaInitializer creates legion_members as
// (legion_name, player_uuid, role, joined_at) — role values are the
// LegionRank enum names TIRO/LEGIONARY/CENTURION/TRIBUNUS/LEGATUS. The old
// queries here selected `uuid, rank, contribution`, columns that exist in
// NEITHER database — every call errored, gameQuery swallowed it to [], and
// the Postgres fallback answered alone. Same shapes as pool.ts's
// LegionInfo/LegionMemberInfo so /player/legion returns ONE response shape
// whichever database answers.

export interface GameLegionInfo {
  name: string;
  displayName: string | null;
  level: number;
  ownerUuid: string;
  xp: number;
  maxMembers: number;
}

export interface GameLegionMember {
  uuid: string;
  username: string | null;
  role: string;
}

export async function getGamePlayerLegionId(uuid: string): Promise<string | null> {
  const rows = await gameQuery<{ legion_name: string }>(
    'SELECT legion_name FROM legion_members WHERE player_uuid = ? LIMIT 1',
    [uuid],
  );
  return rows[0]?.legion_name ?? null;
}

export async function getGameLegionInfo(legionName: string): Promise<GameLegionInfo | null> {
  const rows = await gameQuery<{
    name: string;
    display_name: string | null;
    level: string | number;
    owner_uuid: string;
    xp: string | number;
    max_members: string | number;
  }>(
    `SELECT name, display_name, level, owner_uuid, xp, max_members
       FROM legions WHERE name = ? LIMIT 1`,
    [legionName],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    name: row.name,
    displayName: row.display_name,
    level: Number(row.level ?? 1),
    ownerUuid: row.owner_uuid,
    xp: Number(row.xp ?? 0),
    maxMembers: Number(row.max_members ?? 10),
  };
}

export async function getGameLegionMembers(legionName: string): Promise<GameLegionMember[]> {
  const rows = await gameQuery<{ player_uuid: string; role: string; username: string | null }>(
    `SELECT m.player_uuid, m.role, pn.username
       FROM legion_members m
       LEFT JOIN player_names pn ON m.player_uuid = pn.uuid
      WHERE m.legion_name = ?
      ORDER BY CASE m.role
                 WHEN 'LEGATUS' THEN 0
                 WHEN 'TRIBUNUS' THEN 1
                 WHEN 'CENTURION' THEN 2
                 WHEN 'LEGIONARY' THEN 3
                 ELSE 4
               END, pn.username`,
    [legionName],
  );
  return rows.map((row) => ({
    uuid: row.player_uuid,
    username: row.username,
    role: row.role,
  }));
}

export async function getGamePlayerCosmetics(uuid: string): Promise<Array<Record<string, unknown>>> {
  return gameQuery(
    'SELECT * FROM player_cosmetics WHERE uuid = ?',
    [uuid],
  );
}

export async function getGamePlayerDailyQuests(uuid: string): Promise<Array<Record<string, unknown>>> {
  return gameQuery(
    'SELECT * FROM player_daily_quests WHERE uuid = ?',
    [uuid],
  );
}

export async function getGameCrateKeys(uuid: string): Promise<Record<string, number>> {
  // Both key stores: legacy per-crate keys (player_crate_keys) and the
  // store product lines (crate_line_keys). Merged into one id->count map —
  // the dashboard shows both families as one catalog.
  const [legacy, lines] = await Promise.all([
    gameQuery<{ crate_type: string; key_count: number }>(
      'SELECT crate_type, key_count FROM player_crate_keys WHERE uuid = ? AND key_count > 0',
      [uuid],
    ),
    gameQuery<{ line: string; amount: number }>(
      'SELECT line, amount FROM crate_line_keys WHERE uuid = ? AND amount > 0',
      [uuid],
    ),
  ]);
  const keys: Record<string, number> = {};
  for (const row of legacy) keys[row.crate_type] = Number(row.key_count ?? 0);
  for (const row of lines) keys[row.line] = Number(row.amount ?? 0);
  return keys;
}

export async function getGameCrateOpenings(uuid: string, limit = 25): Promise<Array<Record<string, unknown>>> {
  return gameQuery(
    'SELECT crate_id, reward_display, timestamp AS opened_at FROM crate_open_log WHERE uuid = ? ORDER BY opened_at DESC LIMIT ?',
    [uuid, limit],
  );
}

export interface GamePlayerRewards {
  votes: { currentStreak: number; totalVotes: number; lastVoteDay: string | null } | null;
  daily: { currentStreak: number; bestStreak: number; totalClaimed: number; lastClaim: string | null } | null;
}

export async function getGamePlayerRewards(uuid: string): Promise<GamePlayerRewards> {
  const [votes, daily] = await Promise.all([
    gameQuery<{ current_streak: number; total_votes: number; last_vote_day: string | null }>(
      'SELECT current_streak, total_votes, last_vote_day FROM player_votes WHERE uuid = ? LIMIT 1',
      [uuid],
    ),
    gameQuery<{ current_streak: number; best_streak: number; total_claimed: number; last_claim: string | null }>(
      'SELECT current_streak, best_streak, total_claimed, last_claim FROM daily_rewards WHERE uuid = ? LIMIT 1',
      [uuid],
    ),
  ]);
  return {
    votes: votes[0]
      ? {
          currentStreak: Number(votes[0].current_streak ?? 0),
          totalVotes: Number(votes[0].total_votes ?? 0),
          lastVoteDay: votes[0].last_vote_day ?? null,
        }
      : null,
    daily: daily[0]
      ? {
          currentStreak: Number(daily[0].current_streak ?? 0),
          bestStreak: Number(daily[0].best_streak ?? 0),
          totalClaimed: Number(daily[0].total_claimed ?? 0),
          lastClaim: daily[0].last_claim ?? null,
        }
      : null,
  };
}

export async function getGamePrivacyExport(
  uuid: string,
): Promise<{ data: string; createdAtMs: number; date: string } | null> {
  const rows = await gameQuery<{ data: string; created_at_ms: number }>(
    'SELECT data, created_at_ms FROM privacy_export_files WHERE uuid = ? AND expires_at_ms > ? ORDER BY id DESC LIMIT 1',
    [uuid, Date.now()],
  );
  const row = rows[0];
  if (!row) return null;
  const created = Number(row.created_at_ms ?? 0);
  return {
    data: String(row.data ?? ''),
    createdAtMs: created,
    date: new Date(created).toISOString().slice(0, 10),
  };
}

export async function getGamePlayerFirstSeen(uuid: string): Promise<string | null> {
  // onboarding_state.first_seen is the closest thing to a join record; fall
  // back to the earliest economy log row (every player earns their first
  // denarius within minutes of joining).
  const [onboard, econ] = await Promise.all([
    gameQuery<{ first_seen: string | null }>(
      'SELECT first_seen FROM onboarding_state WHERE player_uuid = ? LIMIT 1',
      [uuid],
    ),
    gameQuery<{ timestamp: string }>(
      'SELECT timestamp FROM economy_logs WHERE uuid = ? ORDER BY timestamp ASC LIMIT 1',
      [uuid],
    ),
  ]);
  const fromOnboard = onboard[0]?.first_seen ?? null;
  if (fromOnboard) return String(fromOnboard);
  const fromEcon = econ[0]?.timestamp ?? null;
  return fromEcon ? String(fromEcon) : null;
}

/** Legion project progress: completed projects + in-flight Civitas contributions.
 *  legion_projects_completed.legion_id stores the legion NAME (the legions
 *  table is name-keyed — verified 2026-09-13). */
export async function getGameLegionProjects(
  legionName: string,
): Promise<{
  completed: Array<{ projectId: string; completedAt: string | null }>;
  contributions: Array<{ projectId: string; total: number }>;
}> {
  const [done, contributing] = await Promise.all([
    gameQuery<{ project_id: string; completed_at: string | null }>(
      'SELECT project_id, completed_at FROM legion_projects_completed WHERE legion_id = ? ORDER BY completed_at ASC',
      [legionName],
    ),
    gameQuery<{ project_id: string; total: string }>(
      'SELECT project_id, SUM(amount) AS total FROM legion_projects_contributions WHERE legion_id = ? GROUP BY project_id',
      [legionName],
    ),
  ]);
  return {
    completed: done.map((r) => ({ projectId: String(r.project_id ?? ''), completedAt: r.completed_at ?? null })),
    contributions: contributing.map((r) => ({ projectId: String(r.project_id ?? ''), total: Number(r.total ?? 0) })),
  };
}
