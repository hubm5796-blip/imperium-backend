// 12a expansion: GET /api/economy/flow-summary — PUBLIC-SAFE faucet/sink view.
//
// The full flow ledger is sensitive (total money supply, per-player behavior);
// this endpoint deliberately exposes SHARES ONLY — each reason's fraction of
// total faucet (money minted) and sink (money destroyed) volume for the
// window. No absolute amounts, no per-player rows, ever.
//
// Data sources, in order:
//  1. economy_flow_hourly — the specced pre-aggregated table (plugin owns it;
//     not created yet at time of writing).
//  2. economy_transactions — LIVE ledger (one row per currency movement).
//     Aggregating it directly keeps the endpoint live today; it costs one
//     indexed scan over the window and is cached 60s anyway.
import { Hono } from 'hono';
import { readRateLimit } from '../../middleware/rateLimit.js';
import { botTokenMatches } from '../../middleware/auth.js';
import { query } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { swrJson } from './cache.js';
import type { AppContextVariables } from '../../types/index.js';

type ApiEnv = { Variables: AppContextVariables };

export const economyApi = new Hono<ApiEnv>();

const FLOW_WINDOWS: Record<string, number> = {
  '24h': 24,
  '7d': 24 * 7,
};

interface FlowRow {
  direction: 'faucet' | 'sink';
  reason: string;
  total: string;
}

interface FlowSummary {
  window: string;
  source: 'economy_flow_hourly' | 'economy_transactions';
  /** Reasons whose share of the direction's total is < 0.5% are collapsed here. */
  faucet: Array<{ reason: string; share: number }>;
  sink: Array<{ reason: string; share: number }>;
  faucetOtherShare: number;
  sinkOtherShare: number;
}

const OTHER_COLLAPSE_THRESHOLD = 0.005;

/** Turn raw per-reason totals into shares (fractions of the direction total, 4dp). */
function toShares(rows: FlowRow[], direction: 'faucet' | 'sink'): {
  shares: Array<{ reason: string; share: number }>;
  otherShare: number;
} {
  const totals = new Map<string, number>();
  let grand = 0;
  for (const row of rows) {
    if (row.direction !== direction) continue;
    const value = Number(row.total ?? 0);
    if (value <= 0) continue;
    totals.set(row.reason, (totals.get(row.reason) ?? 0) + value);
    grand += value;
  }
  if (grand <= 0 || totals.size === 0) return { shares: [], otherShare: 0 };

  const shares = Array.from(totals.entries())
    .map(([reason, total]) => ({ reason, share: Number((total / grand).toFixed(4)) }))
    .sort((a, b) => b.share - a.share);

  const kept = shares.filter((s) => s.share >= OTHER_COLLAPSE_THRESHOLD);
  const otherShare = Number(
    (shares.reduce((sum, s) => sum + s.share, 0) - kept.reduce((sum, s) => sum + s.share, 0)).toFixed(4),
  );
  return { shares: kept, otherShare };
}

/** GET /api/economy/flow-summary?window=24h|7d — public, SWR-cached 60s. */
economyApi.get('/flow-summary', readRateLimit, async (c) => {
  const windowKey = c.req.query('window') ?? '24h';
  const hours = FLOW_WINDOWS[windowKey];
  if (!hours) {
    return c.json({ error: "window must be one of: '24h', '7d'" }, 400);
  }

  try {
    return await swrJson(c, `economy:flow:${windowKey}:v1`, async (): Promise<FlowSummary> => {
      // Preferred source: pre-aggregated hourly rollup.
      try {
        const hourly = await query<FlowRow>(
          `SELECT direction, reason, SUM(amount)::text AS total
             FROM economy_flow_hourly
            WHERE bucket_hour >= NOW() - ($1 * INTERVAL '1 hour')
            GROUP BY direction, reason`,
          [hours],
        );
        const faucet = toShares(hourly.rows, 'faucet');
        const sink = toShares(hourly.rows, 'sink');
        return {
          window: windowKey,
          source: 'economy_flow_hourly',
          faucet: faucet.shares,
          sink: sink.shares,
          faucetOtherShare: faucet.otherShare,
          sinkOtherShare: sink.otherShare,
        };
      } catch {
        // Table missing — fall through to the live ledger below.
      }

      const ledger = await query<FlowRow>(
        `SELECT CASE WHEN amount > 0 THEN 'faucet' ELSE 'sink' END AS direction,
                reason, SUM(ABS(amount))::text AS total
           FROM economy_transactions
          WHERE timestamp >= NOW() - ($1 * INTERVAL '1 hour')
          GROUP BY 1, 2`,
        [hours],
      );
      const faucet = toShares(ledger.rows, 'faucet');
      const sink = toShares(ledger.rows, 'sink');
      return {
        window: windowKey,
        source: 'economy_transactions',
        faucet: faucet.shares,
        sink: sink.shares,
        faucetOtherShare: faucet.otherShare,
        sinkOtherShare: sink.otherShare,
      };
    });
  } catch (err) {
    logger.error({ err, windowKey }, 'economy/flow-summary failed');
    return c.json({ error: 'Database unavailable' }, 503);
  }
});

/**
 * GET /api/economy/drift-alerts — the economy monitor's drift inbox (12b
 * staff view). Bot-token gated: the alerts carry operational detail about the
 * money supply, not public data. Reads `economy_drift_alerts` (specced plugin
 * table — EconomyMonitor writes a row whenever a faucet/sink share drifts
 * past its threshold); until the table exists the inbox degrades to empty
 * with available:false.
 */
economyApi.get('/drift-alerts', readRateLimit, async (c) => {
  if (!botTokenMatches(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  try {
    return await swrJson(c, 'economy:drift-alerts:v1', async () => {
      try {
        const result = await query<{
          id: number | string;
          detected_at: Date;
          metric: string;
          direction: string;
          magnitude_pct: number | null;
          status: string;
          summary: string;
        }>(
          `SELECT id, detected_at, metric, direction, magnitude_pct, status, summary
             FROM economy_drift_alerts
            WHERE detected_at >= NOW() - INTERVAL '7 days'
            ORDER BY detected_at DESC
            LIMIT 50`,
          [],
        );
        return {
          available: true,
          alerts: result.rows.map((row) => ({
            id: String(row.id),
            detectedAt: row.detected_at,
            metric: row.metric,
            direction: row.direction === 'down' ? 'down' : 'up',
            magnitudePct: row.magnitude_pct === null ? undefined : Number(row.magnitude_pct),
            status: row.status === 'acknowledged' || row.status === 'resolved' ? row.status : 'open',
            summary: row.summary,
          })),
        };
      } catch (err) {
        logger.warn({ err }, 'economy_drift_alerts unavailable — serving empty inbox');
        return { available: false, alerts: [] };
      }
    });
  } catch (err) {
    logger.error({ err }, 'economy/drift-alerts failed');
    return c.json({ error: 'Database unavailable' }, 503);
  }
});
