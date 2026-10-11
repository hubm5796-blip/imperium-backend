/**
 * Daily analytics rollup (V6 02-09), run from the every-minute cron during
 * the 00:05–00:59 UTC catch-up window. One dedupe-claimed pass per day: fold
 * bot_command_log into bot_metrics_daily, then delete log rows older than the
 * 90-day retention. Failure releases the claim so a later tick in the window
 * retries the whole pass — the rollup is idempotent (upsert by (day, metric,
 * command)), so a partial rerun is safe. B-39: days missed entirely (deploy
 * outage at 00:05) heal via the per-day claim loop (last 7 days).
 */
import { query } from '../../db/pool.js';
import { claim, release } from '../botdb.js';
export const ROLLUP_UTC_HOUR = 0;
export const ROLLUP_UTC_MINUTE = 5;
export const RETENTION_DAYS = 90;
export interface RollupReport {
 ran: boolean;
 day: string | null;
 metrics: number;
 error?: string;
}
interface LogRow {
 discord_id: string;
 command: string;
 outcome: string;
 duration_ms: number;
}
/** Fold rows into {(metric,command): value} aggregates. Pure — unit-tested. */
export function aggregateDay(rows: LogRow[]): Array<{ metric: string; command: string; value: number }> {
 const executions = new Map<string, number>();
 const errors = new Map<string, number>();
 const users = new Set<string>();
 let totalMs = 0;
 const durations = new Map<string, number[]>();
 for (const row of rows) {
 users.add(row.discord_id);
 executions.set(row.command, (executions.get(row.command) ?? 0) + 1);
 if (row.outcome !== 'ok') {
 errors.set(row.command, (errors.get(row.command) ?? 0) + 1);
 }
 totalMs += row.duration_ms;
 const list = durations.get(row.command) ?? [];
 list.push(row.duration_ms);
 durations.set(row.command, list);
 }
 const out: Array<{ metric: string; command: string; value: number }> = [];
 for (const [command, count] of executions) {
 out.push({ metric: 'commands', command, value: count });
 const errs = errors.get(command) ?? 0;
 if (errs > 0) out.push({ metric: 'errors', command, value: errs });
 // p95 per command, nearest-rank on the sorted durations.
 const sorted = (durations.get(command) ?? []).slice().sort((a, b) => a - b);
 if (sorted.length > 0) {
 const rank = Math.min(sorted.length, Math.max(1, Math.ceil(0.95 * sorted.length)));
 out.push({ metric: 'p95_ms', command, value: sorted[rank - 1]! });
 }
 }
 if (rows.length > 0) {
 out.push({ metric: 'commands', command: '', value: rows.length });
 out.push({ metric: 'unique_users', command: '', value: users.size });
 out.push({ metric: 'avg_ms', command: '', value: Math.round(totalMs / rows.length) });
 }
 return out;
}
/** One rollup attempt. B-39 catch-up: the window is the whole first hour
 * (00:05–00:59) instead of the single minute 00:05 — a deploy/crash at
 * exactly 00:05 used to silently skip the day. Each candidate day (yesterday
 * back CATCHUP_DAYS) is claimed individually via rollup:<day>, so an
 * unrolled day heals on any later tick within the window, and an already
 * rolled day is never redone. Returns ran:false outside the window / when
 * every candidate is already done. */
export const ROLLUP_CATCHUP_DAYS = 7;
export async function runDailyRollup(now: Date): Promise<RollupReport> {
 const idle: RollupReport = { ran: false, day: null, metrics: 0 };
 if (now.getUTCHours() !== ROLLUP_UTC_HOUR || now.getUTCMinutes() < ROLLUP_UTC_MINUTE) return idle;
 let last: RollupReport = idle;
 for (let back = 1; back <= ROLLUP_CATCHUP_DAYS; back += 1) {
 const dayDate = new Date(now);
 dayDate.setUTCDate(dayDate.getUTCDate() - back);
 const day = dayDate.toISOString().slice(0, 10);
 const attempt = await rollupOneDay(day, now);
 if (attempt.ran) last = attempt; // keep the LAST rolled day in the report
 }
 return last;
}
/** Roll (and claim) one day. Idempotent: the claim key rollup:<day> is the
 * done-marker, and the upserts are ON CONFLICT DO UPDATE, so a partial
 * rerun is safe. Failure releases the claim for the next tick. */
async function rollupOneDay(day: string, now: Date): Promise<RollupReport> {
 const dayAfter = new Date(`${day}T00:00:00Z`);
 dayAfter.setUTCDate(dayAfter.getUTCDate() + 1);
 const key = `rollup:${day}`;
 let claimed = false;
 try {
 claimed = await claim(key);
 if (!claimed) return { ran: false, day: null, metrics: 0 }; // already done (or in progress)
 const logs = await query<LogRow>(
 'SELECT discord_id, command, outcome, duration_ms FROM bot_command_log WHERE created_at >= $1 AND created_at < $2 LIMIT 10000',
 [`${day}T00:00:00Z`, dayAfter.toISOString()],
 );
 const aggregates = aggregateDay(logs.rows);
 for (const a of aggregates) {
 await query(
 `INSERT INTO bot_metrics_daily (day, metric, command, value) VALUES ($1, $2, $3, $4)
 ON CONFLICT (day, metric, command) DO UPDATE SET value = EXCLUDED.value`,
 [day, a.metric, a.command, a.value],
 );
 }
 // Retention prune rides the youngest rolled day's pass only.
 const cutoff = new Date(now);
 cutoff.setUTCDate(cutoff.getUTCDate() - RETENTION_DAYS);
 await query('DELETE FROM bot_command_log WHERE created_at < $1', [cutoff.toISOString()]);
 return { ran: true, day, metrics: aggregates.length };
 } catch (err) {
 if (claimed) {
 await release(key).catch(() => {
 // Key stays claimed → this day's rollup is skipped; the catch-up
 // window may retry it on a later tick if released, else tomorrow.
 });
 }
 return { ran: false, day, metrics: 0, error: err instanceof Error ? err.message : String(err) };
 }
}
