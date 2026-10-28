/**
 * S2-D05 — the economy snapshot: STORED daily rows + the series reader.
 *
 * The plugin's WealthMonitor computes gini live, but nothing PERSISTED it —
 * the absence of history is why a 0.971 gini was a discovery rather than a
 * trend. This module is the durable half:
 *
 *   - pure math (gini, top-1% share, faucet/sink split, net delta) that the
 *     cron leg applies to one day's game-MySQL aggregates;
 *   - the D1 store: one row per UTC day, upserted (a recompute is
 *     idempotent), so history exists even on quiet days;
 *   - the snapshot payload builder per docs/season-2/API-CONTRACTS-S2.md,
 *     which also MARKS the S2-D06 breach booleans (gini > 0.85, weekly net
 *     supply delta > +15%, any faucet > 25% of issuance in the rolling
 *     7-day window) — every flag is computable from consecutive stored
 *     rows, which is exactly why the rows keep raw amounts, not just shares.
 *
 * Currency: denarius (the primary economy; routes.ts CURRENCY_ALIASES). The
 * game DB stores whole units (BIGINT, CHECK(balance >= 0)).
 */
import { getD1 } from '../db/pool.js';
import { logger } from '../utils/logger.js';

/* ── Schema (mirrors migrations/d1_0006_analytics.sql) ────────────────────── */

export const ECONOMY_SCHEMA = `
CREATE TABLE IF NOT EXISTS economy_daily_row (
  day                TEXT PRIMARY KEY,
  total_supply       INTEGER NOT NULL,
  holder_count       INTEGER NOT NULL,
  gini               REAL NOT NULL,
  top1_share         REAL NOT NULL,
  issued_total       INTEGER NOT NULL,
  drained_total      INTEGER NOT NULL,
  issuance_by_faucet TEXT NOT NULL,
  drain_by_sink      TEXT NOT NULL,
  net_delta_abs      INTEGER NOT NULL,
  net_delta          REAL NOT NULL,
  computed_at        TEXT NOT NULL DEFAULT (datetime('now'))
)`;

const ECONOMY_INDEXES = ['CREATE INDEX IF NOT EXISTS idx_edr_day ON economy_daily_row (day)'];

let schemaEnsured = false;
export async function ensureEconomySchema(): Promise<void> {
  if (schemaEnsured) return;
  const d1 = getD1();
  await d1.prepare(ECONOMY_SCHEMA).run();
  for (const idx of ECONOMY_INDEXES) await d1.prepare(idx).run();
  schemaEnsured = true;
}

/** Test hook — the next ensureSchema runs for real again. */
export function __resetEconomySchemaForTests(): void {
  schemaEnsured = false;
}

/* ── Pure math ────────────────────────────────────────────────────────────── */

/**
 * Gini coefficient of a balance distribution (population form). Sorted asc
 * x_1..x_n: gini = 2*Σ(i*x_i)/(n*Σx) - (n+1)/n. Equal balances → 0; one
 * holder owning everything → 1. Empty or zero-sum → 0 (no inequality to
 * measure, and never NaN — the series must stay chartable).
 */
export function giniOf(balances: number[]): number {
  const n = balances.length;
  if (n === 0) return 0;
  const sorted = [...balances].sort((a, b) => a - b);
  const total = sorted.reduce((acc, x) => acc + x, 0);
  if (total <= 0) return 0;
  let weighted = 0;
  for (let i = 0; i < n; i += 1) weighted += (i + 1) * sorted[i]!;
  return (2 * weighted) / (n * total) - (n + 1) / n;
}

/**
 * Share of total supply held by the top 1% of holders (ceil — a 40-holder
 * economy's top "1%" is its single richest holder). Empty/zero-sum → 0.
 */
export function top1ShareOf(balances: number[]): number {
  const n = balances.length;
  if (n === 0) return 0;
  const sorted = [...balances].sort((a, b) => a - b);
  const total = sorted.reduce((acc, x) => acc + x, 0);
  if (total <= 0) return 0;
  const topCount = Math.max(1, Math.ceil(n * 0.01));
  let top = 0;
  for (let i = n - topCount; i < n; i += 1) top += sorted[i]!;
  return top / total;
}

