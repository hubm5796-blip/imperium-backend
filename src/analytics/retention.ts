/**
 * S2-D07 — retention instrumentation: per-account seen data, join-week
 * cohorts (d1/d7/d30), and the new-player funnel.
 *
 * Data model (migrations/d1_0006_analytics.sql, folded daily by
 * analytics/cronSync.ts from the game MySQL):
 *   - retention_player_seen  — one row per account: first_seen/last_seen,
 *     session count, playtime, current rank_level, join `source`
 *     ('direct' is the never-null default; the S2-E09 fold upgrades it from
 *     player_stats.join_source on first attribution, and once a real tag is
 *     set it is permanent — never null, never regressed);
 *   - retention_player_days  — one (uuid, UTC day) row per ACTIVE day. The
 *     feed today is DISTINCT economy_transactions days (every player earns
 *     within minutes of joining, so an economy day is a presence day); when
 *     the plugin reports join/quit sessions onto the bus the same leg folds
 *     those and the definition upgrades without a schema change.
 *
 * Retention definition (pinned, tested): dN = share of the cohort ACTIVE on
 * exactly day N after the join day (join day = day 0). A cohort younger than
 * N days reports null for dN — a partial window is never presented as data.
 *
 * Rank stages: rank II = rank_level >= 2, rank V = rank_level >= 5
 * (player_ranks.rank_level, folded into retention_player_seen by the sync).
 * first_purchase: the earliest store_delivery_ledger.queued_at per
 * customer_uuid — D1's own purchase evidence, no game-MySQL dependency.
 */
import { getD1 } from '../db/pool.js';
import { r6 } from './economy.js';

/* ── Schema (mirrors migrations/d1_0006_analytics.sql) ────────────────────── */

