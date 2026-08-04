import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import { logger } from '../utils/logger.js';
import {
  CURRENCY_COLUMNS,
  type CurrencyBalanceRow,
  type DiscordLinkRow,
  type EconomyTransactionRow,
  type PaynowSubscriptionRow,
  type PlayerRankRow,
  type PlayerStatsRow,
  type PlayerProfile,
  type PrestigeDataRow,
} from '../types/index.js';
import { minorUnitsToDisplay } from '../utils/money.js';

/**
 * Lazily-initialized PostgreSQL connection pool. Not created at module load
 * time: on Workers, the connection string comes from the Hyperdrive binding
 * (`c.env.HYPERDRIVE.connectionString`), which is only available per-request,
 * not at module scope. `initPool()` is idempotent — a Hono middleware calls
 * it on every request, but only the first call on a given warm isolate
 * actually creates the pool; later calls reuse it, same as the old eager
 * module-level singleton did within one Node process.
 */
let pool: Pool | null = null;

export function initPool(connectionString: string): void {
  if (pool) return;
  pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  pool.on('error', (err) => {
    logger.error({ err }, 'Unexpected error on idle pg client');
  });
}

function getPool(): Pool {
  if (!pool) {
    throw new Error('Postgres pool not initialized — initPool() must run before any query');
  }
  return pool;
}

/** Drains the pool on graceful shutdown (Node dev entrypoint only — Workers has no shutdown hook). */
export async function closePool(): Promise<void> {
  if (pool) await pool.end();
}

async function query<T extends QueryResultRow>(
  text: string,
  params: ReadonlyArray<unknown>,
): Promise<QueryResult<T>> {
  const client = await getPool().connect();
  try {
    return await client.query<T>(text, params as unknown[]);
  } finally {
    client.release();
  }
}

/** Look up the Minecraft UUID associated with a Discord account, if linked. */
export async function getUuidByDiscordId(discordId: string): Promise<string | null> {
  const result = await query<Pick<DiscordLinkRow, 'uuid'>>(
    'SELECT uuid FROM discord_links WHERE discord_id = $1',
    [discordId],
  );
  return result.rows[0]?.uuid ?? null;
}

/** Look up the Discord id linked to a Minecraft UUID, if any. */
export async function getDiscordIdByUuid(uuid: string): Promise<string | null> {
  const result = await query<Pick<DiscordLinkRow, 'discord_id'>>(
    'SELECT discord_id FROM discord_links WHERE uuid = $1',
    [uuid],
  );
  return result.rows[0]?.discord_id ?? null;
}

/**
 * Return the Discord id currently linked to a Minecraft UUID, or null if the
 * UUID has no link. Used as the hijack guard before {@link upsertDiscordLink}:
 * callers must reject (409) when a UUID is already bound to a DIFFERENT Discord
 * account, so a confirmation can never silently rebind an existing link.
 */
export async function isAlreadyLinked(uuid: string): Promise<string | null> {
  const result = await query<Pick<DiscordLinkRow, 'discord_id'>>(
    'SELECT discord_id FROM discord_links WHERE uuid = $1',
    [uuid],
  );
  return result.rows[0]?.discord_id ?? null;
}

/** Insert (or upsert) a Discord <-> Minecraft link. Called by the bot. */
export async function upsertDiscordLink(uuid: string, discordId: string): Promise<void> {
  await query(
    `INSERT INTO discord_links (uuid, discord_id, linked_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (uuid) DO UPDATE
       SET discord_id = EXCLUDED.discord_id,
           linked_at = EXCLUDED.linked_at`,
    [uuid, discordId],
  );
}

/** Remove a Discord <-> Minecraft link by Discord id. Returns true if a row was deleted. */
export async function deleteDiscordLinkByDiscordId(discordId: string): Promise<boolean> {
  const result = await query(
    'DELETE FROM discord_links WHERE discord_id = $1',
    [discordId],
  );
  return (result.rowCount ?? 0) > 0;
}

/* --------------------------------------------------------------- PayNow */

/** Look up the PayNow customer id linked to a player, if we've seen them at checkout before. */
export async function getPaynowCustomerId(uuid: string): Promise<string | null> {
  const result = await query<Pick<DiscordLinkRow, 'paynow_customer_id'>>(
    'SELECT paynow_customer_id FROM discord_links WHERE uuid = $1',
    [uuid],
  );
  return result.rows[0]?.paynow_customer_id ?? null;
}

