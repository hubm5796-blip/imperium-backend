// 12b expansion: staff-facing admin read views —
//   GET /api/admin/liveops              (calendar override log + festival fund ledger)
//   GET /api/admin/contraband/sweeps    (contraband sweeper log + verdict stats)
//   GET /api/admin/player-tools?uuid=   (read-only extended player lookup)
//
// Auth: bot token only. These are consumed exclusively by the frontend's
// server-side edge proxies (src/app/api/admin/*), which enforce the Discord
// role gate themselves BEFORE forwarding with X-Bot-Token; the backend treats
// that token as the staff trust anchor (same model as the existing
// /api/admin/server/status + /api/admin/player routes). Everything is
// read-only — mutating staff actions stay in-game where the audit trails are.
//
// Data sources:
//  - festival_fund_ledger: LIVE plugin table (FestivalFundLedger).
//  - events_calendar_overrides / contraband_sweeps / economy_drift_alerts:
//    specced plugin tables — each section degrades independently to
//    available:false + empty (see docs/api.md).
import { Hono, type Context } from 'hono';
import { botTokenMatches } from '../../middleware/auth.js';
import { readRateLimit } from '../../middleware/rateLimit.js';
import { query } from '../../db/pool.js';
import { minorUnitsToDisplay } from '../../utils/money.js';
import { logger } from '../../utils/logger.js';
import { swrJson } from './cache.js';
import { mcUuidSchema } from './schemas.js';
import type { AppContextVariables } from '../../types/index.js';

type ApiEnv = { Variables: AppContextVariables };

export const adminViewsApi = new Hono<ApiEnv>();

/** Bot-token gate shared by every admin view (401, never 403 — no session path). */
function requireBot(c: Context): boolean {
  return botTokenMatches(c);
}

/** Degrading read: an unqueryable table yields {rows: [], available: false}. */
async function softRows<T extends Record<string, unknown>>(
  label: string,
  sql: string,
  params: unknown[],
): Promise<{ rows: T[]; available: boolean }> {
  try {
    const result = await query<T>(sql, params);
    return { rows: result.rows, available: true };
  } catch (err) {
    logger.warn({ err, label }, 'Admin-view table unavailable — degrading to empty');
    return { rows: [], available: false };
  }
}

/* ---------------------------------------------------------------- Live-ops */

/**
 * GET /api/admin/liveops — the staff live-ops view: recent calendar overrides
 * (start/skip) and the festival fund ledger. The calendar itself is served by
 * the public /api/seasons/current (the frontend proxy merges both).
 */
