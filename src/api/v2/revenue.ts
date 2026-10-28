/**
 * S2-D09 — GET /api/v2/admin/revenue/summary.
 *
 * Shape per docs/season-2/API-CONTRACTS-S2.md: gross, refunds, chargebacks,
 * net, order counts, per-SKU breakdown, per-period (month|week). Money comes
 * from the PayNow Management API (no D1 table carries amounts — the payload
 * says so explicitly via d1_ledger.amounts_stored=false); an API failure is
 * served as money.available=false with the named reason next to the still-
 * truthful D1 block, never as fabricated zeros.
 *
 * Gated by the S2-D01 fail-closed RBAC at admin rank (real-money data —
 * stricter than the deliveries helper gate, same as the economy/retention
 * analytics).
 */
import { Hono } from 'hono';
import { buildRevenueSummary, type RevenueGranularity } from '../../analytics/revenue.js';
import { requireStaffRole } from '../../middleware/gates.js';
import { readRateLimit } from '../../middleware/rateLimit.js';
import type { AppContextVariables } from '../../types/index.js';

type ApiEnv = { Variables: AppContextVariables };

export const revenueV2 = new Hono<ApiEnv>();

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 'YYYY-MM-DD' or 400 — junk dates never silently become "all time". */
function parseDay(raw: string | undefined): string | undefined | 'invalid' {
  if (raw === undefined || raw === '') return undefined;
  if (!DAY_RE.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00.000Z`))) return 'invalid';
  return raw;
}

function parseGranularity(raw: string | undefined): RevenueGranularity | 'invalid' {
  if (raw === undefined || raw === '') return 'month'; // the contract's default view
  return raw === 'month' || raw === 'week' ? raw : 'invalid';
}

revenueV2.get('/admin/revenue/summary', readRateLimit, requireStaffRole('admin'), async (c) => {
  const granularity = parseGranularity(c.req.query('granularity'));
  if (granularity === 'invalid') {
    return c.json({ error: "Invalid 'granularity' (month|week)" }, 400);
  }
  const from = parseDay(c.req.query('from'));
  if (from === 'invalid') return c.json({ error: "Invalid 'from' (YYYY-MM-DD)" }, 400);
  const to = parseDay(c.req.query('to'));
  if (to === 'invalid') return c.json({ error: "Invalid 'to' (YYYY-MM-DD)" }, 400);

  try {
    const payload = await buildRevenueSummary({ granularity, from, to });
    return c.json(payload);
  } catch (err) {
    console.error(`[revenue] summary build failed: ${String(err)}`);
    return c.json({ error: 'Revenue summary unavailable' }, 503);
  }
});