/** Persist the PayNow customer id for a linked player (set once found/created). */
export async function setPaynowCustomerId(uuid: string, customerId: string): Promise<void> {
  await query(
    'UPDATE discord_links SET paynow_customer_id = $2 WHERE uuid = $1',
    [uuid, customerId],
  );
}

/**
 * Cached view of a player's active donor subscription, kept in sync by the
 * PayNow webhook handler. Used for fast dashboard reads without calling out
 * to PayNow on every page load.
 */
export async function getCachedSubscription(uuid: string): Promise<PaynowSubscriptionRow | null> {
  const result = await query<PaynowSubscriptionRow>(
    'SELECT uuid, subscription_id, product_id, status, updated_at FROM paynow_subscriptions WHERE uuid = $1',
    [uuid],
  );
  return result.rows[0] ?? null;
}

/** Upsert the cached subscription row for a player (called from the webhook handler). */
export async function upsertCachedSubscription(
  uuid: string,
  subscriptionId: string,
  productId: string,
  status: string,
): Promise<void> {
  await query(
    `INSERT INTO paynow_subscriptions (uuid, subscription_id, product_id, status, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (uuid) DO UPDATE
       SET subscription_id = EXCLUDED.subscription_id,
           product_id = EXCLUDED.product_id,
           status = EXCLUDED.status,
           updated_at = EXCLUDED.updated_at`,
    [uuid, subscriptionId, productId, status],
  );
}

/** Look up a player's uuid by their PayNow customer id (webhooks carry customer id, not uuid). */
export async function getUuidByPaynowCustomerId(customerId: string): Promise<string | null> {
  const result = await query<Pick<DiscordLinkRow, 'uuid'>>(
    'SELECT uuid FROM discord_links WHERE paynow_customer_id = $1',
    [customerId],
  );
  return result.rows[0]?.uuid ?? null;
}

/**
 * Fetch the full player profile (rank + prestige + stats) for a single UUID.
 * All JOINs are LEFT JOINs so a partial profile is returned if some tables
 * have no row yet.
 */
export async function getPlayerProfile(uuid: string): Promise<PlayerProfile | null> {
  const result = await query<PlayerRankRow & PrestigeDataRow & PlayerStatsRow>(
    `SELECT pr.rank_level, pr.rank_name, pr.rank_progress,
            pd.prestige_level, pd.prestige_points,
            ps.blocks_mined, ps.play_time, ps.pvp_kills, ps.pvp_deaths, ps.pvp_trophies
       FROM player_ranks pr
       LEFT JOIN prestige_data pd ON pr.uuid = pd.uuid
       LEFT JOIN player_stats ps ON pr.uuid = ps.uuid
      WHERE pr.uuid = $1`,
    [uuid],
  );

  const row = result.rows[0];
  if (!row) return null;

  // blocks_mined is a raw COUNT, not minor-unit currency; do NOT divide by 100.
  const blocksMined = Number(row.blocks_mined ?? 0);
  const pvpKills = Number(row.pvp_kills ?? 0);
  const pvpDeaths = Number(row.pvp_deaths ?? 0);

  return {
    uuid,
    rank: {
      level: Number(row.rank_level ?? 0),
      name: row.rank_name ?? 'Unranked',
      progress: Number(row.rank_progress ?? 0),
    },
    prestige:
      row.prestige_level === null && row.prestige_points === null
        ? null
        : {
            level: Number(row.prestige_level ?? 0),
            points: Number(row.prestige_points ?? 0),
          },
    stats:
      row.blocks_mined === null && row.play_time === null
        ? null
        : {
            blocksMined,
            playTime: row.play_time ?? '0',
            pvpKills,
            pvpDeaths,
            pvpTrophies: Number(row.pvp_trophies ?? 0),
            kdRatio: pvpDeaths === 0 ? (pvpKills > 0 ? pvpKills : null) : pvpKills / pvpDeaths,
          },
  };
}

/**
 * Resolve a username to its Minecraft UUID via the plugin-maintained registry
 * (kept current on every join). Case-insensitive exact match — usernames
 * (including Bedrock/Floodgate-prefixed ones) are matched as typed.
 */
export async function getUuidByUsername(username: string): Promise<string | null> {
  const result = await query<{ uuid: string }>(
    'SELECT uuid FROM player_names WHERE LOWER(username) = LOWER($1)',
    [username],
  );
  return result.rows[0]?.uuid ?? null;
}

