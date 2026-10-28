/**
 * S2-D06 — economy breach alerting.
 *
 * The three thresholds the packet names are already computed per stored day
 * by S2-D05's markBreaches (src/analytics/economy.ts): gini > 0.85, rolling
 * 7-day net supply delta > +15%, any single faucet > 25% of issuance in the
 * rolling 7-day window. This module turns those booleans into Discord alerts
 * with the delivery-alert discipline (S2-D03):
 *
 *   breach    — a newly-breaching key raises ONE alert (deduped durably via
 *               the economy_breach_state table — an in-memory dedupe would
 *               re-alert on every deploy, which is the loop the packet
 *               forbids); the window stays open until the metric recovers;
 *   recovery  — an alerted window whose key is no longer breaching posts ONE
 *               resolve and records resolved_at; a re-breach opens a NEW
 *               window and alerts again;
 *   silence   — with no webhook configured the sweep is armed but silent: it
 *               posts nothing and consumes nothing, so arming
 *               STAFF_ALERT_WEBHOOK_URL later alerts still-open breaches
 *               exactly once.
 *
 * Evaluation input: the STORED economy_daily_row series — the alert never
 * touches the game MySQL, so a game-DB outage can degrade the rollup without
 * degrading (or duplicating) the alerting. Cadence: the cron leg claims one
 * evaluation per UTC hour; the underlying rows change once a day, so an hour
 * of detection latency costs nothing and a failed pass self-heals on the next.
 *
 * Failure discipline: alerting must never take the cron down — the webhook
 * POST is bounded, never throws, and mentions never resolve.
 */
import { env } from '../env.js';
import { getD1 } from '../db/pool.js';
import { logger } from '../utils/logger.js';
import {
  BREACH_WINDOW_DAYS,
  ECONOMY_THRESHOLDS,
  listEconomyDailyRows,
  markBreaches,
  type EconomyDailyRow,
  type RowBreaches,
} from './economy.js';

/* ── Schema (mirrors migrations/d1_0007_economy_breach_state.sql) ─────────── */

export const ECONOMY_BREACH_SCHEMA = `
CREATE TABLE IF NOT EXISTS economy_breach_state (
  breach_key  TEXT PRIMARY KEY,
  breached_at INTEGER,
  alerted_at  INTEGER,
  last_value  REAL,
  resolved_at INTEGER,
  updated_at  INTEGER NOT NULL
)`;

let schemaEnsured = false;
export async function ensureEconomyBreachSchema(): Promise<void> {
  if (schemaEnsured) return;
  await getD1().prepare(ECONOMY_BREACH_SCHEMA).run();
  schemaEnsured = true;
}

/** Test hook — the next ensure runs for real again. */
export function __resetEconomyBreachSchemaForTests(): void {
  schemaEnsured = false;
}

/* ── Breach keys ──────────────────────────────────────────────────────────── */

export const GINI_KEY = 'gini';
export const NET_DELTA_KEY = 'net_delta';
export function faucetKey(reason: string): string {
  return `faucet:${reason}`;
}

/** The breach keys a row's breach booleans produce. Bounded by construction:
 *  faucet shares sum to 1, so at most 3 faucets can each exceed 25% — the
 *  key set per evaluation is at most 5 (gini + net_delta + 3 faucets). */
export function breachKeysOf(b: RowBreaches): string[] {
  const keys: string[] = [];
  if (b.gini) keys.push(GINI_KEY);
  if (b.net_delta) keys.push(NET_DELTA_KEY);
  for (const offender of b.faucet_offenders) keys.push(faucetKey(offender));
  return keys;
}

/** The metric behind a key, from the LATEST row/window (null = n/a). */
export function valueForKey(
  key: string,
  rows: EconomyDailyRow[],
  breaches: RowBreaches[],
): number | null {
  const lastRow = rows[rows.length - 1];
  const lastBreach = breaches[breaches.length - 1];
  if (!lastRow || !lastBreach) return null;
  if (key === GINI_KEY) return lastRow.gini;
  if (key === NET_DELTA_KEY) return lastBreach.weekly_net_delta;
  if (key.startsWith('faucet:')) {
    const reason = key.slice('faucet:'.length);
    const window = rows.slice(Math.max(0, rows.length - BREACH_WINDOW_DAYS));
    let total = 0;
    let mine = 0;
    for (const w of window) {
      for (const [reason_, amount] of Object.entries(w.issuance_by_faucet)) {
        total += amount;
        if (reason_ === reason) mine += amount;
      }
    }
    return total > 0 ? mine / total : null;
  }
  return null;
}

