/**
 * S2-G02 — CCU (concurrent-player) sampling + reads for the public growth
 * snapshot. The backend had NO concurrent-count history: /api/server/status
 * answers "how many are online RIGHT NOW" (Redis bus_kv heartbeat, with the
 * Postgres/game-MySQL online_players snapshots as fallbacks) but nothing
 * ever stored a series, so "peak this week" — the number the transparency
 * posts want to cite — could not be answered honestly. This module adds the
 * smallest honest series: ONE D1 row per UTC day holding that day's sampled
 * MAX, updated by the every-minute bot cron (which is already fleet-claimed
 * per minute, so sampling cadence == cron cadence by construction).
 *
 * Reads reuse the SAME sources and the SAME bounded-wait doctrine as the
 * status route (Redis attempt ~1.4s, DB snapshots ~1.2s, fast-fail never
 * hang). The route itself is deliberately NOT refactored onto this helper:
 * /api/server/status is the liveness surface with its own memo + joinable
 * probe + names list; this chain is the count-only projection the snapshot
 * needs, and the two must not couple (its memo semantics are deliberate).
 *
 * Honesty rules (the queue row's acceptance rule, same as growth.ts):
 *   - a source that answers answers with its real number, 0 included —
 *     "live with 0 players" is a state, not an absence;
 *   - every source failing reads as null and the snapshot says so — a peak
 *     day with no successful samples is null, never 0-as-guess;
 *   - a sample is only recorded when a source actually answered.
 */
import { getD1, query } from '../db/pool.js';
import { gameQuery } from '../db/gameMysql.js';
import { getOnlinePlayerCount } from '../db/redis.js';
import { addDays, dayKey } from './retention.js';

const DAY_MS = 86_400_000;

/** Redis attempt bound — the status route's 700ms x2 fast-fail. */
const CCU_REDIS_TIMEOUT_MS = 1_400;
/** Snapshot-COUNT bounds — the status route's Postgres/MySQL 1.2s. */
const CCU_DB_TIMEOUT_MS = 1_200;

/** Bound an upstream wait; a rejection or timeout reads as "this source is
 * down" (null). The losing promise's later rejection is observed here, so
 * no dangling rejection can crash the isolate (the 1101 class). */
function withBound<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise.then(
      (v) => v,
      () => null,
    ),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/* ── Schema (mirrors migrations/d1_0011_ccu_daily_peak.sql) ──────────────── */

export const CCU_SCHEMA = `
CREATE TABLE IF NOT EXISTS ccu_daily_peak (
  day        TEXT PRIMARY KEY,
  peak       INTEGER NOT NULL,
  samples    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
)`;

let schemaEnsured = false;
export async function ensureCcuSchema(): Promise<void> {
  if (schemaEnsured) return;
  await getD1().prepare(CCU_SCHEMA).run();
  schemaEnsured = true;
}

export function __resetCcuSchemaForTests(): void {
  schemaEnsured = false;
}

/* ── Now-read: the count-only status chain, bounded ───────────────────────── */

export interface CcuNow {
  count: number;
  /** Which source answered — the payload's honesty marker. */
  source: 'redis-heartbeat' | 'postgres-snapshot' | 'game-mysql-snapshot';
}

/**
 * Live concurrent count via the status page's source order, each bounded:
 * Redis heartbeat first (the plugin writes it every 20s; PRESENT key means
 * the process is alive even at 0), then the two online_players snapshots.
 * All three failing → null (every caller treats that as "unknown", never 0).
 */
export async function readCcuNow(): Promise<CcuNow | null> {
  const redis = await withBound(getOnlinePlayerCount(), CCU_REDIS_TIMEOUT_MS);
  if (redis !== null) return { count: redis, source: 'redis-heartbeat' };
  const pg = await withBound(query<{ n: number }>('SELECT COUNT(*)::int AS n FROM online_players', []), CCU_DB_TIMEOUT_MS);
  if (pg && pg.rows.length > 0) return { count: Number(pg.rows[0]?.n ?? 0), source: 'postgres-snapshot' };
  const mysql = await withBound(
    gameQuery<{ n: number }>('SELECT COUNT(*) AS n FROM online_players', []),
    CCU_DB_TIMEOUT_MS,
  );
  if (mysql && mysql.length > 0) return { count: Number(mysql[0]?.n ?? 0), source: 'game-mysql-snapshot' };
  return null;
}

/* ── The daily peak series ────────────────────────────────────────────────── */

export interface CcuSampleReport {
  sampled: boolean;
  day: string;
  peak: number | null;
  pruned: boolean;
  error?: string;
}

/** Days kept beyond the 7-day read window before the hourly prune drops them. */
export const CCU_RETENTION_DAYS = 30;

/**
 * One cron tick's sample: read the live count, fold it into today's running
 * max. The upsert is a single atomic statement (MAX over the existing row and
 * the new value) — no read-modify-write, so overlapping cron passes can never
 * lose a peak. A null count records NOTHING (a day with zero successful
 * samples reads as null peak, not 0). The prune runs on the :00 minute tick
 * and keeps CCU_RETENTION_DAYS of history.
 */
export async function sampleCcuPeak(now: Date = new Date()): Promise<CcuSampleReport> {
  const day = dayKey(now.getTime());
  try {
    await ensureCcuSchema();
    const live = await readCcuNow();
    if (live === null) return { sampled: false, day, peak: null, pruned: false };
    await getD1()
      .prepare(
        `INSERT INTO ccu_daily_peak (day, peak, samples, updated_at) VALUES (?, ?, 1, ?)
           ON CONFLICT(day) DO UPDATE SET
             peak = MAX(ccu_daily_peak.peak, excluded.peak),
             samples = ccu_daily_peak.samples + 1,
             updated_at = excluded.updated_at`,
      )
      .bind(day, live.count, now.getTime())
      .run();
    let pruned = false;
    if (now.getUTCMinutes() === 0) {
      await getD1().prepare('DELETE FROM ccu_daily_peak WHERE day < ?').bind(addDays(day, -CCU_RETENTION_DAYS)).run();
      pruned = true;
    }
    const row = await getD1().prepare('SELECT peak FROM ccu_daily_peak WHERE day = ?').bind(day).first<{ peak: number }>();
    return { sampled: true, day, peak: row ? Number(row.peak) : live.count, pruned };
  } catch (err) {
    // Never throw — the cron leg isolates us anyway, but a half-failed tick
    // reports itself rather than taking the report down.
    return { sampled: false, day, peak: null, pruned: false, error: String(err) };
  }
}

/** Highest sampled peak across the 7 UTC days ending today (inclusive).
 * null when no day in the window has a sample — the honest pre-series answer. */
export async function readCcuPeak7d(nowMs: number = Date.now()): Promise<number | null> {
  await ensureCcuSchema();
  const fromDay = dayKey(nowMs - 6 * DAY_MS);
  const row = await getD1()
    .prepare('SELECT MAX(peak) AS peak FROM ccu_daily_peak WHERE day >= ?')
    .bind(fromDay)
    .first<{ peak: number | null }>();
  return row && row.peak !== null && row.peak !== undefined ? Number(row.peak) : null;
}
