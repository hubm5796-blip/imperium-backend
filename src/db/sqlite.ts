/**
 * Direct SQLite reader for the plugin's database.
 * Used for link code verification when Redis is not available.
 *
 * NOTE: the read-only handle (getDb) is used for SELECTs. Code consumption and
 * link writes need read-write access, so those open a short-lived RW handle.
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

/** Open a short-lived read-write handle to the plugin's SQLite database. */
function getRwDb(): DatabaseSync | null {
  if (!env.sqlitePath) return null;
  try {
    return new DatabaseSync(env.sqlitePath);
  } catch (err) {
    logger.error({ err: { message: (err as Error).message } }, 'Failed to open SQLite database (read-write)');
    return null;
  }
}

/** Result of consuming a link code: the Minecraft UUID the code was bound to. */
export interface ConsumedLinkCode {
  uuid: string;
}

/**
 * Atomically verify AND consume a link code in a single statement, so two
 * concurrent confirmations can't both redeem the same code. Returns the UUID
 * the code was bound to, or null if the code was invalid/expired/already used.
 *
 * This uses `DELETE ... RETURNING` which, under SQLite's serialized writes, is
 * atomic: the row is removed at the same instant it's read, so a second caller
 * racing on the same code will find nothing to delete.
 *
 * Note: the plugin's `link_codes` table is `(code, uuid, created_at,
 * expires_at)` — it has NO discord_id column (codes are generated in-game bound
 * only to the UUID). The Discord id is therefore supplied by the bot at confirm
 * time. Callers that DO have a stored discord_id (the Redis web flow) must
 * validate it themselves.
 */
export function consumeLinkCode(code: string): ConsumedLinkCode | null {
  const upper = code.toUpperCase();

  // The read-only handle cannot DELETE; open an RW handle for the operation.
  const rwDb = getRwDb();
  if (!rwDb) return null;

  try {
    const row = rwDb.prepare(
      `DELETE FROM link_codes WHERE code = ? AND expires_at > datetime('now') RETURNING uuid`
    ).get(upper) as { uuid: string } | undefined;
    return row ? { uuid: row.uuid } : null;
  } catch {
    // Table might not exist yet, or DELETE...RETURNING unsupported.
    return null;
  } finally {
    rwDb.close();
  }
}

/**
 * Verify a link code WITHOUT consuming it. Prefer {@link consumeLinkCode} for
 * the actual confirmation flow — this non-destructive check is retained only for
 * pre-flight "is the code still valid?" lookups. Returns the Minecraft UUID the
 * code belongs to, or null if invalid/expired.
 */
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

/**
 * Look up the Discord id currently linked to a Minecraft UUID via SQLite, or
 * null if the UUID is not linked (or SQLite is unavailable). Read-only. Used as
 * the hijack guard before {@link upsertDiscordLinkSqlite}.
 */
export function getLinkedDiscordIdSqlite(uuid: string): string | null {
  const sqlite = getDb();
  if (!sqlite) return null;
  try {
    const row = sqlite.prepare(
      `SELECT discord_id FROM discord_links WHERE uuid = ?`
    ).get(uuid) as { discord_id: string } | undefined;
    return row?.discord_id ?? null;
  } catch {
    return null;
  }
}

/**
 * Write a discord link directly to the SQLite database (for environments without
 * PostgreSQL). The caller is responsible for the hijack guard (see {@link
 * getLinkedDiscordIdSqlite}): this function intentionally does NOT silently
 * rebind a UUID that is already linked to a different Discord account.
 *
 * Returns:
 *  - `true` if the link was written (new link, or re-link to the SAME Discord).
 *  - `false` if SQLite is unavailable or the write failed.
 *  - `'conflict'` if the UUID is already linked to a DIFFERENT Discord id.
 */
export function upsertDiscordLinkSqlite(
  uuid: string,
  discordId: string,
): boolean | 'conflict' {
  const rwDb = getRwDb();
  if (!rwDb) return false;

  try {
    // Hijack guard: refuse to silently rebind to a different Discord account.
    try {
      const existing = rwDb.prepare(
        `SELECT discord_id FROM discord_links WHERE uuid = ?`
      ).get(uuid) as { discord_id: string } | undefined;
      if (existing && existing.discord_id && existing.discord_id !== discordId) {
        return 'conflict';
      }
    } catch {
      // discord_links table may not exist yet — fall through to the INSERT.
    }

    rwDb.prepare(
      `INSERT INTO discord_links (uuid, discord_id, linked_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(uuid) DO UPDATE SET discord_id = excluded.discord_id, linked_at = datetime('now')`
    ).run(uuid, discordId);
    return true;
  } catch (err) {
    logger.error({ err: { message: (err as Error).message } }, 'Failed to write discord link to SQLite');
    return false;
  } finally {
    rwDb.close();
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
