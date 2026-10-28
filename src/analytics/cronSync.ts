/**
 * S2-D05/S2-D07 — the ONE daily analytics cron leg.
 *
 * Economy (S2-D05): aggregates the just-finished UTC day ONCE — total
 * supply, gini, top-1% share, per-reason issuance/drain, net delta — from
 * the game MySQL (currency_balances + economy_transactions, the same
 * source-of-truth the plugin's EconomyService writes) into a STORED D1 row
 * (economy_daily_row). History therefore exists even on quiet days; the
 * row is the thing /admin/economy/snapshot serves and S2-D06 alerts from.
 *
 * Retention (S2-D07): folds the same game MySQL's player_stats
 * (last_join/last_quit/join_count), player_ranks (rank_level),
 * player_playtime and onboarding_state (first_seen) into
 * retention_player_seen (upserts are monotonic — first_seen can only move
 * earlier, rank/session/playtime only up), and DISTINCT
 * economy_transactions days into retention_player_days (presence days).
 * `source` stays 'direct' until Lane E's S2-E09 attribution lands.
 *
 * Discipline (the rollup leg's, 02-09): the window is the whole
 * 00:06–00:59 UTC hour with a 7-day catch-up; each candidate day is claimed
 * individually (analytics-econ:<day> / analytics-retention:<day>); a
 * failure RELEASES the claim so a later tick retries; the writes are
 * upserts, so a partial rerun is safe. The leg never throws — the cron
 * report carries what happened.
 */
import { gameQuery } from '../db/gameMysql.js';
import { claim, release } from '../bot/botdb.js';
import { logger } from '../utils/logger.js';
import {
  buildDailyRow,
  getEconomyDailyRow,
  saveEconomyDailyRow,
  type ReasonTotal,
} from './economy.js';
import { upsertSeenRows, upsertActiveDays, type SeenUpsert } from './retention.js';

export const ANALYTICS_ROLLUP_UTC_HOUR = 0;
export const ANALYTICS_ROLLUP_UTC_MINUTE = 6; // after the bot-metrics rollup (00:05)
export const ANALYTICS_CATCHUP_DAYS = 7;

/** The denarius ledger — the primary economy the snapshot tracks. */
export const PRIMARY_CURRENCY = 'denarius';

/** Hard row caps — a daily job must never scan unbounded. */
const MAX_BALANCE_ROWS = 200_000;
const MAX_PLAYER_ROWS = 20_000;
const MAX_DAY_ROWS = 100_000;

export interface AnalyticsReport {
  economy: { ran: boolean; day: string | null; error?: string };
  retention: { ran: boolean; players: number; days: number; error?: string };
}

/** MySQL 'YYYY-MM-DD HH:MM:SS' (UTC) for a day boundary. */
function mysqlDay(day: string): string {
  return `${day} 00:00:00`;
}

function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Parse a game-MySQL timestamp (string, Date, or epoch) → ms, UTC. */
export function parseGameTs(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? (value < 1e12 ? value * 1000 : value) : null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return n > 1e12 ? n : n * 1000; // epoch s vs ms
  }
  const normalized = raw.includes('T') ? raw : `${raw.replace(' ', 'T')}Z`;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Aggregate one finished day from the game MySQL and store the D1 row.
 * Throws on upstream failure — the caller owns claim/release.
 */
export async function rollupEconomyDay(day: string): Promise<void> {
  const balanceRows = await gameQuery<{ balance: string | number }>(
    `SELECT balance FROM currency_balances WHERE currency = ?
      ORDER BY CAST(balance AS UNSIGNED) DESC
      LIMIT ${MAX_BALANCE_ROWS}`,
    [PRIMARY_CURRENCY],
  );
  const balances = balanceRows.map((r) => Number(r.balance) || 0);

  const txRows = await gameQuery<{ reason: string; amount: string | number }>(
    `SELECT reason, SUM(CAST(amount AS SIGNED)) AS amount
       FROM economy_transactions
      WHERE currency = ? AND timestamp >= ? AND timestamp < ?
      GROUP BY reason`,
    [PRIMARY_CURRENCY, mysqlDay(day), mysqlDay(nextDay(day))],
  );
  const reasonTotals: ReasonTotal[] = txRows.map((r) => ({
    reason: String(r.reason ?? 'unknown'),
    amount: Number(r.amount) || 0,
  }));

  const prev = await getEconomyDailyRow(prevDay(day));
  const row = buildDailyRow(day, balances, reasonTotals, prev ? prev.total_supply : null);
  await saveEconomyDailyRow(row);
}

