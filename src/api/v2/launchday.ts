/**
 * S2-D08 — GET /api/v2/admin/launchday (+ the contract-doc alias
 * /api/v2/admin/ops/launch): the launch-day observability composite.
 *
 * ONE authenticated call returning the five sections in the triage order the
 * launch runbook reads them (docs/season-2/API-CONTRACTS-S2.md, "Deliberately
 * a single call so the launch-day page cannot half-load"):
 *
 *   error_rate  — the client crash-report intake (client_crash_reports,
 *                 d1_0003): rolling last hour + last 24h + top cause.
 *   tps         — HONESTLY NOT INSTRUMENTED. The plugin's bus publishes only
 *                 the online count (ONLINE_COUNT_KEY); nothing in src/
 *                 carries a TPS measurement (the bot's ServerStatus.tps is a
 *                 typed-optional field no backend source ever fills). Served
 *                 as null with sources.tps = 'not instrumented' — never
 *                 invented data.
 *   new_player_funnel — REUSES src/analytics/retention.ts (listSeenRows +
 *                 loadActiveDays + loadFirstPurchases + computeFunnel — the
 *                 exact /admin/retention/funnel logic over a ?days= join
 *                 window). Not a duplicate implementation.
 *   economy_snapshot  — REUSES src/analytics/economy.ts (listEconomyDailyRows
 *                 + markBreaches): the LATEST stored day, not the full
 *                 series (that is /admin/economy/snapshot's job).
 *   store_deliveries  — REUSES src/db/deliveryLedger.ts (listAllDeliveryLines
 *                 + effectiveStatus — pending-past-24h reads stale): counts
 *                 by status plus the triage list of not-delivered lines.
 *
 * Degradation: every section is computed independently and bounded by D1's
 * own latency; a section whose source fails is served as null with
 * sources.<name> = 'unavailable' — the page loads whole or not at all, and a
 * dead source is VISIBLE, never a silent zero.
 *
 * Gated by the S2-D01 fail-closed RBAC at admin rank.
 */
import { Hono } from 'hono';
import { listEconomyDailyRows, markBreaches, ECONOMY_THRESHOLDS } from '../../analytics/economy.js';
import {
  addDays,
  computeFunnel,
  dayKey,
  FUNNEL_STAGES,
  listSeenRows,
  loadActiveDays,
  loadFirstPurchases,
} from '../../analytics/retention.js';
import {
  effectiveStatus,
  listAllDeliveryLines,
  STALE_AFTER_MS,
  type DeliveryLineRow,
} from '../../db/deliveryLedger.js';
import { getD1 } from '../../db/pool.js';
import { requireStaffRole } from '../../middleware/gates.js';
import { readRateLimit } from '../../middleware/rateLimit.js';
import { logger } from '../../utils/logger.js';
import type { AppContextVariables } from '../../types/index.js';
import type { Context } from 'hono';

type ApiEnv = { Variables: AppContextVariables };

export const launchdayV2 = new Hono<ApiEnv>();

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const DEFAULT_FUNNEL_DAYS = 7;
const MAX_FUNNEL_DAYS = 90;
/** Triage list cap — the first N not-delivered lines, newest queued first. */
const TRIAGE_LIMIT = 5;

/**
 * Mirror of the intake's DDL (src/api/v2/crashReports.ts SCHEMA_STATEMENTS,
 * migrations/d1_0003_client_crash_reports.sql) — the reader ensures the table
 * exists so a launch-day page on a fresh D1 shows zeros, not a section error.
 * IF NOT EXISTS on both sides; parity is pinned by the launchday tests.
 */
const CRASH_REPORTS_MIRROR_SCHEMA = `
CREATE TABLE IF NOT EXISTS client_crash_reports (
  id text primary key,
  created_at integer not null,
  ip_hash text not null,
  launcher text not null,
  launcher_version text not null,
  client_version text,
  mc_version text,
  platform text not null,
  cause text not null,
  mod text,
  log_tail text not null,
  crash_report text
)`;
const CRASH_REPORTS_MIRROR_INDEX = 'CREATE INDEX IF NOT EXISTS idx_client_crash_reports_created ON client_crash_reports(created_at DESC)';

