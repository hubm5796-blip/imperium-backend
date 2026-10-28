/**
 * S2-D05 — GET /api/v2/admin/economy/snapshot + /admin/economy/faucets.
 *
 * Shapes per docs/season-2/API-CONTRACTS-S2.md: the snapshot serves the
 * STORED daily rows (economy_daily_row — the cron leg aggregates each day
 * once, so history exists even on quiet days) and marks the S2-D06 breach
 * booleans; the faucets view is the per-reason 7-day issuance rollup with
 * the registry ceiling left honestly null until Lane A's faucet registry
 * (S2-A02/A09) exists — an unregistered key appearing here is itself a
 * finding, so the raw reason keys are served verbatim.
 *
 * Gated by the S2-D01 fail-closed RBAC at admin rank (read-only analytics
 * over the whole economy; stricter than deliveries' helper gate on purpose).
 */
import { Hono } from 'hono';
import {
  ECONOMY_THRESHOLDS,
  listEconomyDailyRows,
  logEconomyReadFailure,
  r6,
  snapshotPayload,
  type EconomyDailyRow,
} from '../../analytics/economy.js';
import { requireStaffRole } from '../../middleware/gates.js';
import { readRateLimit } from '../../middleware/rateLimit.js';
import type { AppContextVariables } from '../../types/index.js';

type ApiEnv = { Variables: AppContextVariables };

export const economyV2 = new Hono<ApiEnv>();

const DEFAULT_DAYS = 90;
const MAX_DAYS = 365;

/** ?days= — integer 1..365, default 90; junk is a 400, never a silent default. */
function parseDays(raw: string | undefined): number | 'invalid' {
  if (raw === undefined || raw === '') return DEFAULT_DAYS;
  if (!/^\d+$/.test(raw)) return 'invalid';
  const n = Number.parseInt(raw, 10);
  if (n < 1 || n > MAX_DAYS) return 'invalid';
  return n;
}

economyV2.get('/admin/economy/snapshot', readRateLimit, requireStaffRole('admin'), async (c) => {
  const days = parseDays(c.req.query('days'));
  if (days === 'invalid') {
    return c.json({ error: `Invalid 'days' (integer 1..${MAX_DAYS})` }, 400);
  }
  try {
    const rows: EconomyDailyRow[] = await listEconomyDailyRows(days);
    return c.json(snapshotPayload(rows));
  } catch (err) {
    logEconomyReadFailure(err);
    return c.json({ error: 'Economy snapshot unavailable' }, 503);
  }
});

economyV2.get('/admin/economy/faucets', readRateLimit, requireStaffRole('admin'), async (c) => {
  const days = parseDays(c.req.query('days'));
  if (days === 'invalid') {
    return c.json({ error: `Invalid 'days' (integer 1..${MAX_DAYS})` }, 400);
  }
  try {
    const rows = await listEconomyDailyRows(Math.max(days, 7));
    // The contract's faucet view: 7-day issuance per reason, its share, the
    // registry ceiling (null — Lane A's registry is the authority and does
    // not exist yet) and the 90-day breach-day count per reason.
    const window = rows.slice(-7);
    const issued = new Map<string, number>();
    let total = 0;
    for (const row of window) {
      for (const [reason, amount] of Object.entries(row.issuance_by_faucet)) {
        issued.set(reason, (issued.get(reason) ?? 0) + amount);
        total += amount;
      }
    }
    const breachDays = new Map<string, number>();
    for (const row of rows) {
      const dayTotal = Object.values(row.issuance_by_faucet).reduce((a, b) => a + b, 0);
      if (dayTotal <= 0) continue;
      for (const [reason, amount] of Object.entries(row.issuance_by_faucet)) {
        if (amount / dayTotal > ECONOMY_THRESHOLDS.faucet_share_max) {
          breachDays.set(reason, (breachDays.get(reason) ?? 0) + 1);
        }
      }
    }
    const faucets = [...issued.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, amount]) => ({
        faucet: reason,
        issued_7d: amount,
        share_7d: total > 0 ? r6(amount / total) : null,
        registry_ceiling: null,
        breach_days: breachDays.get(reason) ?? 0,
      }));
    return c.json({
      window_days: 7,
      issued_total_7d: total,
      thresholds: { ...ECONOMY_THRESHOLDS },
      faucets,
    });
  } catch (err) {
    logEconomyReadFailure(err);
    return c.json({ error: 'Economy faucet view unavailable' }, 503);
  }
});
