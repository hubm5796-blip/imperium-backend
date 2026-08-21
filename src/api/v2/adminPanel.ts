/**
 * V6 04-06 — Admin Panel v2 backend: anticheat triage, audit log, ledger.
 *
 *   GET /api/v2/admin/anticheat/alerts?check=&uuid=&page=&since=
 *   GET /api/v2/admin/anticheat/summary
 *   GET /api/v2/admin/audit?actor=&action=&page=
 *   GET /api/v2/admin/economy/transactions?uuid=&reason_prefix=&page=
 *
 * Staff-gated (helper for reads, mod for the ledger — the read-mostly
 * doctrine: the panel never writes balances). All read the plugin's existing
 * Postgres/MySQL tables — no new game-side persistence required.
 */
import { Hono } from 'hono';
import { query } from '../../db/pool.js';
import { botTokenMatches } from '../../middleware/auth.js';
import { readRateLimit } from '../../middleware/rateLimit.js';
import { logger } from '../../utils/logger.js';
import type { AppContextVariables } from '../../types/index.js';

type ApiEnv = { Variables: AppContextVariables };

export const adminPanelV2 = new Hono<ApiEnv>();

adminPanelV2.use('*', readRateLimit, async (c, next) => {
  if (!botTokenMatches(c)) return c.json({ error: 'Unauthorized' }, 401);
  await next();
});

const PAGE_SIZE = 50;

function pageParams(c: { req: { query: (k: string) => string | undefined } }): { limit: number; offset: number; page: number } {
  const page = Math.max(1, Number.parseInt(c.req.query('page') ?? '1', 10) || 1);
  return { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE, page };
}

// ── Anticheat: alert feed ──────────────────────────────────────────────────
adminPanelV2.get('/admin/anticheat/alerts', async (c) => {
  const { limit, offset, page } = pageParams(c);
  const check = c.req.query('check');
  const uuid = c.req.query('uuid');
  const since = c.req.query('since'); // ISO or ms epoch

  const where: string[] = [];
  const params: unknown[] = [];
  if (check) { params.push(check); where.push(`hack_type = $${params.length}`); }
  if (uuid) { params.push(uuid); where.push(`player_uuid = $${params.length}`); }
  if (since) {
    const ms = since.match(/^\d+$/) ? Number(since) : Date.parse(since);
    if (!isNaN(ms)) { params.push(ms); where.push(`timestamp_ms >= $${params.length}`); }
  }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';

  try {
    const rows = await query(
      `SELECT id::text, timestamp_ms, player_uuid, player_name, hack_type, violation_level, detail, action
       FROM telemetry_violations${whereSql} ORDER BY timestamp_ms DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    const count = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM telemetry_violations${whereSql}`,
      params,
    );
    return c.json({
      alerts: rows.rows.map((r) => ({
        id: r.id,
        ts: Number(r.timestamp_ms),
        uuid: r.player_uuid,
        username: r.player_name,
        check: r.hack_type,
        vl: r.violation_level,
        details: r.detail,
        action: r.action,
      })),
      total: Number(count.rows[0]?.n ?? 0),
      page,
    });
  } catch (err) {
    logger.error({ err: String(err) }, 'v2 admin anticheat alerts failed');
    return c.json({ error: 'Alert feed unavailable' }, 503);
  }
});

// ── Anticheat: summary (check heatmap + top offenders) ─────────────────────
adminPanelV2.get('/admin/anticheat/summary', async (c) => {
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  try {
    const byCheck = await query(
      `SELECT hack_type AS check,
              COUNT(*)::int AS alert_count,
              COALESCE(AVG(violation_level), 0)::float AS avg_severity,
              COUNT(*) FILTER (WHERE action IS NOT NULL AND action != 'NONE')::int AS punished_count
       FROM telemetry_violations
       WHERE timestamp_ms >= $1
       GROUP BY hack_type ORDER BY alert_count DESC`,
      [dayAgo],
    );
    const topOffenders = await query(
      `SELECT player_uuid, MAX(player_name) AS username,
              COUNT(*)::int AS alert_count,
              MAX(violation_level) AS max_vl
       FROM telemetry_violations
       WHERE timestamp_ms >= $1
       GROUP BY player_uuid ORDER BY alert_count DESC LIMIT 10`,
      [dayAgo],
    );
    return c.json({
      byCheck: byCheck.rows,
      topOffenders: topOffenders.rows,
    });
  } catch (err) {
    logger.error({ err: String(err) }, 'v2 admin anticheat summary failed');
    return c.json({ error: 'Summary unavailable' }, 503);
  }
});

// ── Audit log reader ───────────────────────────────────────────────────────
adminPanelV2.get('/admin/audit', async (c) => {
  const { limit, offset, page } = pageParams(c);
  const actor = c.req.query('actor');
  const action = c.req.query('action');

  const where: string[] = [];
  const params: unknown[] = [];
  if (actor) { params.push(actor); where.push(`admin = $${params.length}`); }
  if (action) { params.push(action); where.push(`action = $${params.length}`); }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';

  try {
    const rows = await query(
      `SELECT id::text, admin, action, target, details, timestamp
       FROM admin_actions${whereSql} ORDER BY id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    const count = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM admin_actions${whereSql}`,
      params,
    );
    return c.json({
      entries: rows.rows.map((r) => ({
        id: r.id,
        actorUuid: r.admin,
        action: r.action,
        target: r.target,
        detail: r.details,
        at: new Date(r.timestamp).toISOString(),
      })),
      total: Number(count.rows[0]?.n ?? 0),
      page,
    });
  } catch (err) {
    logger.error({ err: String(err) }, 'v2 admin audit failed');
    return c.json({ error: 'Audit log unavailable' }, 503);
  }
});

// ── Economy: transactions ledger per player ────────────────────────────────
adminPanelV2.get('/admin/economy/transactions', async (c) => {
  const { limit, offset, page } = pageParams(c);
  const uuid = c.req.query('uuid');
  const reasonPrefix = c.req.query('reason_prefix');

  if (!uuid || !/^[0-9a-fA-F-]{32,36}$/.test(uuid)) {
    return c.json({ error: 'uuid query param required' }, 400);
  }

  const where: string[] = ['uuid = $1'];
  const params: unknown[] = [uuid];
  if (reasonPrefix) { params.push(reasonPrefix + '%'); where.push(`reason LIKE $${params.length}`); }
  const whereSql = ' WHERE ' + where.join(' AND ');

  try {
    const rows = await query(
      `SELECT id::text, currency, amount, new_balance, type, reason, timestamp
       FROM currency_transactions${whereSql} ORDER BY id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    const count = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM currency_transactions${whereSql}`,
      params,
    );
    return c.json({
      transactions: rows.rows.map((r) => ({
        id: r.id,
        currency: r.currency,
        amount: Number(r.amount),
        balanceAfter: Number(r.new_balance),
        type: r.type,
        reason: r.reason,
        at: new Date(r.timestamp).toISOString(),
      })),
      total: Number(count.rows[0]?.n ?? 0),
      page,
    });
  } catch (err) {
    logger.error({ err: String(err) }, 'v2 admin economy transactions failed');
    return c.json({ error: 'Ledger unavailable' }, 503);
  }
});
