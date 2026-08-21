/**
 * Bot-cron state access (V6 02-05/02-07/02-09) — the SQL port of the
 * imperium-discord PostgREST helpers. Everything here runs against the
 * backend's own Postgres pool (the same database the standalone worker
 * used via Supabase's REST API), so the tables and semantics carry over
 * 1:1; only the transport changed.
 *
 * Conventions: helpers never throw on read paths where a sane default
 * exists (state/prefs read as absent); claim/release DO throw so the
 * scheduler's claim-release retry discipline can distinguish "already
 * fired" from "database down".
 */
import { query } from '../db/pool.js';

// ── exactly-once notification ledger (discord_dedupe) ──────────────────────

/**
 * INSERT .. ON CONFLICT DO NOTHING RETURNING — the row comes back only when
 * THIS call created it, so exactly one cron invocation wins the race. This
 * is the port of the PostgREST ignore-duplicates insert.
 */
export async function claim(key: string): Promise<boolean> {
  const result = await query<{ dedupe_key: string }>(
    'INSERT INTO discord_dedupe (dedupe_key) VALUES ($1) ON CONFLICT (dedupe_key) DO NOTHING RETURNING dedupe_key',
    [key],
  );
  return result.rows.length > 0;
}

/** True when a key starting with `prefix` was claimed within `minutes`. */
export async function claimedWithin(prefix: string, minutes: number, now: Date): Promise<boolean> {
  const result = await query<{ created_at: string }>(
    'SELECT created_at FROM discord_dedupe WHERE dedupe_key LIKE $1 ORDER BY created_at DESC LIMIT 1',
    [`${prefix}%`],
  );
  const last = result.rows[0]?.created_at;
  if (!last) return false;
  return now.getTime() - Date.parse(last) < minutes * 60_000;
}

/** Release a claim so the next sweep retries (used when a send fails). */
export async function release(key: string): Promise<void> {
  await query('DELETE FROM discord_dedupe WHERE dedupe_key = $1', [key]);
}

/** How many keys under `prefix` were claimed within `minutes` — the
 *  per-kind hourly announcement ceiling's counter. */
export async function countClaimedWithin(prefix: string, minutes: number, now: Date): Promise<number> {
  const result = await query<{ created_at: string }>(
    'SELECT created_at FROM discord_dedupe WHERE dedupe_key LIKE $1 AND created_at > $2',
    [`${prefix}%`, new Date(now.getTime() - minutes * 60_000).toISOString()],
  );
  return result.rows.length;
}

// ── bot_state — tiny keyed JSON store (audit cursors, sweep stamps) ────────

export async function getState<T>(key: string): Promise<T | null> {
  try {
    const result = await query<{ value: T }>(
      'SELECT value FROM bot_state WHERE key = $1 LIMIT 1',
      [key],
    );
    return result.rows[0]?.value ?? null;
  } catch {
    // A missing table or a Postgres blip must read as "no state" — callers
    // treat that as a fresh start, never as a hard failure.
    return null;
  }
}

export async function setState(key: string, value: unknown): Promise<boolean> {
  try {
    await query(
      `INSERT INTO bot_state (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, JSON.stringify(value)],
    );
    return true;
  } catch (err) {
    console.error(`[botdb] state write failed for ${key}: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

// ── DM preferences (discord_dm_prefs) — every personal ping is opt-in ──────

export interface DmPrefs {
  dmEvents: boolean;
  voteReminder: boolean;
}

export async function getPrefs(discordId: string): Promise<DmPrefs> {
  const result = await query<{ dm_events: boolean; vote_reminder: boolean }>(
    'SELECT dm_events, vote_reminder FROM discord_dm_prefs WHERE discord_id = $1 LIMIT 1',
    [discordId],
  );
  const row = result.rows[0];
  return { dmEvents: row?.dm_events === true, voteReminder: row?.vote_reminder === true };
}

export async function setPrefs(
  discordId: string,
  prefs: Partial<DmPrefs>,
): Promise<DmPrefs> {
  await query(
    `INSERT INTO discord_dm_prefs (discord_id, dm_events, vote_reminder, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (discord_id) DO UPDATE SET
       dm_events = COALESCE(EXCLUDED.dm_events, discord_dm_prefs.dm_events),
       vote_reminder = COALESCE(EXCLUDED.vote_reminder, discord_dm_prefs.vote_reminder),
       updated_at = now()`,
    [discordId, prefs.dmEvents ?? null, prefs.voteReminder ?? null],
  );
  return getPrefs(discordId);
}

/** All users who opted into the daily vote reminder. */
export async function listVoteReminderUsers(): Promise<string[]> {
  const result = await query<{ discord_id: string }>(
    'SELECT discord_id FROM discord_dm_prefs WHERE vote_reminder = true LIMIT 1000',
    [],
  );
  return result.rows.map((r) => r.discord_id);
}

// ── linked members (discord_links) ─────────────────────────────────────────

export interface LinkedMemberRow {
  discord_id: string;
  uuid: string;
}

/** Linked members ordered by discord_id, paged AFTER a discord id (the role
 *  audit's resume cursor). discord_links hard-deletes on unlink, so every
 *  row here is an active link — no unlinked_at filter needed. */
export async function pageLinkedMembers(afterDiscordId: string, limit: number): Promise<LinkedMemberRow[]> {
  if (afterDiscordId) {
    const result = await query<LinkedMemberRow>(
      'SELECT discord_id, uuid FROM discord_links WHERE discord_id > $1 ORDER BY discord_id LIMIT $2',
      [afterDiscordId, limit],
    );
    return result.rows;
  }
  const result = await query<LinkedMemberRow>(
    'SELECT discord_id, uuid FROM discord_links ORDER BY discord_id LIMIT $1',
    [limit],
  );
  return result.rows;
}

/** Active discord_id for a Minecraft uuid, or null (= player has no Discord). */
export async function getDiscordIdForUuid(uuid: string): Promise<string | null> {
  try {
    const result = await query<{ discord_id: string }>(
      'SELECT discord_id FROM discord_links WHERE uuid = $1 LIMIT 1',
      [uuid],
    );
    return result.rows[0]?.discord_id ?? null;
  } catch (err) {
    // A DB outage returning null would silently skip every event DM as
    // "player has no Discord" — throw instead so the scheduler can log the
    // difference (same contract as the PostgREST port).
    throw err;
  }
}