export const RETENTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS retention_player_seen (
  uuid              TEXT PRIMARY KEY,
  first_seen_ms     INTEGER NOT NULL,
  last_seen_ms      INTEGER NOT NULL,
  session_count     INTEGER NOT NULL DEFAULT 0,
  total_playtime_s  INTEGER NOT NULL DEFAULT 0,
  rank_level        INTEGER NOT NULL DEFAULT 1,
  source            TEXT NOT NULL DEFAULT 'direct',
  updated_at        INTEGER NOT NULL
)`;
export const RETENTION_DAYS_SCHEMA = `
CREATE TABLE IF NOT EXISTS retention_player_days (
  uuid TEXT NOT NULL,
  day  TEXT NOT NULL,
  PRIMARY KEY (uuid, day)
)`;

const RETENTION_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_rps_first_seen ON retention_player_seen (first_seen_ms)',
  'CREATE INDEX IF NOT EXISTS idx_rps_source ON retention_player_seen (source)',
  'CREATE INDEX IF NOT EXISTS idx_rpd_day ON retention_player_days (day)',
];

let schemaEnsured = false;
export async function ensureRetentionSchema(): Promise<void> {
  if (schemaEnsured) return;
  const d1 = getD1();
  await d1.prepare(RETENTION_SCHEMA).run();
  await d1.prepare(RETENTION_DAYS_SCHEMA).run();
  for (const idx of RETENTION_INDEXES) await d1.prepare(idx).run();
  schemaEnsured = true;
}

export function __resetRetentionSchemaForTests(): void {
  schemaEnsured = false;
}

/* ── Date helpers (all UTC) ───────────────────────────────────────────────── */

/** UTC 'YYYY-MM-DD' of an epoch ms. */
export function dayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Epoch ms of UTC midnight for a 'YYYY-MM-DD'. */
export function dayStartMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

/** 'YYYY-MM-DD' shifted by n days. */
export function addDays(day: string, n: number): string {
  const d = new Date(dayStartMs(day));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * ISO-8601 week key ('2026-W38'): the week (Mon–Sun) containing the year's
 * first Thursday is W01, so 2026-W01 spans 2025-12-29..2026-01-04. Long
 * years (Jan 1 Thursday, like 2026) carry a W53.
 */
export function isoWeekKey(ms: number): string {
  const d = new Date(ms);
  const utc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const day = new Date(utc); // strip time
  // ISO weekday: Monday = 1 .. Sunday = 7
  const isoDow = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
  // The Thursday of this date's week anchors the ISO year.
  const thursday = new Date(utc + (4 - isoDow) * 86_400_000);
  const isoYear = thursday.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const yearStartDow = new Date(yearStart).getUTCDay() === 0 ? 7 : new Date(yearStart).getUTCDay();
  const firstThursday = Date.UTC(isoYear, 0, 1 + ((4 - yearStartDow + 7) % 7));
  const week = Math.round((thursday.getTime() - firstThursday) / (7 * 86_400_000)) + 1;
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/* ── Rows ─────────────────────────────────────────────────────────────────── */

export interface SeenRow {
  uuid: string;
  first_seen_ms: number;
  last_seen_ms: number;
  session_count: number;
  total_playtime_s: number;
  rank_level: number;
  source: string;
}

interface StoredSeen {
  uuid: string;
  first_seen_ms: number;
  last_seen_ms: number;
  session_count: number;
  total_playtime_s: number;
  rank_level: number;
  source: string;
}

/** All seen rows (optionally one source), ascending by first_seen. */
export async function listSeenRows(source?: string): Promise<SeenRow[]> {
  await ensureRetentionSchema();
  const res = source
    ? await getD1()
        .prepare(
          `SELECT uuid, first_seen_ms, last_seen_ms, session_count, total_playtime_s, rank_level, source
             FROM retention_player_seen WHERE source = ? ORDER BY first_seen_ms ASC`,
        )
        .bind(source)
        .all<StoredSeen>()
    : await getD1()
        .prepare(
          `SELECT uuid, first_seen_ms, last_seen_ms, session_count, total_playtime_s, rank_level, source
             FROM retention_player_seen ORDER BY first_seen_ms ASC`,
        )
        .all<StoredSeen>();
  return (res.results ?? []).map((r) => ({
    uuid: r.uuid,
    first_seen_ms: Number(r.first_seen_ms),
    last_seen_ms: Number(r.last_seen_ms),
    session_count: Number(r.session_count),
    total_playtime_s: Number(r.total_playtime_s),
    rank_level: Number(r.rank_level),
    source: r.source,
  }));
}

/** uuid → set of active UTC days, for players with at least one day in the
 *  inclusive [fromDay, toDay] window (bounded — the analytics universe). */
export async function loadActiveDays(
  fromDay: string,
  toDay: string,
): Promise<Map<string, Set<string>>> {
  await ensureRetentionSchema();
  const res = await getD1()
    .prepare(
      `SELECT uuid, day FROM retention_player_days WHERE day >= ? AND day <= ? LIMIT 500000`,
    )
    .bind(fromDay, toDay)
    .all<{ uuid: string; day: string }>();
  const out = new Map<string, Set<string>>();
  for (const r of res.results ?? []) {
    let set = out.get(r.uuid);
    if (!set) {
      set = new Set<string>();
      out.set(r.uuid, set);
    }
    set.add(r.day);
  }
  return out;
}

/** uuid → earliest purchase ms, from the D1 delivery ledger's own customer
 *  evidence (the backend's purchase truth; no game dependency). */
export async function loadFirstPurchases(): Promise<Map<string, number>> {
  const res = await getD1()
    .prepare(
      `SELECT customer_uuid, MIN(queued_at) AS first_ms
         FROM store_delivery_ledger
        WHERE customer_uuid IS NOT NULL
        GROUP BY customer_uuid
        LIMIT 100000`,
    )
    .all<{ customer_uuid: string; first_ms: number }>();
  const out = new Map<string, number>();
  for (const r of res.results ?? []) out.set(r.customer_uuid, Number(r.first_ms));
  return out;
}

/* ── Write path (the cron leg's fold) ─────────────────────────────────────── */

/** One player's folded state from the game MySQL (cronSync.syncRetention).
 *  `source` is the S2-E09 join attribution (player_stats.join_source);
 *  omitted means 'direct'. */
export interface SeenUpsert {
  uuid: string;
  firstSeenMs: number;
  lastSeenMs: number;
  sessionCount: number;
  totalPlaytimeS: number;
  rankLevel: number;
  source?: string;
}

/**
 * Monotonic upsert: first_seen can only move EARLIER (a late onboarding row
 * must never push a player's join day forward), last_seen/session/playtime/
 * rank only move UP. `source` follows the S2-E09 first-attribution-wins
 * rule: written on INSERT, and on UPDATE only when the existing value is
 * 'direct' — a player's first attribution is permanent, so a later claim
 * (or a sync from before the plugin column existed) can neither rewrite
 * history nor regress an attributed row back to 'direct'. Returns the
 * number of rows written.
 */
export async function upsertSeenRows(rows: SeenUpsert[], nowMs: number): Promise<number> {
  await ensureRetentionSchema();
  const d1 = getD1();
  let written = 0;
  for (const r of rows) {
    await d1
      .prepare(
        `INSERT INTO retention_player_seen
           (uuid, first_seen_ms, last_seen_ms, session_count, total_playtime_s, rank_level, source, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (uuid) DO UPDATE SET
           first_seen_ms = MIN(retention_player_seen.first_seen_ms, excluded.first_seen_ms),
           last_seen_ms = MAX(retention_player_seen.last_seen_ms, excluded.last_seen_ms),
           session_count = MAX(retention_player_seen.session_count, excluded.session_count),
           total_playtime_s = MAX(retention_player_seen.total_playtime_s, excluded.total_playtime_s),
           rank_level = MAX(retention_player_seen.rank_level, excluded.rank_level),
           source = CASE
             WHEN retention_player_seen.source = 'direct' AND excluded.source <> 'direct'
             THEN excluded.source
             ELSE retention_player_seen.source
           END,
           updated_at = excluded.updated_at`,
      )
      .bind(r.uuid, r.firstSeenMs, r.lastSeenMs, r.sessionCount, r.totalPlaytimeS, r.rankLevel, r.source ?? 'direct', nowMs)
      .run();
    written += 1;
  }
  return written;
}

/** INSERT OR IGNORE presence days — idempotent across overlapping windows. */
export async function upsertActiveDays(days: Array<{ uuid: string; day: string }>): Promise<number> {
  await ensureRetentionSchema();
  const d1 = getD1();
  let written = 0;
  for (const d of days) {
    const res = await d1
      .prepare(`INSERT OR IGNORE INTO retention_player_days (uuid, day) VALUES (?, ?)`)
      .bind(d.uuid, d.day)
      .run();
    written += Number(res.meta?.changes ?? 0) > 0 ? 1 : 0;
  }
  return written;
}

/* ── Cohorts ─────────────────────────────────────────────────────────────── */

export interface CohortSlice {
  size: number;
  d1: number | null;
  d7: number | null;
  d30: number | null;
}

export interface Cohort extends CohortSlice {
  join_week: string;
  by_source: Record<string, CohortSlice>;
}

const RETENTION_LADDER = [1, 7, 30] as const;

/** dN rates for one player set; null while the window is still open. */
function ratesFor(
  players: SeenRow[],
  active: Map<string, Set<string>>,
  nowMs: number,
): CohortSlice {
  const size = players.length;
  const rates: { d1: number | null; d7: number | null; d30: number | null } = {
    d1: null,
    d7: null,
    d30: null,
  };
  if (size === 0) return { size: 0, d1: null, d7: null, d30: null };
  for (const n of RETENTION_LADDER) {
    const matured = players.filter((p) => dayStartMs(addDays(dayKey(p.first_seen_ms), n)) <= nowMs);
    if (matured.length < size) continue; // window not closed for the whole cohort → null
    let returned = 0;
    for (const p of matured) {
      if (active.get(p.uuid)?.has(addDays(dayKey(p.first_seen_ms), n))) returned += 1;
    }
    rates[`d${n}` as 'd1' | 'd7' | 'd30'] = r6(returned / size);
  }
  return { size, ...rates };
}

export interface CohortOptions {
  from?: string; // inclusive join-day bounds ('YYYY-MM-DD')
  to?: string;
  source?: string;
  nowMs: number;
}

/**
 * Join-week cohorts. `players` pre-filtered by source when a ?source= is
 * given (the reader does it in SQL); from/to bound the join day.
 */
export function computeCohorts(
  players: SeenRow[],
  active: Map<string, Set<string>>,
  opts: CohortOptions,
): Cohort[] {
  const inWindow = players.filter((p) => {
    const joinDay = dayKey(p.first_seen_ms);
    if (opts.from && joinDay < opts.from) return false;
    if (opts.to && joinDay > opts.to) return false;
    return true;
  });
  const byWeek = new Map<string, SeenRow[]>();
  for (const p of inWindow) {
    const week = isoWeekKey(p.first_seen_ms);
    const bucket = byWeek.get(week);
    if (bucket) bucket.push(p);
    else byWeek.set(week, [p]);
  }
  const cohorts: Cohort[] = [];
  for (const [week, bucket] of [...byWeek.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const bySource: Record<string, CohortSlice> = {};
    const sources = [...new Set(bucket.map((p) => p.source))].sort();
    for (const src of sources) {
      bySource[src] = ratesFor(
        bucket.filter((p) => p.source === src),
        active,
        opts.nowMs,
      );
    }
    cohorts.push({ join_week: week, ...ratesFor(bucket, active, opts.nowMs), by_source: bySource });
  }
  return cohorts;
}

/* ── Funnel ──────────────────────────────────────────────────────────────── */

export const FUNNEL_STAGES = ['joined', 'rank_ii', 'rank_v', 'first_purchase', 'd7_return'] as const;
export type FunnelStageName = (typeof FUNNEL_STAGES)[number];

export interface FunnelStage {
  stage: FunnelStageName;
  /** Absolute count of the joined population that reached this stage. */
  count: number;
  /** Stage-over-stage conversion (null on `joined` — there is no previous). */
  conversion: number | null;
}

export interface FunnelResult {
  stages: FunnelStage[];
  /** Joined players whose day-7 window has not closed yet (honest
   *  denominator context for the d7_return stage). */
  pending_d7: number;
}

export interface FunnelOptions {
  from?: string;
  to?: string;
  source?: string; // applied by the reader (SQL) — retained for symmetry
  nowMs: number;
}

/**
 * joined -> rank_ii -> rank_v -> first_purchase -> d7_return, absolute
 * counts and stage-over-stage conversion. Ranks come from the folded
 * rank_level (II = >= 2, V = >= 5); first_purchase from the delivery
 * ledger's earliest queued_at per uuid; d7_return = active on exactly
 * join-day + 7.
 */
export function computeFunnel(
  players: SeenRow[],
  active: Map<string, Set<string>>,
  firstPurchaseMs: Map<string, number>,
  opts: FunnelOptions,
): FunnelResult {
  const joined = players.filter((p) => {
    const joinDay = dayKey(p.first_seen_ms);
    if (opts.from && joinDay < opts.from) return false;
    if (opts.to && joinDay > opts.to) return false;
    return true;
  });

  const rankIi = joined.filter((p) => p.rank_level >= 2);
  const rankV = rankIi.filter((p) => p.rank_level >= 5);
  const purchased = rankV.filter((p) => firstPurchaseMs.has(p.uuid));
  const d7Ready: SeenRow[] = [];
  const d7Returned: SeenRow[] = [];
  let pending = 0;
  for (const p of purchased) {
    const d7Day = addDays(dayKey(p.first_seen_ms), 7);
    if (dayStartMs(d7Day) > opts.nowMs) {
      pending += 1;
      continue;
    }
    d7Ready.push(p);
    if (active.get(p.uuid)?.has(d7Day)) d7Returned.push(p);
  }

  const conv = (num: number, den: number): number | null => (den > 0 ? r6(num / den) : null);
  const stages: FunnelStage[] = [
    { stage: 'joined', count: joined.length, conversion: null },
    { stage: 'rank_ii', count: rankIi.length, conversion: conv(rankIi.length, joined.length) },
    { stage: 'rank_v', count: rankV.length, conversion: conv(rankV.length, rankIi.length) },
    {
      stage: 'first_purchase',
      count: purchased.length,
      conversion: conv(purchased.length, rankV.length),
    },
    {
      stage: 'd7_return',
      count: d7Returned.length,
      conversion: conv(d7Returned.length, purchased.length),
    },
  ];
  return { stages, pending_d7: pending };
}