function prevDay(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Fold the game MySQL's player state + recent presence into the retention
 * tables. Monotonic upserts; throws on upstream failure.
 */
export async function syncRetention(nowMs: number): Promise<{ players: number; days: number }> {
  const since = new Date(nowMs - 30 * 86_400_000);
  const playerRows = await gameQuery<{
    uuid: string;
    join_count: number;
    last_join: unknown;
    last_quit: unknown;
    rank_level: number;
    total_secs: number;
    first_seen: unknown;
  }>(
    `SELECT ps.uuid,
            ps.join_count,
            ps.last_join,
            ps.last_quit,
            COALESCE(pr.rank_level, 1) AS rank_level,
            (SELECT total_secs FROM player_playtime WHERE uuid = ps.uuid LIMIT 1) AS total_secs,
            (SELECT first_seen FROM onboarding_state WHERE player_uuid = ps.uuid LIMIT 1) AS first_seen
       FROM player_stats ps
      WHERE ps.uuid IN (
            SELECT DISTINCT uuid FROM economy_transactions
             WHERE timestamp >= ? LIMIT ${MAX_PLAYER_ROWS})
      LIMIT ${MAX_PLAYER_ROWS}`,
    [since.toISOString().slice(0, 19).replace('T', ' ')],
  );

  const seen: SeenUpsert[] = [];
  for (const r of playerRows) {
    const candidates = [parseGameTs(r.first_seen), parseGameTs(r.last_join), parseGameTs(r.last_quit)].filter(
      (v): v is number => v !== null,
    );
    if (candidates.length === 0) continue; // no trustworthy time anchor — skip, never fabricate
    const firstSeen = Math.min(...candidates);
    const lastSeen = Math.max(...candidates);
    seen.push({
      uuid: String(r.uuid),
      firstSeenMs: firstSeen,
      lastSeenMs: lastSeen,
      sessionCount: Number(r.join_count) || 0,
      totalPlaytimeS: Math.max(0, Number(r.total_secs) || 0),
      rankLevel: Math.max(1, Number(r.rank_level) || 1),
    });
  }
  const players = seen.length > 0 ? await upsertSeenRows(seen, nowMs) : 0;

  // Presence days: the recent window (the finished day + late arrivals).
  const from = new Date(nowMs - 2 * 86_400_000);
  const dayRows = await gameQuery<{ uuid: string; day: string }>(
    `SELECT DISTINCT uuid, DATE(timestamp) AS day
       FROM economy_transactions
      WHERE timestamp >= ? AND timestamp <= ?
      LIMIT ${MAX_DAY_ROWS}`,
    [mysqlDay(from.toISOString().slice(0, 10)), mysqlDay(new Date(nowMs).toISOString().slice(0, 10))],
  );
  const days = dayRows.length > 0 ? await upsertActiveDays(dayRows.map((r) => ({ uuid: String(r.uuid), day: String(r.day) }))) : 0;
  return { players, days };
}

/**
 * The cron leg. ran:true only when real work happened; every failure is
 * reported, never thrown.
 */
export async function runAnalyticsDaily(now: Date): Promise<AnalyticsReport> {
  const report: AnalyticsReport = {
    economy: { ran: false, day: null },
    retention: { ran: false, players: 0, days: 0 },
  };
  if (now.getUTCHours() !== ANALYTICS_ROLLUP_UTC_HOUR || now.getUTCMinutes() < ANALYTICS_ROLLUP_UTC_MINUTE) {
    return report;
  }

  // OLDEST-first: net_delta chains on the previous day's stored supply, so
  // a catch-up burst must materialize earlier days before later ones (the
  // bot-metrics rollup has no cross-day dependency; this leg does).
  for (let back = ANALYTICS_CATCHUP_DAYS; back >= 1; back -= 1) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - back);
    const day = d.toISOString().slice(0, 10);
    const key = `analytics-econ:${day}`;
    let claimed = false;
    try {
      claimed = await claim(key);
      if (!claimed) continue;
      await rollupEconomyDay(day);
      report.economy = { ran: true, day };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message, day }, 'cron: analytics economy rollup failed');
      report.economy = { ran: false, day, error: message };
      if (claimed) await release(key).catch(() => undefined); // retry on a later tick
      break; // game MySQL down — stop hammering it this pass
    }
  }

  // Retention fold: once per pass (a state sync, not a per-day rollup).
  const rKey = `analytics-retention:${new Date(now).toISOString().slice(0, 10)}`;
  let rClaimed = false;
  try {
    rClaimed = await claim(rKey);
    if (rClaimed) {
      const out = await syncRetention(now.getTime());
      report.retention = { ran: true, ...out };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err: message }, 'cron: analytics retention sync failed');
    report.retention = { ran: false, players: 0, days: 0, error: message };
    if (rClaimed) await release(rKey).catch(() => undefined);
  }
  return report;
}
