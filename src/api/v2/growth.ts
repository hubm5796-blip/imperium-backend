/**
 * S2-D12 (Lane D) — GET /api/v2/admin/growth/overview?from=&to=
 *
 * The owner-readable growth-metrics surface: ONE staff-gated call returning
 * the docs/season-2/06-MARKETING-AND-GROWTH.md §6 weekly table stitched from
 * the attribution store (E09), the retention fold (D07), and the Postgres
 * discord_links table. The aggregation + honest-empty/degradation contract
 * lives in analytics/growth.ts; this route is the gate + validation shell
 * (the churn-reasons pattern: read-rate-limited, admin-gated, junk dates
 * 400, default 30-day window, upstream failure degraded per-section — never
 * a hang). §6's cadence is weekly: pass ?from=<week start>&to=<week end>.
 */
import { Hono } from 'hono';
import { buildGrowthOverview, buildGrowthSnapshot } from '../../analytics/growth.js';
import { dayKey } from '../../analytics/retention.js';
import { requireStaffRole } from '../../middleware/gates.js';
import { readRateLimit } from '../../middleware/rateLimit.js';
import { swrJson } from '../expansion/cache.js';
import { logger } from '../../utils/logger.js';
import type { AppContextVariables } from '../../types/index.js';

type ApiEnv = { Variables: AppContextVariables };

export const growthV2 = new Hono<ApiEnv>();

const DAY_MS = 86_400_000;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 'YYYY-MM-DD' or 400 — junk dates never silently become "all time" (the
 *  retention reads' rule, mirrored). */
function parseDay(raw: string | undefined): string | undefined | 'invalid' {
  if (raw === undefined || raw === '') return undefined;
  if (!DAY_RE.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00.000Z`))) return 'invalid';
  return raw;
}

growthV2.get('/admin/growth/overview', readRateLimit, requireStaffRole('admin'), async (c) => {
  const from = parseDay(c.req.query('from'));
  if (from === 'invalid') return c.json({ error: "Invalid 'from' (YYYY-MM-DD)" }, 400);
  const to = parseDay(c.req.query('to'));
  if (to === 'invalid') return c.json({ error: "Invalid 'to' (YYYY-MM-DD)" }, 400);

  try {
    // Default window: 30 days, matching churn-reasons/attribution reads.
    // Intent rows only cover the last 48h (disclosed in the payload); the
    // durable history is claims + the retention fold.
    const nowMs = Date.now();
    const fromDay = from ?? dayKey(nowMs - 30 * DAY_MS);
    const toDay = to ?? dayKey(nowMs);
    return c.json(await buildGrowthOverview(fromDay, toDay, nowMs));
  } catch (err) {
    // The per-section readers already isolate source failures; this catch is
    // the last-resort bound (a non-source bug must 503, never hang).
    logger.warn({ err: String(err) }, 'growth: overview build failed');
    return c.json({ error: 'Growth data unavailable' }, 503);
  }
});

/**
 * S2-G02 — GET /api/v2/growth/snapshot.json: the PUBLIC compact snapshot the
 * transparency posts cite (and screenshot via the frontend /growth page).
 * Deliberately NOT staff-gated: every cell is a count or a rate — the fold's
 * per-player rows never cross this boundary (test-pinned). Anonymous-safe by
 * the same reasoning as the status page: concurrent/join counts are public
 * in-game facts. Served through the repo's public SWR cache (60s fresh /
 * 5min stale-while-revalidate / 24h serve-stale-on-error bridge + edge
 * cache + Cache-Control) — the leaderboards pattern, so a post going viral
 * cannot stampede the fold reads.
 */
growthV2.get('/growth/snapshot.json', readRateLimit, async (c) => {
  try {
    return await swrJson(c, 'growth-snapshot:v1', async () => buildGrowthSnapshot(Date.now()));
  } catch (err) {
    // buildGrowthSnapshot is per-section isolated; reaching this catch means
    // a non-source bug AND an empty cache — bound it, never hang.
    logger.warn({ err: String(err) }, 'growth: snapshot build failed');
    return c.json({ error: 'Growth snapshot unavailable' }, 503);
  }
});
