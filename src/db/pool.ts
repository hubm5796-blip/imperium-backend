import { Pool, type QueryResult, type QueryResultRow } from 'pg';
import { env } from '../env.js';
import { logger } from '../utils/logger.js';
import {
  CURRENCY_COLUMNS,
  type CurrencyBalanceRow,
  type DiscordLinkRow,
  type EconomyTransactionRow,
  type PlayerRankRow,
  type PlayerStatsRow,
  type PlayerProfile,
  type PrestigeDataRow,
} from '../types/index.js';
import { minorUnitsToDisplay } from '../utils/money.js';

/** Shared PostgreSQL connection pool. */
export const pool = new Pool({
  connectionString: env.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected error on idle pg client');
});

async function query<T extends QueryResultRow>(
  text: string,
  params: ReadonlyArray<unknown>,
): Promise<QueryResult<T>> {
  const client = await pool.connect();
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

  const blocksMined = minorUnitsToDisplay(row.blocks_mined as unknown as string);
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
  type: 'denarius' | 'blocks' | 'prestige',
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
    const result = await query<{ uuid: string; balance: string }>(
      `SELECT uuid, balance
         FROM currency_balances
        WHERE currency = $1
        ORDER BY balance DESC
        LIMIT $2`,
      [CURRENCY_COLUMNS.denarius, cap],
    );
    return result.rows.map((row) => ({
      uuid: row.uuid,
      value: minorUnitsToDisplay(row.balance),
    }));
  }

  if (type === 'blocks') {
    const result = await query<{ uuid: string; blocks_mined: string }>(
      `SELECT uuid, blocks_mined
         FROM player_stats
        ORDER BY blocks_mined DESC
        LIMIT $1`,
      [cap],
    );
    return result.rows.map((row) => ({
      uuid: row.uuid,
      value: minorUnitsToDisplay(row.blocks_mined),
    }));
  }

  // prestige
  const result = await query<{ uuid: string; prestige_level: string; prestige_points: string }>(
    `SELECT uuid, prestige_level, prestige_points
       FROM prestige_data
      ORDER BY prestige_level DESC, prestige_points DESC
      LIMIT $1`,
    [cap],
  );
  return result.rows.map((row) => ({
    uuid: row.uuid,
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