/** One reason's signed day total (denarius). */
export interface ReasonTotal {
  reason: string;
  amount: number;
}

export interface FaucetSinkSplit {
  /** amount > 0 reasons → absolute issued units. */
  issuance: Map<string, number>;
  /** amount < 0 reasons → absolute drained magnitude (positive numbers). */
  drain: Map<string, number>;
  issuedTotal: number;
  drainedTotal: number;
}

/** Split the day's per-reason sums into faucets (issuance) and sinks (drain). */
export function splitFaucetsSinks(rows: ReasonTotal[]): FaucetSinkSplit {
  const issuance = new Map<string, number>();
  const drain = new Map<string, number>();
  let issuedTotal = 0;
  let drainedTotal = 0;
  for (const row of rows) {
    const amount = Number(row.amount) || 0;
    if (amount > 0) {
      issuance.set(row.reason, (issuance.get(row.reason) ?? 0) + amount);
      issuedTotal += amount;
    } else if (amount < 0) {
      drain.set(row.reason, (drain.get(row.reason) ?? 0) + Math.abs(amount));
      drainedTotal += Math.abs(amount);
    }
  }
  return { issuance, drain, issuedTotal, drainedTotal };
}

/** {reason: absolute} → {reason: share-of-total}; total 0 → empty (never NaN). */
export function sharesOf(map: Map<string, number>): Record<string, number> {
  let total = 0;
  for (const v of map.values()) total += v;
  if (total <= 0) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of map) out[k] = v / total;
  return out;
}

/* ── Daily row ────────────────────────────────────────────────────────────── */

/** Alert thresholds (S2-D06 consumes; the snapshot response carries them). */
export const ECONOMY_THRESHOLDS = {
  gini_max: 0.85,
  weekly_net_delta_max: 0.15,
  faucet_share_max: 0.25,
} as const;

export interface EconomyDailyRow {
  day: string;
  total_supply: number;
  holder_count: number;
  gini: number;
  top1_share: number;
  issued_total: number;
  drained_total: number;
  issuance_by_faucet: Record<string, number>;
  drain_by_sink: Record<string, number>;
  net_delta_abs: number;
  net_delta: number;
  computed_at?: string;
}

/**
 * Build one day's row from that day's aggregates. `prevSupply` is the
 * previous stored day's total_supply (null on the first day → net_delta 0).
 */
export function buildDailyRow(
  day: string,
  balances: number[],
  reasonTotals: ReasonTotal[],
  prevSupply: number | null,
): EconomyDailyRow {
  const split = splitFaucetsSinks(reasonTotals);
  const totalSupply = balances.reduce((acc, x) => acc + Math.max(0, Number(x) || 0), 0);
  const netDeltaAbs = split.issuedTotal - split.drainedTotal;
  const netDelta = prevSupply !== null && prevSupply > 0 ? netDeltaAbs / prevSupply : 0;
  return {
    day,
    total_supply: totalSupply,
    holder_count: balances.length,
    gini: giniOf(balances),
    top1_share: top1ShareOf(balances),
    issued_total: split.issuedTotal,
    drained_total: split.drainedTotal,
    issuance_by_faucet: Object.fromEntries(split.issuance),
    drain_by_sink: Object.fromEntries(split.drain),
    net_delta_abs: netDeltaAbs,
    net_delta: netDelta,
  };
}

/** Upsert one day's row — a recompute is idempotent (cron catch-up safety). */
export async function saveEconomyDailyRow(row: EconomyDailyRow): Promise<void> {
  await ensureEconomySchema();
  await getD1()
    .prepare(
      `INSERT INTO economy_daily_row
         (day, total_supply, holder_count, gini, top1_share, issued_total, drained_total,
          issuance_by_faucet, drain_by_sink, net_delta_abs, net_delta, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (day) DO UPDATE SET
         total_supply = excluded.total_supply,
         holder_count = excluded.holder_count,
         gini = excluded.gini,
         top1_share = excluded.top1_share,
         issued_total = excluded.issued_total,
         drained_total = excluded.drained_total,
         issuance_by_faucet = excluded.issuance_by_faucet,
         drain_by_sink = excluded.drain_by_sink,
         net_delta_abs = excluded.net_delta_abs,
         net_delta = excluded.net_delta,
         computed_at = excluded.computed_at`,
    )
    .bind(
      row.day,
      row.total_supply,
      row.holder_count,
      row.gini,
      row.top1_share,
      row.issued_total,
      row.drained_total,
      JSON.stringify(row.issuance_by_faucet),
      JSON.stringify(row.drain_by_sink),
      row.net_delta_abs,
      row.net_delta,
      new Date().toISOString(),
    )
    .run();
}