/**
 * Resolve a Minecraft UUID to its current username via the plugin-maintained
 * player_names registry (kept current on every join). Returns null if the UUID
 * is unknown (player never joined, or the registry isn't populated yet).
 */
export async function getNameByUuid(uuid: string): Promise<string | null> {
  const result = await query<{ username: string }>(
    'SELECT username FROM player_names WHERE uuid = $1',
    [uuid],
  );
  return result.rows[0]?.username ?? null;
}

/** Fetch all four currency balances for a UUID, converted from minor units. */
export async function getPlayerBalances(
  uuid: string,
): Promise<Record<keyof typeof CURRENCY_COLUMNS, number>> {
  const result = await query<CurrencyBalanceRow>(
    'SELECT currency, balance FROM currency_balances WHERE uuid = $1',
    [uuid],
  );

  const balances: Record<keyof typeof CURRENCY_COLUMNS, number> = {
    denarius: 0,
    tokens: 0,
    beacons: 0,
    goldenCoins: 0,
  };

  // Reverse lookup: db column -> friendly key.
  const columnToKey = Object.fromEntries(
    Object.entries(CURRENCY_COLUMNS).map(([k, v]) => [v, k]),
  ) as Record<string, keyof typeof CURRENCY_COLUMNS>;

  for (const row of result.rows) {
    const key = columnToKey[row.currency.toLowerCase()];
    if (key) {
      balances[key] = minorUnitsToDisplay(row.balance);
    }
  }

  return balances;
}

/** Fetch raw stats row for a UUID (blocks, pvp, playtime). */
export async function getPlayerStats(uuid: string): Promise<PlayerStatsRow | null> {
  const result = await query<PlayerStatsRow>(
    `SELECT blocks_mined, play_time, pvp_kills, pvp_deaths, pvp_trophies
       FROM player_stats
      WHERE uuid = $1`,
    [uuid],
  );
  return result.rows[0] ?? null;
}

/** A transaction row with its display value already converted from minor units. */
export interface DisplayTransaction {
  id: number;
  type: string;
  currency: string;
  amount: string; // raw minor-unit amount from the DB
  displayAmount: number; // converted major-unit amount
  description: string | null;
  createdAt: Date;
}

/** Fetch a page of economy transactions for a UUID, newest first. */
export async function getPlayerTransactions(
  uuid: string,
  page: number,
  pageSize: number,
): Promise<{ rows: DisplayTransaction[]; total: number }> {
  const offset = Math.max(0, (page - 1) * pageSize);
  const dataResult = await query<EconomyTransactionRow>(
    `SELECT id, uuid, type, currency, amount, description, created_at
       FROM economy_transactions
      WHERE uuid = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3`,
    [uuid, pageSize, offset],
  );

  const countResult = await query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM economy_transactions WHERE uuid = $1',
    [uuid],
  );
  const total = Number(countResult.rows[0]?.count ?? 0);

  return {
    rows: dataResult.rows.map((row) => ({
      id: row.id,
      type: row.type,
      currency: row.currency,
      amount: row.amount,
      displayAmount: minorUnitsToDisplay(row.amount),
      description: row.description,
      createdAt: row.created_at,
    })),
    total,
  };
}

/** Top 20 players by the requested ranking type. */
export async function getLeaderboard(
  type: 'denarius' | 'blocks' | 'prestige' | 'playtime',
  limit = 20,
): Promise<
  Array<{
    uuid: string;
    name?: string;
    value: number;
    secondary?: number;
  }>