let crashSchemaEnsured = false;
/** Test hook — the next reader runs the mirror DDL for real again. */
export function __resetLaunchdaySchemaForTests(): void {
  crashSchemaEnsured = false;
}

/** The error_rate reader's ensure — exported for tests that seed the table. */
export async function ensureCrashReportsSchema(): Promise<void> {
  if (crashSchemaEnsured) return;
  const d1 = getD1();
  await d1.prepare(CRASH_REPORTS_MIRROR_SCHEMA).run();
  await d1.prepare(CRASH_REPORTS_MIRROR_INDEX).run();
  crashSchemaEnsured = true;
}

/* ── Section readers ──────────────────────────────────────────────────────── */

interface ErrorRateSection {
  errors_last_hour: number;
  errors_24h: number;
  /** Most common crash cause in the 24h window (null when quiet). */
  top_cause_24h: string | null;
}

async function readErrorRate(now: number): Promise<ErrorRateSection> {
  await ensureCrashReportsSchema();
  const d1 = getD1();
  const hour = await d1
    .prepare(`SELECT COUNT(*) AS n FROM client_crash_reports WHERE created_at >= ?`)
    .bind(now - HOUR_MS)
    .first<{ n: number }>();
  const day = await d1
    .prepare(`SELECT COUNT(*) AS n FROM client_crash_reports WHERE created_at >= ?`)
    .bind(now - DAY_MS)
    .first<{ n: number }>();
  const cause = await d1
    .prepare(
      `SELECT cause, COUNT(*) AS n FROM client_crash_reports WHERE created_at >= ? GROUP BY cause ORDER BY n DESC, cause ASC LIMIT 1`,
    )
    .bind(now - DAY_MS)
    .first<{ cause: string }>();
  return {
    errors_last_hour: Number(hour?.n ?? 0),
    errors_24h: Number(day?.n ?? 0),
    top_cause_24h: cause?.cause ?? null,
  };
}

async function readNewPlayerFunnel(now: number, windowDays: number) {
  // Reuse of the S2-D07 funnel — the same functions /admin/retention/funnel
  // serves through; the composite only narrows the join window.
  const players = await listSeenRows();
  const dayFrom = dayKey(now - (windowDays - 1) * DAY_MS);
  const dayTo = addDays(dayKey(now), 35); // d30 headroom, same as the retention route
  const active = await loadActiveDays(dayFrom, dayTo);
  const firstPurchases = await loadFirstPurchases();
  const funnel = computeFunnel(players, active, firstPurchases, { from: dayFrom, nowMs: now });
  return {
    window_days: windowDays,
    stages: funnel.stages,
    stage_order: [...FUNNEL_STAGES],
    pending_d7: funnel.pending_d7,
  };
}

async function readEconomySnapshot() {
  const rows = await listEconomyDailyRows(1);
  if (rows.length === 0) {
    // Honest empty: the analytics cron leg has not folded a day yet. Callers
    // see null + the sources marker, not a fabricated zero-economy.
    return null;
  }
  const latest = rows[rows.length - 1]!;
  const breaches = markBreaches(rows)[0]!;
  return {
    as_of: latest.day,
    total_supply: latest.total_supply,
    holder_count: latest.holder_count,
    gini: latest.gini,
    top1_share: latest.top1_share,
    net_delta: latest.net_delta,
    breaches,
    thresholds: { ...ECONOMY_THRESHOLDS },
  };
}

interface StoreDeliveriesSection {
  total_lines: number;
  by_status: { pending: number; delivered: number; failed: number; stale: number };
  /** Age of the oldest still-pending line in seconds (null when none). */
  oldest_pending_age_s: number | null;
  /** The S2-D03 breach threshold (a pending line older than this reads stale). */
  stale_after_s: number;
  /** First N not-delivered lines (failed/stale/pending), newest queued first. */
  triage: Array<{ order_id: string; line_key: string; product_id: string; status: string; queued_at: string }>;
}