interface StoredRow {
  day: string;
  total_supply: number;
  holder_count: number;
  gini: number;
  top1_share: number;
  issued_total: number;
  drained_total: number;
  issuance_by_faucet: string;
  drain_by_sink: string;
  net_delta_abs: number;
  net_delta: number;
  computed_at: string;
}

/** The newest `days` rows, ASCENDING by day (chart order). */
export async function listEconomyDailyRows(days: number): Promise<EconomyDailyRow[]> {
  await ensureEconomySchema();
  const res = await getD1()
    .prepare(
      `SELECT day, total_supply, holder_count, gini, top1_share, issued_total, drained_total,
              issuance_by_faucet, drain_by_sink, net_delta_abs, net_delta, computed_at
         FROM economy_daily_row
        ORDER BY day DESC
        LIMIT ?`,
    )
    .bind(days)
    .all<StoredRow>();
  // Newest-N in SQL, then reverse: every consumer (windows, prev-day chains,
  // as_of) treats index 0 as the OLDEST row of the series.
  return (res.results ?? []).reverse().map((r) => ({
    day: r.day,
    total_supply: Number(r.total_supply),
    holder_count: Number(r.holder_count),
    gini: Number(r.gini),
    top1_share: Number(r.top1_share),
    issued_total: Number(r.issued_total),
    drained_total: Number(r.drained_total),
    issuance_by_faucet: safeJson(r.issuance_by_faucet),
    drain_by_sink: safeJson(r.drain_by_sink),
    net_delta_abs: Number(r.net_delta_abs),
    net_delta: Number(r.net_delta),
    computed_at: r.computed_at,
  }));
}

function safeJson(raw: string): Record<string, number> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** One day's stored row (the cron leg's prev-supply lookup), or null. */
export async function getEconomyDailyRow(day: string): Promise<EconomyDailyRow | null> {
  await ensureEconomySchema();
  const row = await getD1()
    .prepare(
      `SELECT day, total_supply, holder_count, gini, top1_share, issued_total, drained_total,
              issuance_by_faucet, drain_by_sink, net_delta_abs, net_delta, computed_at
         FROM economy_daily_row WHERE day = ?`,
    )
    .bind(day)
    .first<StoredRow>();
  if (!row) return null;
  return {
    day: row.day,
    total_supply: Number(row.total_supply),
    holder_count: Number(row.holder_count),
    gini: Number(row.gini),
    top1_share: Number(row.top1_share),
    issued_total: Number(row.issued_total),
    drained_total: Number(row.drained_total),
    issuance_by_faucet: safeJson(row.issuance_by_faucet),
    drain_by_sink: safeJson(row.drain_by_sink),
    net_delta_abs: Number(row.net_delta_abs),
    net_delta: Number(row.net_delta),
    computed_at: row.computed_at,
  };
}

/* ── Breach marking (S2-D06 consumes these booleans) ─────────────────────── */

export interface RowBreaches {
  /** day gini > gini_max */
  gini: boolean;
  /** rolling 7-day net supply delta > weekly_net_delta_max */
  net_delta: boolean;
  /** weekly ratio actually computed (null when history is too short) */
  weekly_net_delta: number | null;
  /** any faucet > faucet_share_max of issuance in the rolling 7-day window */
  faucet: boolean;
  /** the offending reason strings (empty when no faucet breach) */
  faucet_offenders: string[];
}

/** The rolling breach window length, in stored rows (days). Exported so the
 *  S2-D06 alerting module evaluates the SAME window markBreaches does — one
 *  definition, no drift. */