> {
  const cap = Math.min(Math.max(limit, 1), 100);

  if (type === 'denarius') {
    const result = await query<{ uuid: string; balance: string; name: string | null }>(
      `SELECT cb.uuid, cb.balance, pn.username AS name
         FROM currency_balances cb
         LEFT JOIN player_names pn ON cb.uuid = pn.uuid
        WHERE cb.currency = $1
        ORDER BY cb.balance DESC
        LIMIT $2`,
      [CURRENCY_COLUMNS.denarius, cap],
    );
    return result.rows.map((row) => ({
      uuid: row.uuid,
      name: row.name ?? undefined,
      value: minorUnitsToDisplay(row.balance),
    }));
  }

  if (type === 'blocks') {
    const result = await query<{ uuid: string; blocks_mined: string; name: string | null }>(
      `SELECT ps.uuid, ps.blocks_mined, pn.username AS name
         FROM player_stats ps
         LEFT JOIN player_names pn ON ps.uuid = pn.uuid
        ORDER BY ps.blocks_mined DESC
        LIMIT $1`,
      [cap],
    );
    return result.rows.map((row) => ({
      uuid: row.uuid,
      name: row.name ?? undefined,
      value: Number(row.blocks_mined ?? 0),
    }));
  }

  if (type === 'playtime') {
    const result = await query<{ uuid: string; play_time: string; name: string | null }>(
      `SELECT ps.uuid, ps.play_time, pn.username AS name
         FROM player_stats ps
         LEFT JOIN player_names pn ON ps.uuid = pn.uuid
        ORDER BY ps.play_time DESC
        LIMIT $1`,
      [cap],
    );
    return result.rows.map((row) => ({
      uuid: row.uuid,
      name: row.name ?? undefined,
      value: Number(row.play_time),
    }));
  }

  // prestige
  const result = await query<{ uuid: string; prestige_level: string; prestige_points: string; name: string | null }>(
    `SELECT pd.uuid, pd.prestige_level, pd.prestige_points, pn.username AS name
       FROM prestige_data pd
       LEFT JOIN player_names pn ON pd.uuid = pn.uuid
      ORDER BY pd.prestige_level DESC, pd.prestige_points DESC
      LIMIT $1`,
    [cap],
  );
  return result.rows.map((row) => ({
    uuid: row.uuid,
    name: row.name ?? undefined,
    value: Number(row.prestige_level),
    secondary: Number(row.prestige_points),
  }));
}

/** Fetch the online player count from the database snapshot, if available. */
export async function getOnlinePlayerCountSnapshot(): Promise<number | null> {
  try {
    const result = await query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM online_players',
      [],
    );
    return Number(result.rows[0]?.count ?? 0);
  } catch {
    // Table may not exist in some deployments; callers fall back to Redis.
    return null;
  }
}

/* ----------------------------------------------------------- Skill tree */

/**
 * A skill tree branch in the shape consumed by the dashboard. `nodes` are the
 * player's unlocked node ids for that branch.
 */
export interface SkillBranchSummary {
  name: string;
  nodes: string[];
}

/**
 * Fetch a player's skill tree: the unlocked nodes grouped by branch, plus the
 * points available/spent. The plugin stores unlocked nodes in `player_skills`
 * as (uuid, branch, node_id). Points come from the player_skills table joined
 * against ranks/prestige, but since the "points earned" formula lives in the
 * plugin (rank × per-rank + prestige × per-prestige), we compute spent here
 * (count of unlocked rows) and available from earned-spent where earned is
 * derived from rank/prestige tables. Returns zeros if the player has no row.
 */
export async function getPlayerSkills(
  uuid: string,
): Promise<{ branches: SkillBranchSummary[]; available_points: number; spent_points: number }> {
  // Unlocked nodes grouped by branch.
  const skillsResult = await query<{ branch: string; node_id: string }>(
    'SELECT branch, node_id FROM player_skills WHERE uuid = $1 ORDER BY branch, node_id',
    [uuid],
  );
  const byBranch = new Map<string, string[]>();
  for (const row of skillsResult.rows) {
    const list = byBranch.get(row.branch) ?? [];
    list.push(row.node_id);
    byBranch.set(row.branch, list);
  }
  const branches: SkillBranchSummary[] = Array.from(byBranch.entries()).map(([name, nodes]) => ({
    name,
    nodes,
  }));

  // Points spent = number of unlocked nodes (each node costs >=1 point).
  const spent_points = skillsResult.rowCount ?? 0;

  // Points earned follows the plugin's formula: rank_level * 1 + prestige_level * 5.
  // Read from the same tables getPlayerProfile uses; degrade to 0 if absent.
  let earned = 0;
  try {
    const rankResult = await query<{ rank_level: string }>(
      'SELECT rank_level FROM player_ranks WHERE uuid = $1',
      [uuid],
    );
    const prestigeResult = await query<{ prestige_level: string }>(
      'SELECT prestige_level FROM prestige_data WHERE uuid = $1',
      [uuid],
    );
    const rank = Number(rankResult.rows[0]?.rank_level ?? 0);
    const prestige = Number(prestigeResult.rows[0]?.prestige_level ?? 0);
    earned = rank + prestige * 5;
  } catch {
    earned = 0;
  }

  const available_points = Math.max(earned - spent_points, 0);
  return { branches, available_points, spent_points };
}

