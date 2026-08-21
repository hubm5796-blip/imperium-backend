/**
 * Command analytics (V6 02-09): one fire-and-forget row per command execution.
 * Ported from imperium-discord to the backend's own pool.
 *
 * Privacy (binding per the blueprint): discord_id + command name + outcome +
 * duration only. Never option values, never message content. Aggregates are
 * the only query surface (/botstats) — no per-user lookups.
 *
 * Failure isolation: analytics must never affect an interaction — inserts are
 * fire-and-forget with their own catch; a Postgres blip costs a missing row,
 * not a broken command.
 */
import { query } from '../../db/pool.js';

/** Record one execution. Returns a promise the caller should NOT await on the
 *  interaction path (pass it to waitUntil / void it). */
export function recordCommand(entry: {
  discordId: string;
  command: string;
  outcome: 'ok' | `error:${string}`;
  durationMs: number;
  guildId: string | null;
}): Promise<boolean> {
  return query(
    'INSERT INTO bot_command_log (discord_id, command, outcome, duration_ms, guild_id) VALUES ($1, $2, $3, $4, $5)',
    [entry.discordId, entry.command, entry.outcome, Math.max(0, Math.round(entry.durationMs)), entry.guildId],
  )
    .then(() => true)
    .catch((err: unknown) => {
      console.error(`[analytics] command log insert failed: ${err instanceof Error ? err.message : err}`);
      return false;
    });
}

/** Best-effort touch of the per-user activity row (commands_total++, last_seen).
 *  A single UPSERT with a SQL-side increment — races between concurrent
 *  commands are counted correctly by the database, not lost by a read-modify-write. */
export async function touchUserActivity(discordId: string): Promise<void> {
  try {
    await query(
      `INSERT INTO bot_user_activity (discord_id, commands_total, last_seen_at, first_seen_at)
       VALUES ($1, 1, now(), now())
       ON CONFLICT (discord_id) DO UPDATE SET
         commands_total = bot_user_activity.commands_total + 1,
         last_seen_at = now()`,
      [discordId],
    );
  } catch (err) {
    console.error(`[analytics] activity touch failed: ${err instanceof Error ? err.message : err}`);
  }
}