adminViewsApi.get('/admin/liveops', readRateLimit, async (c) => {
  if (!requireBot(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  try {
    return await swrJson(c, 'admin:liveops:v1', async () => {
      const overrides = await softRows<{
        id: number | string;
        actor: string;
        action: string;
        target: string | null;
        note: string | null;
        at: Date;
      }>(
        'events_calendar_overrides',
        `SELECT id, actor, action, target, note, at
           FROM events_calendar_overrides
          ORDER BY at DESC
          LIMIT 25`,
        [],
      );

      // festival_fund_ledger is a LIVE plugin table (rake in / event payouts).
      const ledger = await softRows<{ ts: Date; kind: string; source: string; amount: number; actor: string }>(
        'festival_fund_ledger',
        `SELECT ts, kind, source, amount, actor
           FROM festival_fund_ledger
          ORDER BY ts DESC
          LIMIT 25`,
        [],
      );

      return {
        available: overrides.available || ledger.available,
        overrides: overrides.rows.map((row) => ({
          id: String(row.id),
          at: row.at,
          actor: row.actor,
          action: row.action,
          target: row.target ?? undefined,
          note: row.note ?? undefined,
        })),
        festivalLedger: ledger.rows.map((row, i) => ({
          id: `${row.ts.toISOString?.() ?? String(row.ts)}|${row.source}|${i}`,
          at: row.ts,
          entry: `${row.kind} — ${row.source} (by ${row.actor})`,
          amount: Number(row.amount ?? 0),
        })),
      };
    });
  } catch (err) {
    logger.error({ err }, 'admin/liveops failed');
    return c.json({ error: 'Database unavailable' }, 503);
  }
});

/* ------------------------------------------------------------- Contraband */

/**
 * GET /api/admin/contraband/sweeps — the in-game ContrabandSweeper's log
 * (vault/ender-chest/carried sweeps with verdicts) plus verdict distribution.
 * Read-only; sweep verdicts and confiscations themselves happen in-game.
 */
adminViewsApi.get('/admin/contraband/sweeps', readRateLimit, async (c) => {
  if (!requireBot(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const limitRaw = Number.parseInt(c.req.query('limit') ?? '25', 10);
  const limit = Math.min(Math.max(Number.isNaN(limitRaw) ? 25 : limitRaw, 1), 100);
  try {
    return await swrJson(c, `admin:contraband:${limit}:v1`, async () => {
      const sweeps = await softRows<{
        id: number | string;
        swept_at: Date;
        target_name: string | null;
        target_uuid: string | null;
        items: number | null;
        verdict: string;
        action: string | null;
        staff: string | null;
      }>(
        'contraband_sweeps',
        `SELECT id, swept_at, target_name, target_uuid, items, verdict, action, staff
           FROM contraband_sweeps
          ORDER BY swept_at DESC
          LIMIT $1`,
        [limit],
      );

      let verdictStats: Array<{ verdict: string; count: number }> = [];
      if (sweeps.available) {
        try {
          const stats = await query<{ verdict: string; count: string }>(
            `SELECT verdict, COUNT(*)::text AS count
               FROM contraband_sweeps
              WHERE swept_at >= NOW() - INTERVAL '30 days'
              GROUP BY verdict
              ORDER BY COUNT(*) DESC`,
            [],
          );
          verdictStats = stats.rows.map((row) => ({ verdict: row.verdict, count: Number(row.count ?? 0) }));
        } catch {
          // Aggregation failed but the row list is fine — stats stay empty.
        }
      }

      return {
        available: sweeps.available,
        sweeps: sweeps.rows.map((row) => ({
          id: String(row.id),
          at: row.swept_at,
          target: row.target_name ?? row.target_uuid ?? undefined,
          items: row.items === null ? undefined : Number(row.items),
          verdict: row.verdict,
          action: row.action ?? undefined,
          staff: row.staff ?? undefined,
        })),
        verdictStats,
      };
    });
  } catch (err) {
    logger.error({ err }, 'admin/contraband/sweeps failed');
    return c.json({ error: 'Database unavailable' }, 503);
  }
});

/* ----------------------------------------------------------- Player tools */

/**
 * GET /api/admin/player-tools?uuid= — read-only extended lookup for staff:
 * economy flow-log tail (economy_transactions, LIVE), dungeon lockouts
 * (dungeon_lockouts, specced), pity counters (pity_counters, specced).
 * The headline profile/balances come from the existing /api/player/profile;
 * the frontend merges both. No mutations — refunds/unlocks stay in-game.
 */
adminViewsApi.get('/admin/player-tools', readRateLimit, async (c) => {
  if (!requireBot(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const parsed = mcUuidSchema.safeParse(c.req.query('uuid') ?? '');
  if (!parsed.success) {
    return c.json({ error: 'Invalid uuid parameter' }, 400);
  }
  const uuid = parsed.data;

  let flowTail: Array<{ at: Date; reason: string; amount: number; currency: string }> = [];
  let flowAvailable = false;
  try {
    const result = await query<{ type: string; currency: string; amount: string; description: string | null; created_at: Date }>(
      `SELECT type, currency, amount, description, created_at
         FROM economy_transactions
        WHERE uuid = $1
        ORDER BY created_at DESC
        LIMIT 10`,
      [uuid],
    );
    flowTail = result.rows.map((row) => ({
      at: row.created_at,
      reason: row.description ?? row.type,
      amount: minorUnitsToDisplay(row.amount),
      currency: row.currency,
    }));
    flowAvailable = true;
  } catch (err) {
    logger.warn({ err, uuid }, 'economy_transactions unavailable for player-tools');
  }

  const lockouts = await softRows<{ dungeon_id: string; locked_until: Date }>(
    'dungeon_lockouts',
    `SELECT dungeon_id, locked_until
       FROM dungeon_lockouts
      WHERE uuid = $1 AND locked_until > NOW()
      ORDER BY locked_until
      LIMIT 25`,
    [uuid],
  );

  const pity = await softRows<{ counter_id: string; rolls: number; threshold: number }>(
    'pity_counters',
    `SELECT counter_id, rolls, threshold
       FROM pity_counters
      WHERE uuid = $1
      ORDER BY counter_id
      LIMIT 25`,
    [uuid],
  );

  return c.json(
    {
      uuid,
      available: flowAvailable || lockouts.available || pity.available,
      player: {
        uuid,
        flowTail: flowTail.map((row) => ({ ...row })),
        lockouts: lockouts.rows.map((row) => ({
          id: row.dungeon_id,
          type: 'dungeon',
          reason: `Dungeon lockout — ${row.dungeon_id}`,
          expiresAt: row.locked_until,
          active: true,
        })),
        pity: pity.rows.map((row) => ({
          id: row.counter_id,
          rolls: Number(row.rolls ?? 0),
          threshold: Number(row.threshold ?? 0),
        })),
      },
    },
    200,
    { 'Cache-Control': 'private, no-store' },
  );
});