/* ----------------------------------------------------- Faction reputation */

/** A faction reputation entry for the dashboard. */
export interface PlayerFactionRep {
  id: string;
  name: string;
  rep: number;
  tier: string;
}

/** Reputation tier thresholds (mirror of FactionService's rep_tiers in factions.yml). */
const FACTION_REP_TIERS: Array<{ min: number; name: string }> = [
  { min: 10000, name: 'Exalted' },
  { min: 5000, name: 'Honored' },
  { min: 1000, name: 'Friendly' },
  { min: 1, name: 'Neutral' },
];

/** Map a raw reputation value to its tier name. */
function factionTierFor(rep: number): string {
  for (const tier of FACTION_REP_TIERS) {
    if (rep >= tier.min) return tier.name;
  }
  return 'Hostile';
}

/**
 * Fetch a player's reputation across all factions. The plugin stores raw rep
 * in `player_faction_rep`; faction display names come from the player's rows
 * (we fall back to the id as the name since faction definitions live in a
 * plugin-side YAML the backend doesn't read).
 */
export async function getPlayerFactions(uuid: string): Promise<{ factions: PlayerFactionRep[] }> {
  const result = await query<{ faction_id: string; reputation: string }>(
    'SELECT faction_id, reputation FROM player_faction_rep WHERE uuid = $1 ORDER BY reputation DESC',
    [uuid],
  );
  const factions: PlayerFactionRep[] = result.rows.map((row) => {
    const rep = Number(row.reputation ?? 0);
    return {
      id: row.faction_id,
      name: row.faction_id,
      rep,
      tier: factionTierFor(rep),
    };
  });
  return { factions };
}

/* ------------------------------------------------------------- Parkour */

/** A parkour record for one course for the linked player. */
export interface ParkourRecord {
  course: string;
  best_time_ms: number;
  completions: number;
}

/** Fetch all of a player's parkour records, ordered by best time. */
export async function getPlayerParkour(uuid: string): Promise<{ records: ParkourRecord[] }> {
  const result = await query<{ course_id: string; best_time_ms: string; completions: string }>(
    'SELECT course_id, best_time_ms, completions FROM parkour_records WHERE player_uuid = $1 ORDER BY best_time_ms ASC',
    [uuid],
  );
  const records: ParkourRecord[] = result.rows.map((row) => ({
    course: row.course_id,
    best_time_ms: Number(row.best_time_ms ?? 0),
    completions: Number(row.completions ?? 0),
  }));
  return { records };
}

/** A single parkour leaderboard entry (1-based rank added by the caller). */
export interface ParkourLeaderboardEntry {
  uuid: string;
  best_time_ms: number;
  completions: number;
}

/** Top completions for a course, fastest first. */
export async function getParkourLeaderboard(
  courseId: string,
  limit = 20,
): Promise<ParkourLeaderboardEntry[]> {
  const cap = Math.min(Math.max(limit, 1), 100);
  const result = await query<{ player_uuid: string; best_time_ms: string; completions: string }>(
    'SELECT player_uuid, best_time_ms, completions FROM parkour_records WHERE course_id = $1 ORDER BY best_time_ms ASC LIMIT $2',
    [courseId, cap],
  );
  return result.rows.map((row) => ({
    uuid: row.player_uuid,
    best_time_ms: Number(row.best_time_ms ?? 0),
    completions: Number(row.completions ?? 0),
  }));
}

/* ----------------------------------------------------- ELO / wave leaderboards */

/** A single ELO leaderboard entry (1-based rank added by the caller). */
export interface EloLeaderboardEntry {
  uuid: string;
  elo: number;
  wins: number;
  losses: number;
  peak_elo: number;
}

/** Top players by Arena Ranking (ELO). */
export async function getEloLeaderboard(limit = 20): Promise<EloLeaderboardEntry[]> {
  const cap = Math.min(Math.max(limit, 1), 100);
  const result = await query<{
    uuid: string;
    elo: string;
    wins: string;
    losses: string;
    peak_elo: string;
  }>(
    'SELECT uuid, elo, wins, losses, peak_elo FROM player_elo ORDER BY elo DESC, peak_elo DESC LIMIT $1',
    [cap],
  );
  return result.rows.map((row) => ({
    uuid: row.uuid,
    elo: Number(row.elo ?? 0),
    wins: Number(row.wins ?? 0),
    losses: Number(row.losses ?? 0),
    peak_elo: Number(row.peak_elo ?? 0),
  }));
}

