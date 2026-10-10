/**
 * Backend-owned action log (2026-10-06) — the D1 audit trail for
 * audit-worthy writes that never reach the plugin's admin_actions table
 * (ticket staff notes/status changes, changelog posts, gallery moderation).
 *
 * Doctrine (mirrors bot_mod_log in bot/moderation.ts):
 *   - The audit row is written AFTER the action succeeded, and a write
 *     failure NEVER fails or blocks the action — it is logged loudly instead.
 *   - Every row carries a per-actor attribution (utils/auditActor.ts): the
 *     acting human where one exists, the shared-bot identity where none does
 *     (cron sweeps), never a caller-supplied unvalidated string.
 *   - The table is additive (new, backend-owned D1) — no existing schema is
 *     touched, and rows written before a column existed are impossible
 *     because the table ships complete.
 */
import { getD1 } from './pool.js';
import { logger } from '../utils/logger.js';
import { SYSTEM_ACTOR, type AuditActor } from '../utils/auditActor.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS action_log (
  id text primary key,
  ts integer not null,
  actor_id text not null,
  actor_name text not null,
  action text not null,
  target text,
  detail text
)`;

/** Action names are a dot-namespaced closed shape (ticket.note, changelog.post). */
const ACTION_RE = /^[a-z][a-z0-9_]{1,28}\.[a-z][a-z0-9_]{1,28}$/;

export interface ActionLogEntry {
  actor: AuditActor;
  /** dot-namespaced action name, e.g. 'ticket.note'. */
  action: string;
  /** Subject of the action (ticket id, changelog title, gallery post id). */
  target?: string;
  /** Short free-form context (changed fields, outcome). */
  detail?: string;
}

function clip(value: string | undefined, max: number): string | null {
  if (typeof value !== 'string') return null;
  const clipped = value.slice(0, max);
  return clipped.length > 0 ? clipped : null;
}

/** Lazy CREATE TABLE IF NOT EXISTS (once per isolate — the dms.ts pattern). */
let schemaEnsured = false;
async function ensureSchema(): Promise<void> {
  if (schemaEnsured) return;
  await getD1().prepare(SCHEMA).run();
  schemaEnsured = true;
}

/**
 * Append one audit row. NEVER throws — a D1 blip costs the row (logged),
 * not the caller's action. Invalid action/target shapes are likewise logged
 * and dropped rather than thrown, so no route ever branches on audit output.
 * Callers should still await this where the row must land before the
 * response (Workers may drop post-response promises).
 */
export async function recordAction(entry: ActionLogEntry): Promise<void> {
  try {
    if (!ACTION_RE.test(entry.action)) {
      logger.warn({ action: entry.action }, 'action_log: malformed action name dropped');
      return;
    }
    await ensureSchema();
    const actor = entry.actor ?? SYSTEM_ACTOR;
    const id = 'act_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    await getD1()
      .prepare(
        'INSERT INTO action_log (id, ts, actor_id, actor_name, action, target, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        id,
        Date.now(),
        actor.id,
        actor.name.slice(0, 80),
        entry.action,
        clip(entry.target, 120),
        clip(entry.detail, 500),
      )
      .run();
  } catch (err) {
    logger.error({ err: String(err), action: entry.action }, 'action_log write failed');
  }
}

export interface ActionLogRow {
  id: string;
  ts: number;
  actor_id: string;
  actor_name: string;
  action: string;
  target: string | null;
  detail: string | null;
}

/** Reader for the panel (v2 /admin/actions). Returns newest-first page. */
export async function listActions(opts: {
  actorId?: string;
  action?: string;
  limit: number;
  offset: number;
}): Promise<{ entries: ActionLogRow[]; total: number }> {
  await ensureSchema();
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.actorId) {
    params.push(opts.actorId);
    where.push(`actor_id = ?${params.length}`);
  }
  if (opts.action) {
    params.push(opts.action);
    where.push(`action = ?${params.length}`);
  }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const { results } = await getD1()
    .prepare(
      `SELECT id, ts, actor_id, actor_name, action, target, detail FROM action_log${whereSql} ORDER BY ts DESC, id DESC LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`,
    )
    .bind(...params, opts.limit, opts.offset)
    .all<ActionLogRow>();
  const count = await getD1()
    .prepare(`SELECT COUNT(*) AS n FROM action_log${whereSql}`)
    .bind(...params)
    .first<{ n: number }>();
  return { entries: results ?? [], total: count?.n ?? 0 };
}