export const BREACH_WINDOW_DAYS = 7;

/**
 * Mark breaches for every row of an ASCENDING series. The weekly windows end
 * at each row and look back 7 rows (fewer at the start of history); the
 * weekly ratio divides the window's absolute delta by the supply BEFORE the
 * window (null while that base is unknown — not computable is not breached).
 */
export function markBreaches(rows: EconomyDailyRow[]): RowBreaches[] {
  return rows.map((row, i) => {
    const windowStart = Math.max(0, i - (BREACH_WINDOW_DAYS - 1));
    const window = rows.slice(windowStart, i + 1);

    let weeklyAbs = 0;
    for (const w of window) weeklyAbs += w.net_delta_abs;
    const before = rows[windowStart - 1];
    // Base = supply BEFORE the window. With a preceding row, its supply is
    // exact; at the start of history the base is reconstructed as the first
    // window row's end-of-day supply minus its own delta (supply rows are
    // end-of-day). Only when even that is non-positive is the ratio
    // genuinely not computable — and not computable is not breached.
    const base = before
      ? before.total_supply
      : window[0]!.total_supply - window[0]!.net_delta_abs;
    const weekly = base > 0 ? weeklyAbs / base : null;

    const issuedByReason = new Map<string, number>();
    let issuedTotal = 0;
    for (const w of window) {
      for (const [reason, amount] of Object.entries(w.issuance_by_faucet)) {
        issuedByReason.set(reason, (issuedByReason.get(reason) ?? 0) + amount);
        issuedTotal += amount;
      }
    }
    const offenders: string[] = [];
    if (issuedTotal > 0) {
      for (const [reason, amount] of issuedByReason) {
        if (amount / issuedTotal > ECONOMY_THRESHOLDS.faucet_share_max) offenders.push(reason);
      }
    }

    return {
      gini: row.gini > ECONOMY_THRESHOLDS.gini_max,
      net_delta: weekly !== null && weekly > ECONOMY_THRESHOLDS.weekly_net_delta_max,
      weekly_net_delta: weekly,
      faucet: offenders.length > 0,
      faucet_offenders: offenders,
    };
  });
}

/* ── Contract payload ─────────────────────────────────────────────────────── */

export interface SnapshotSeriesEntry {
  date: string;
  total_supply: number;
  gini: number;
  top1_share: number;
  issuance_by_faucet: Record<string, number>;
  drain_by_sink: Record<string, number>;
  net_delta: number;
  breaches: RowBreaches;
}

export interface SnapshotPayload {
  as_of: string | null;
  series: SnapshotSeriesEntry[];
  thresholds: typeof ECONOMY_THRESHOLDS;
}

/**
 * The GET /admin/economy/snapshot payload for the newest `days` rows.
 *
 * net_delta is the day's net issuance FLOW (tx-summed) over the previous
 * stored day's supply — the same semantics the stored column and the
 * S2-D06 weekly threshold use. The oldest-first catch-up guarantees the
 * previous row exists before a day computes, so the stored value is always
 * final; the response serves it as-is.
 */
export function snapshotPayload(rows: EconomyDailyRow[]): SnapshotPayload {
  const breaches = markBreaches(rows);
  return {
    as_of: rows.length > 0 ? rows[rows.length - 1]!.day : null,
    series: rows.map((row, i) => ({
      date: row.day,
      total_supply: row.total_supply,
      gini: row.gini,
      top1_share: row.top1_share,
      // Contract: shares that sum to 1 (raw amounts stay in the stored row).
      issuance_by_faucet: sharesOf(new Map(Object.entries(row.issuance_by_faucet))),
      drain_by_sink: sharesOf(new Map(Object.entries(row.drain_by_sink))),
      net_delta: row.net_delta,
      breaches: breaches[i]!,
    })),
    thresholds: { ...ECONOMY_THRESHOLDS },
  };
}

/** Round to 6 decimals for stable JSON (shares/rates only, never units). */
export function r6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

export function logEconomyReadFailure(err: unknown): void {
  logger.error({ err: String(err) }, '[analytics] economy daily-row read failed');
}