function pct(x: number | null): string {
  return x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`;
}

/* ── Discord transport — the same discipline as deliveryAlerts ────────────── */

function webhookUrl(): string {
  try {
    return env.staffAlertWebhookUrl || '';
  } catch {
    return (
      (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
        ?.STAFF_ALERT_WEBHOOK_URL ?? ''
    );
  }
}

async function postToStaffChannel(content: string): Promise<boolean> {
  const url = webhookUrl();
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content.slice(0, 1900), allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch (err) {
    logger.warn({ err: String(err) }, 'economy alerts: webhook post failed');
    return false;
  }
}

function breachMessage(key: string, rows: EconomyDailyRow[], breaches: RowBreaches[]): string {
  const day = rows[rows.length - 1]?.day ?? 'unknown';
  const value = valueForKey(key, rows, breaches);
  if (key === GINI_KEY) {
    return [
      `**[ECONOMY] Wealth concentration — gini ${value?.toFixed(3) ?? 'n/a'} (ceiling ${ECONOMY_THRESHOLDS.gini_max}) — ${day}**`,
      'The day\'s denarius gini crossed the alert ceiling. An overtuned faucet and a whale both land here — check /api/v2/admin/economy/faucets for the split.',
      'One alert per breach window; a resolve posts when the metric recovers.',
    ].join('\n');
  }
  if (key === NET_DELTA_KEY) {
    return [
      `**[ECONOMY] Supply growth — +${pct(value)} net this week (ceiling +${ECONOMY_THRESHOLDS.weekly_net_delta_max * 100}%) — ${day}**`,
      'The rolling 7-day net supply delta crossed the ceiling. Check issuance_by_faucet on /api/v2/admin/economy/snapshot for what is printing.',
      'One alert per breach window; a resolve posts when the metric recovers.',
    ].join('\n');
  }
  if (key.startsWith('faucet:')) {
    const reason = key.slice('faucet:'.length);
    return [
      `**[ECONOMY] Faucet concentration — \`${reason}\` — ${pct(value)} of issuance (ceiling ${ECONOMY_THRESHOLDS.faucet_share_max * 100}%) — ${day}**`,
      'One faucet is printing over a quarter of all issuance in the rolling 7-day window. In this genre an overtuned faucet and an actively exploited faucet look identical from the outside — both need the same response.',
      'One alert per breach window; a resolve posts when the metric recovers.',
    ].join('\n');
  }
  return `**[ECONOMY] Breach — ${key} — ${day}**`;
}

function resolveMessage(key: string, rows: EconomyDailyRow[], breaches: RowBreaches[]): string {
  const day = rows[rows.length - 1]?.day ?? 'unknown';
  const value = valueForKey(key, rows, breaches);
  return `**[ECONOMY] Resolved — ${key} back under threshold — ${day}** (latest value ${pct(value)}).`;
}

/* ── Durable window state ─────────────────────────────────────────────────── */

export interface BreachStateRow {
  breach_key: string;
  breached_at: number | null;
  alerted_at: number | null;
  last_value: number | null;
  resolved_at: number | null;
  updated_at: number;
}

async function loadBreachStates(): Promise<BreachStateRow[]> {
  await ensureEconomyBreachSchema();
  const res = await getD1()
    .prepare(
      `SELECT breach_key, breached_at, alerted_at, last_value, resolved_at, updated_at
         FROM economy_breach_state`,
    )
    .all<{
      breach_key: string;
      breached_at: number | null;
      alerted_at: number | null;
      last_value: number | null;
      resolved_at: number | null;
      updated_at: number;
    }>();
  return (res.results ?? []).map((r) => ({
    breach_key: String(r.breach_key),
    breached_at: r.breached_at === null ? null : Number(r.breached_at),
    alerted_at: r.alerted_at === null ? null : Number(r.alerted_at),
    last_value: r.last_value === null ? null : Number(r.last_value),
    resolved_at: r.resolved_at === null ? null : Number(r.resolved_at),
    updated_at: Number(r.updated_at),
  }));
}

/** Open (alert, or re-open after recovery) a breach window — an upsert that
 *  clears resolved_at so a re-breach after a resolve alerts again. */
async function markBreachAlerted(key: string, value: number | null, nowMs: number): Promise<void> {
  await ensureEconomyBreachSchema();
  await getD1()
    .prepare(
      `INSERT INTO economy_breach_state (breach_key, breached_at, alerted_at, last_value, resolved_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?)
       ON CONFLICT (breach_key) DO UPDATE SET
         breached_at = excluded.breached_at,
         alerted_at = excluded.alerted_at,
         last_value = excluded.last_value,
         resolved_at = NULL,
         updated_at = excluded.updated_at`,
    )
    .bind(key, nowMs, nowMs, value, nowMs)
    .run();
}

