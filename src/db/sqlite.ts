/**
 * Direct SQLite reader for the plugin's database.
 * Used for link code verification when Redis is not available.
 * READ-ONLY — never writes to the game database.
 */
import { DatabaseSync } from 'node:sqlite';
import { env } from '../env.js';
import { logger } from '../utils/logger.js';

let db: DatabaseSync | null = null;

function getDb(): DatabaseSync | null {
  if (!env.sqlitePath) return null;
  if (!db) {
    try {
      db = new DatabaseSync(env.sqlitePath, { readOnly: true });
      logger.info({ path: env.sqlitePath }, 'SQLite reader opened (read-only)');
    } catch (err) {
      logger.error({ err: { message: (err as Error).message } }, 'Failed to open SQLite database');
      return null;
    }
  }
  return db;
}

/** Verify a link code and return the Minecraft UUID it belongs to, or null if invalid/expired. */
export function verifyLinkCode(code: string): { uuid: string } | null {
  const sqlite = getDb();
  if (!sqlite) return null;

  try {
    const row = sqlite.prepare(
      `SELECT uuid FROM link_codes WHERE code = ? AND expires_at > datetime('now')`
    ).get(code.toUpperCase()) as { uuid: string } | undefined;

    return row ? { uuid: row.uuid } : null;
  } catch {
    // Table might not exist yet
    return null;
  }
}

/** Check if a Minecraft UUID is already linked to a Discord account. */
export function getDiscordLink(uuid: string): { discord_id: string } | null {
  const sqlite = getDb();
  if (!sqlite) return null;

  try {
    const row = sqlite.prepare(
      `SELECT discord_id FROM discord_links WHERE uuid = ?`
    ).get(uuid) as { discord_id: string } | undefined;

    return row ? { discord_id: row.discord_id } : null;
  } catch {
    return null;
  }
}

/** Get a player's basic profile from SQLite (for bot commands). */
export function getPlayerProfile(uuid: string): {
  username: string;
  rank: number;
  prestige: number;
  denarius: number;
  auctoritas: number;
  civitas: number;
  aureus: number;
  blocks_mined: number;
  play_time: number;
  pvp_kills: number;
  pvp_deaths: number;
} | null {
  const sqlite = getDb();
  if (!sqlite) return null;

  try {
    // Get rank + prestige
    const rankRow = sqlite.prepare(
      `SELECT pr.rank_level, pr.rank_name,
              pd.prestige_level, pd.prestige_points
       FROM player_ranks pr
       LEFT JOIN prestige_data pd ON pr.uuid = pd.uuid
       WHERE pr.uuid = ?`
    ).get(uuid) as any;

    if (!rankRow) return null;

    // Get balances
    const balances = sqlite.prepare(
      `SELECT currency, balance FROM currency_balances WHERE uuid = ?`
    ).all(uuid) as Array<{ currency: string; balance: number }>;

    let denarius = 0, auctoritas = 0, civitas = 0, aureus = 0;
    for (const b of balances) {
      const val = Number(b.balance) / 100; // minor units
      const cur = b.currency.toLowerCase();
      if (cur === 'money' || cur === 'denarius') denarius = val;
      else if (cur === 'tokens' || cur === 'auctoritas') auctoritas = val;
      else if (cur === 'beacons' || cur === 'civitas') civitas = val;
      else if (cur === 'gc' || cur === 'aureus') aureus = val;
    }

    // Get stats
    const statsRow = sqlite.prepare(
      `SELECT blocks_mined, play_time, pvp_kills, pvp_deaths FROM player_stats WHERE uuid = ?`
    ).get(uuid) as any || { blocks_mined: 0, play_time: 0, pvp_kills: 0, pvp_deaths: 0 };

    // Get username from offline player data
    let username = 'Unknown';
    try {
      const nameRow = sqlite.prepare(
        `SELECT rank_name FROM player_ranks WHERE uuid = ?`
      ).get(uuid) as any;
      // We don't have the MC username in the DB reliably, use a fallback
      username = `Player-${uuid.substring(0, 8)}`;
    } catch {}

    return {
      username,
      rank: rankRow.rank_level || 1,
      prestige: rankRow.prestige_level || 0,
      denarius,
      auctoritas,
      civitas,
      aureus,
      blocks_mined: Number(statsRow.blocks_mined) || 0,
      play_time: Number(statsRow.play_time) || 0,
      pvp_kills: Number(statsRow.pvp_kills) || 0,
      pvp_deaths: Number(statsRow.pvp_deaths) || 0,
    };
  } catch (err) {
    logger.error({ err: { message: (err as Error).message } }, 'SQLite profile query failed');
    return null;
  }
}

/** Write a discord link directly to the SQLite database (for environments without PostgreSQL). */
export function upsertDiscordLinkSqlite(uuid: string, discordId: string): boolean {
  // We need read-write access for this. Reopen the DB in read-write mode.
  if (!env.sqlitePath) return false;

  try {
    const rwDb = new DatabaseSync(env.sqlitePath);
    rwDb.prepare(
      `INSERT INTO discord_links (uuid, discord_id, linked_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(uuid) DO UPDATE SET discord_id = excluded.discord_id, linked_at = datetime('now')`
    ).run(uuid, discordId);
    // Also delete the consumed link code
    try {
      rwDb.prepare(`DELETE FROM link_codes WHERE uuid = ?`).run(uuid);
    } catch {}
    rwDb.close();
    return true;
  } catch (err) {
    logger.error({ err: { message: (err as Error).message } }, 'Failed to write discord link to SQLite');
    return false;
  }
}

/** Find a player UUID by looking up their Discord link. */
export function getUuidByDiscordId(discordId: string): string | null {
  const sqlite = getDb();
  if (!sqlite) return null;

  try {
    const row = sqlite.prepare(
      `SELECT uuid FROM discord_links WHERE discord_id = ?`
    ).get(discordId) as { uuid: string } | undefined;

    return row?.uuid ?? null;
  } catch {
    return null;
  }
}

/** Get leaderboard from SQLite. */
export function getLeaderboardFromSqlite(
  type: 'denarius' | 'blocks' | 'prestige' | 'playtime',
  limit: number
): Array<{ uuid: string; value: number; secondary?: number }> {
  const sqlite = getDb();
  if (!sqlite) return [];

  try {
    let rows: any[];
    if (type === 'denarius') {
      rows = sqlite.prepare(
        `SELECT uuid, balance FROM currency_balances WHERE currency IN ('money', 'denarius') ORDER BY balance DESC LIMIT ?`
      ).all(limit) as any[];
      return rows.map(r => ({ uuid: r.uuid, value: Number(r.balance) / 100 }));
    } else if (type === 'blocks') {
      rows = sqlite.prepare(
        `SELECT uuid, blocks_mined FROM player_stats ORDER BY blocks_mined DESC LIMIT ?`
      ).all(limit) as any[];
      return rows.map(r => ({ uuid: r.uuid, value: Number(r.blocks_mined) }));
    } else if (type === 'prestige') {
      rows = sqlite.prepare(
        `SELECT uuid, prestige_level FROM prestige_data WHERE prestige_level > 0 ORDER BY prestige_level DESC LIMIT ?`
      ).all(limit) as any[];
      return rows.map(r => ({ uuid: r.uuid, value: Number(r.prestige_level) }));
    } else {
      rows = sqlite.prepare(
        `SELECT uuid, play_time FROM player_stats ORDER BY play_time DESC LIMIT ?`
      ).all(limit) as any[];
      return rows.map(r => ({ uuid: r.uuid, value: Number(r.play_time) }));
    }
  } catch {
    return [];
  }
}