async function readStoreDeliveries(now: number): Promise<StoreDeliveriesSection> {
  const lines: DeliveryLineRow[] = await listAllDeliveryLines();
  const byStatus = { pending: 0, delivered: 0, failed: 0, stale: 0 };
  let oldestPending: number | null = null;
  const triage: StoreDeliveriesSection['triage'] = [];
  for (const line of lines) {
    const status = effectiveStatus(line, now);
    byStatus[status] += 1;
    if (status === 'pending') {
      oldestPending = oldestPending === null ? line.queued_at : Math.min(oldestPending, line.queued_at);
    }
    if (status !== 'delivered' && triage.length < TRIAGE_LIMIT) {
      triage.push({
        order_id: line.order_id,
        line_key: line.line_key,
        product_id: line.product_id,
        status,
        queued_at: new Date(line.queued_at).toISOString(),
      });
    }
  }
  triage.sort((a, b) => Date.parse(b.queued_at) - Date.parse(a.queued_at));
  return {
    total_lines: lines.length,
    by_status: byStatus,
    oldest_pending_age_s:
      oldestPending === null ? null : Math.max(0, Math.floor((now - oldestPending) / 1000)),
    // A line pending past the 24h mark is the S2-D03 breach — surface the
    // threshold so the number is readable without opening the runbook.
    stale_after_s: Math.floor(STALE_AFTER_MS / 1000),
    triage,
  };
}

/* ── The composite ────────────────────────────────────────────────────────── */

interface Sectioned<T> {
  value: T | null;
  source: string;
}

/** One failing source must not take the page down — null + 'unavailable'. */
async function section<T>(name: string, source: string, read: () => Promise<T>): Promise<Sectioned<T>> {
  try {
    return { value: await read(), source };
  } catch (err) {
    logger.error({ err: String(err), section: name }, 'launchday: section source failed');
    return { value: null, source: 'unavailable' };
  }
}

async function launchdayHandler(c: Context<{ Variables: AppContextVariables }>): Promise<Response> {
  const now = Date.now();
  const daysRaw = c.req.query('days');
  let funnelDays = DEFAULT_FUNNEL_DAYS;
  if (daysRaw !== undefined && daysRaw !== '') {
    if (!/^\d+$/.test(daysRaw)) return c.json({ error: "Invalid 'days' (integer 1..90)" }, 400);
    funnelDays = Number.parseInt(daysRaw, 10);
    if (funnelDays < 1 || funnelDays > MAX_FUNNEL_DAYS) {
      return c.json({ error: `Invalid 'days' (integer 1..${MAX_FUNNEL_DAYS})` }, 400);
    }
  }

  const [errorRate, funnel, economy, deliveries] = await Promise.all([
    section('error_rate', 'client_crash_reports (launcher crash intake)', () => readErrorRate(now)),
    section('new_player_funnel', 'retention_player_seen/days (daily analytics fold)', () =>
      readNewPlayerFunnel(now, funnelDays),
    ),
    section('economy_snapshot', 'economy_daily_row (daily analytics fold)', readEconomySnapshot),
    section('store_deliveries', 'store_delivery_ledger', () => readStoreDeliveries(now)),
  ]);

  // Distinguish "the fold has not run yet" from a failed read on the economy
  // marker — an empty series is an honest state, not an outage.
  const economySource =
    economy.value === null && economy.source !== 'unavailable'
      ? 'economy_daily_row — no stored rows yet (the daily analytics fold has not run)'
      : economy.source;

  // Field order IS the contract: the triage order of the launch runbook.
  return c.json({
    generated_at: new Date(now).toISOString(),
    error_rate: errorRate.value,
    // Not instrumented anywhere (the plugin bus publishes only the online
    // count; no backend source ever fills the bot's ServerStatus.tps) —
    // null is the honest answer, never a synthesized number.
    tps: null,
    new_player_funnel: funnel.value,
    economy_snapshot: economy.value,
    store_deliveries: deliveries.value,
    sources: {
      error_rate: errorRate.source,
      tps: 'not instrumented',
      new_player_funnel: funnel.source,
      economy_snapshot: economySource,
      store_deliveries: deliveries.source,
    },
  });
}

// One handler, two paths: the task's URL and the contract doc's
// (docs/season-2/API-CONTRACTS-S2.md, Observability). Same payload.
launchdayV2.get('/admin/launchday', readRateLimit, requireStaffRole('admin'), launchdayHandler);
launchdayV2.get('/admin/ops/launch', readRateLimit, requireStaffRole('admin'), launchdayHandler);