async function markBreachResolved(key: string, nowMs: number): Promise<void> {
  await ensureEconomyBreachSchema();
  await getD1()
    .prepare(
      `UPDATE economy_breach_state SET resolved_at = ?, updated_at = ? WHERE breach_key = ?`,
    )
    .bind(nowMs, nowMs, key)
    .run();
}

/* ── The sweep ────────────────────────────────────────────────────────────── */

export interface EconomyAlertReport {
  /** false when there were no stored rows to evaluate */
  evaluated: boolean;
  /** the day the evaluation looked at (null when there are no rows) */
  day: string | null;
  alerted: number;
  resolved: number;
  /** breach keys currently in an open breach window */
  open: string[];
  alertingConfigured: boolean;
  errors: number;
}

/** Per-pass ceilings — the key set is bounded at 5 by construction (see
 *  breachKeysOf), so these can never truncate a healthy pass; they exist so
 *  a pathological dataset cannot fan out into a webhook storm. */
const MAX_ALERTS_PER_PASS = 5;
const MAX_RESOLVES_PER_PASS = 10;

/**
 * One evaluation pass over the stored daily rows. Read failures are caught
 * and reported (errors:1, evaluated:false); a state WRITE failure propagates
 * — the cron leg's catch owns it, and the next hour's pass re-evaluates
 * idempotently (an alert already posted is deduped by the state row).
 */
export async function runEconomyAlertEvaluation(now: Date = new Date()): Promise<EconomyAlertReport> {
  const report: EconomyAlertReport = {
    evaluated: false,
    day: null,
    alerted: 0,
    resolved: 0,
    open: [],
    alertingConfigured: Boolean(webhookUrl()),
    errors: 0,
  };
  const nowMs = now.getTime();

  // Window + base row: the same slice markBreaches windows over, so the
  // evaluated booleans are exactly the snapshot endpoint's.
  let rows: EconomyDailyRow[];
  try {
    rows = await listEconomyDailyRows(BREACH_WINDOW_DAYS + 1);
  } catch (err) {
    logger.error({ err: String(err) }, 'economy alerts: daily-row read failed');
    report.errors = 1;
    return report;
  }
  if (rows.length === 0) return report; // nothing has ever folded — silent, honest

  const breaches = markBreaches(rows);
  const latest = breaches[breaches.length - 1]!;
  report.evaluated = true;
  report.day = rows[rows.length - 1]!.day;
  const activeKeys = breachKeysOf(latest);
  report.open = activeKeys;

  let states: BreachStateRow[];
  try {
    states = await loadBreachStates();
  } catch (err) {
    logger.error({ err: String(err) }, 'economy alerts: breach-state read failed');
    report.errors = 1;
    return report;
  }

  // RECOVERY first — an alerted window whose key no longer breaches closes
  // with one resolve. A never-alerted window (alerted_at NULL) closes
  // silently: there is nothing to resolve.
  for (const st of states) {
    if (st.alerted_at === null || st.resolved_at !== null) continue;
    if (activeKeys.includes(st.breach_key)) continue;
    if (report.resolved >= MAX_RESOLVES_PER_PASS) break;
    const sent = await postToStaffChannel(resolveMessage(st.breach_key, rows, breaches));
    if (sent) {
      await markBreachResolved(st.breach_key, nowMs);
      report.resolved++;
    } else if (report.alertingConfigured) {
      report.errors++;
    }
  }

  // BREACH — a newly-breaching key (no state, a resolved window, or an
  // armed-but-never-alerted one) alerts ONCE; an open already-alerted window
  // is the durable dedupe that stops the loop.
  for (const key of activeKeys) {
    const st = states.find((s) => s.breach_key === key);
    const inOpenAlertedWindow = st !== undefined && st.alerted_at !== null && st.resolved_at === null;
    if (inOpenAlertedWindow) continue;
    if (report.alerted >= MAX_ALERTS_PER_PASS) break;
    const sent = await postToStaffChannel(breachMessage(key, rows, breaches));
    if (sent) {
      await markBreachAlerted(key, valueForKey(key, rows, breaches), nowMs);
      report.alerted++;
    } else if (!report.alertingConfigured) {
      // Armed but silent: do NOT consume the breach — arming the webhook
      // later must still alert once on the still-open window.
    } else {
      // Configured but the post failed — retry next pass (still one alert
      // per breach window once it lands).
      report.errors++;
    }
  }

  if (report.alerted > 0 || report.resolved > 0) {
    logger.info(
      { day: report.day, alerted: report.alerted, resolved: report.resolved, open: report.open },
      'economy alerts: evaluation pass',
    );
  }
  return report;
}