/** A single endless-wave leaderboard entry (1-based rank added by the caller). */
export interface WaveLeaderboardEntry {
  uuid: string;
  highest_wave: number;
  total_sessions: number;
}

/** Top players by highest wave survived. */
export async function getWaveLeaderboard(limit = 20): Promise<WaveLeaderboardEntry[]> {
  const cap = Math.min(Math.max(limit, 1), 100);
  const result = await query<{ uuid: string; highest_wave: string; total_sessions: string }>(
    'SELECT uuid, highest_wave, total_sessions FROM endless_wave_records ORDER BY highest_wave DESC, total_sessions DESC LIMIT $1',
    [cap],
  );
  return result.rows.map((row) => ({
    uuid: row.uuid,
    highestWave: Number(row.highest_wave ?? 0),
    totalSessions: Number(row.total_sessions ?? 0),
  }));
}

// ─── Achievements ───────────────────────────────────────────────────────────

export interface PlayerAchievement {
  achievementId: string;
  progress: number;
  completed: boolean;
  claimed: boolean;
  completedAt: number;
}

export async function getPlayerAchievements(uuid: string): Promise<{ achievements: PlayerAchievement[] }> {
  const result = await query<{ achievement_id: string; progress: string; completed: boolean; claimed: boolean; completed_at: string }>(
    'SELECT achievement_id, progress, completed, claimed, completed_at FROM player_achievements WHERE uuid = $1 ORDER BY completed DESC, progress DESC',
    [uuid],
  );
  return {
    achievements: result.rows.map((row) => ({
      achievementId: row.achievement_id,
      progress: Number(row.progress ?? 0),
      completed: row.completed,
      claimed: row.claimed,
      completedAt: Number(row.completed_at ?? 0),
    })),
  };
}

// ─── Cosmetics ──────────────────────────────────────────────────────────────

export interface PlayerCosmetics {
  unlocked: string[];
  activeTrail: string | null;
  activeHat: string | null;
  activeKillEffect: string | null;
  activeMineEffect: string | null;
}

export async function getPlayerCosmetics(uuid: string): Promise<PlayerCosmetics> {
  const result = await query<{ unlocked_cosmetics: string | null; active_trail: string | null; active_hat: string | null; active_kill_effect: string | null; active_mine_effect: string | null }>(
    'SELECT unlocked_cosmetics, active_trail, active_hat, active_kill_effect, active_mine_effect FROM player_cosmetics WHERE uuid = $1',
    [uuid],
  );
  const row = result.rows[0];
  if (!row) {
    return { unlocked: [], activeTrail: null, activeHat: null, activeKillEffect: null, activeMineEffect: null };
  }
  let unlocked: string[] = [];
  try {
    unlocked = JSON.parse(row.unlocked_cosmetics ?? '[]');
  } catch {
    unlocked = [];
  }
  return {
    unlocked,
    activeTrail: row.active_trail,
    activeHat: row.active_hat,
    activeKillEffect: row.active_kill_effect,
    activeMineEffect: row.active_mine_effect,
  };
}

// ─── Skill Tree ─────────────────────────────────────────────────────────────

export interface PlayerSkillNode {
  branch: string;
  nodeId: string;
}

export async function getPlayerSkillNodes(uuid: string): Promise<{ nodes: PlayerSkillNode[] }> {
  const result = await query<{ branch: string; node_id: string }>(
    'SELECT branch, node_id FROM player_skills WHERE uuid = $1',
    [uuid],
  );
  return {
    nodes: result.rows.map((row) => ({
      branch: row.branch,
      nodeId: row.node_id,
    })),
  };
}

// ─── Daily Quests ───────────────────────────────────────────────────────────

export interface PlayerDailyQuest {
  questId: string;
  progress: number;
  completed: boolean;
  claimed: boolean;
}

export async function getPlayerDailyQuests(uuid: string): Promise<{ quests: PlayerDailyQuest[] }> {
  const result = await query<{ quest_id: string; progress: string; completed: boolean; claimed: boolean }>(
    "SELECT quest_id, progress, completed, claimed FROM player_daily_quests WHERE uuid = $1 AND assigned_date = CURRENT_DATE",
    [uuid],
  );
  return {
    quests: result.rows.map((row) => ({
      questId: row.quest_id,
      progress: Number(row.progress ?? 0),
      completed: row.completed,
      claimed: row.claimed,
    })),
  };
}
