/**
 * S2-D07 — GET /api/v2/admin/retention/cohorts + /admin/retention/funnel.
 *
 * Shapes per docs/season-2/API-CONTRACTS-S2.md:
 *   cohorts — join-week cohorts (size, d1/d7/d30, by_source breakdown);
 *   funnel  — joined -> rank_ii -> rank_v -> first_purchase -> d7_return,
 *             absolute counts with stage-over-stage conversion.
 *
 * The join attribution field is `source` with 'direct' as the NEVER-null
 * default (the agreed cross-lane value; S2-E09 wires the frontend half
 * later — until then every synced row is 'direct', and ?source=direct is
 * the whole dataset by construction).
 *
 * Cohort windows that have not closed yet (a 3-day-old cohort's d30) are
 * null — a partial window is never presented as data. Gated by the S2-D01
 * fail-closed RBAC at admin rank.
 */
import { Hono } from 'hono';
import {
  computeCohorts,
  computeFunnel,
  FUNNEL_STAGES,
  loadActiveDays,
  loadFirstPurchases,
  listSeenRows,
  listChurnReasons,
  addDays,
  dayKey,
} from '../../analytics/retention.js';
import { requireStaffRole } from '../../middleware/gates.js';
import { readRateLimit } from '../../middleware/rateLimit.js';
import type { AppContextVariables } from '../../types/index.js';

type ApiEnv = { Variables: AppContextVariables };

export const retentionV2 = new Hono<ApiEnv>();

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 'YYYY-MM-DD' or 400 — junk dates never silently become "all time". */
function parseDay(raw: string | undefined): string | undefined | 'invalid' {
  if (raw === undefined || raw === '') return undefined;
  if (!DAY_RE.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00.000Z`))) return 'invalid';
  return raw;
}

retentionV2.get('/admin/retention/cohorts', readRateLimit, requireStaffRole('admin'), async (c) => {
  const from = parseDay(c.req.query('from'));
  if (from === 'invalid') return c.json({ error: "Invalid 'from' (YYYY-MM-DD)" }, 400);
  const to = parseDay(c.req.query('to'));
  if (to === 'invalid') return c.json({ error: "Invalid 'to' (YYYY-MM-DD)" }, 400);
  const source = c.req.query('source') || undefined;

  try {
    const players = await listSeenRows(source);
    // d30 needs presence up to joinDay+30, so the day window extends past `to`.
    const nowMs = Date.now();
    const dayFrom = from ?? dayKey(nowMs - 365 * 86_400_000);
    const dayTo = addDays(to ?? dayKey(nowMs), 35);
    const active = await loadActiveDays(dayFrom, dayTo);
    return c.json({
      cohorts: computeCohorts(players, active, { from, to, source, nowMs }),
    });
  } catch (err) {
    console.error(`[analytics] retention cohorts read failed: ${String(err)}`);
    return c.json({ error: 'Retention data unavailable' }, 503);
  }
});

retentionV2.get('/admin/retention/funnel', readRateLimit, requireStaffRole('admin'), async (c) => {
  const from = parseDay(c.req.query('from'));
  if (from === 'invalid') return c.json({ error: "Invalid 'from' (YYYY-MM-DD)" }, 400);
  const to = parseDay(c.req.query('to'));
  if (to === 'invalid') return c.json({ error: "Invalid 'to' (YYYY-MM-DD)" }, 400);
  const source = c.req.query('source') || undefined;

  try {
    const players = await listSeenRows(source);
    const nowMs = Date.now();
    const dayFrom = from ?? dayKey(nowMs - 365 * 86_400_000);
    const dayTo = addDays(to ?? dayKey(nowMs), 35);
    const active = await loadActiveDays(dayFrom, dayTo);
    const firstPurchases = await loadFirstPurchases();
    const funnel = computeFunnel(players, active, firstPurchases, { from, to, source, nowMs });
    return c.json({
      stages: funnel.stages,
      stage_order: [...FUNNEL_STAGES],
      pending_d7: funnel.pending_d7,
    });
  } catch (err) {
    console.error(`[analytics] retention funnel read failed: ${String(err)}`);
    return c.json({ error: 'Retention data unavailable' }, 503);
  }
});

/**
 * S2-C13 — GET /api/v2/admin/retention/churn-reasons?from=&to=
 *
 * "Why sessions end": the daily fold of the game MySQL's churn_reason_events
 * (one row per session end, the LAST meaningful event's type), grouped by
 * reason over the window. `none` is included so the ratio is honest — the
 * denominator is every session end, not just eventful ones. Unknown reason
 * values pass through as data (a newer plugin vocabulary on an older
 * backend is not a 500). Admin-gated + read-rate-limited like the other
 * retention reads; D1 failure is a 503, never a hang.
 */
retentionV2.get('/admin/retention/churn-reasons', readRateLimit, requireStaffRole('admin'), async (c) => {
  const from = parseDay(c.req.query('from'));
  if (from === 'invalid') return c.json({ error: "Invalid 'from' (YYYY-MM-DD)" }, 400);
  const to = parseDay(c.req.query('to'));
  if (to === 'invalid') return c.json({ error: "Invalid 'to' (YYYY-MM-DD)" }, 400);

  try {
    const nowMs = Date.now();
    // Default window: the fold's own lookback (30 days) — matching the data
    // that exists rather than an arbitrary year.
    const fromDay = from ?? dayKey(nowMs - 30 * 86_400_000);
    const toDay = to ?? dayKey(nowMs);
    return c.json(await listChurnReasons(fromDay, toDay));
  } catch (err) {
    console.error(`[analytics] churn-reasons read failed: ${String(err)}`);
    return c.json({ error: 'Retention data unavailable' }, 503);
  }
});
