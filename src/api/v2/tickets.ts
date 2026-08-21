/**
 * V6 02-06 — v2 ticket surface for the Discord bot (the single-store model:
 * the Discord thread is a VIEW of the row, never a copy).
 *
 *   POST /api/v2/tickets                    create (accepts discord opener ids)
 *   GET  /api/v2/tickets?status=&created_since=   the sweep poll
 *   PATCH /api/v2/tickets/:id               status/priority/thread/satisfaction
 *   POST /api/v2/tickets/:id/notes          append-only transcript note
 *
 * Bot-gated (internal caller). The existing /api/tickets routes stay the
 * web/in-game surface; `respond` there remains the canonical staff answer.
 */
import { Hono } from 'hono';
import { query } from '../../db/pool.js';
import { botTokenMatches } from '../../middleware/auth.js';
import { readRateLimit, writeRateLimit } from '../../middleware/rateLimit.js';
import { logger } from '../../utils/logger.js';
import type { AppContextVariables } from '../../types/index.js';

type ApiEnv = { Variables: AppContextVariables };

export const ticketsV2 = new Hono<ApiEnv>();

ticketsV2.use('*', readRateLimit, async (c, next) => {
  if (!botTokenMatches(c)) return c.json({ error: 'Unauthorized' }, 401);
  await next();
});

const CATEGORIES = new Set(['bug', 'payment', 'report', 'appeal', 'general']);

ticketsV2.post('/tickets', writeRateLimit, async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const uuid = typeof body.uuid === 'string' ? body.uuid.trim() : '';
  const category = typeof body.category === 'string' ? body.category.trim().toLowerCase() : 'general';
  const subject = typeof body.subject === 'string' ? body.subject.trim().slice(0, 160) : '';
  const note = typeof body.body === 'string' ? body.body.trim().slice(0, 4000) : '';
  const discordThreadId = typeof body.discordThreadId === 'string' ? body.discordThreadId : null;
  const discordOpenerId = typeof body.discordOpenerId === 'string' ? body.discordOpenerId : null;
  if (!/^[0-9a-f-]{32,36}$/i.test(uuid)) return c.json({ error: 'Invalid uuid' }, 400);
  if (!subject || !note) return c.json({ error: 'subject and body are required' }, 400);
  if (!CATEGORIES.has(category)) return c.json({ error: 'Invalid category', categories: [...CATEGORIES] }, 400);

  // Anti-abuse: max 2 OPEN tickets per player (the doc's cap).
  try {
    const open = await query<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM support_tickets WHERE uuid = $1 AND status = 'open'",
      [uuid],
    );
    if (Number(open.rows[0]?.n ?? 0) >= 2) {
      return c.json({ error: 'Open ticket limit reached (2)', code: 'TICKET_LIMIT' }, 429);
    }
  } catch (err) {
    logger.error({ err: String(err) }, 'v2 tickets: open-count check failed');
    return c.json({ error: 'Ticket store unavailable' }, 503);
  }

  try {
    const created = await query<{ id: string }>(
      `INSERT INTO support_tickets (uuid, category, subject, body, status, priority, discord_thread_id, created_at)
       VALUES ($1, $2, $3, $4, 'open', 'normal', $5, now())
       RETURNING id::text`,
      [uuid, category, subject, note, discordThreadId],
    );
    const id = created.rows[0]!.id;
    if (discordOpenerId) {
      await query('INSERT INTO ticket_notes (ticket_id, author, body) VALUES ($1, $2, $3)',
        [id, 'discord', `(opened by <@${discordOpenerId}>)`]);
    }
    await query('INSERT INTO ticket_notes (ticket_id, author, body) VALUES ($1, $2, $3)',
      [id, 'player', note]);
    return c.json({ id, status: 'open' }, 201);
  } catch (err) {
    logger.error({ err: String(err) }, 'v2 tickets: create failed');
    return c.json({ error: 'Ticket creation failed' }, 500);
  }
});

ticketsV2.get('/tickets', readRateLimit, async (c) => {
  const status = c.req.query('status');
  const since = c.req.query('created_since');
  const params: unknown[] = [];
  const where: string[] = [];
  if (status) {
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  if (since && /^\d{4}-\d{2}-\d{2}T/.test(since)) {
    params.push(since);
    where.push(`created_at >= $${params.length}`);
  }
  const sql =
    'SELECT id::text, uuid, username, category, subject, status, priority, discord_thread_id, created_at FROM support_tickets' +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    " ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END, created_at DESC LIMIT 100";
  try {
    const rows = await query(sql, params);
    return c.json({ tickets: rows.rows });
  } catch (err) {
    logger.error({ err: String(err) }, 'v2 tickets: list failed');
    return c.json({ error: 'Ticket store unavailable' }, 503);
  }
});

ticketsV2.patch('/tickets/:id', writeRateLimit, async (c) => {
  const id = c.req.param('id');
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const sets: string[] = [];
  const params: unknown[] = [];
  const allowed: Array<[string, string, (v: unknown) => unknown]> = [
    ['status', 'status', (v) => String(v)],
    ['priority', 'priority', (v) => String(v)],
    ['discordThreadId', 'discord_thread_id', (v) => String(v)],
    ['satisfaction', 'satisfaction', (v) => String(v)],
  ];
  for (const [key, col, coerce] of allowed) {
    if (key in body) {
      params.push(coerce(body[key]));
      sets.push(`${col} = $${params.length}`);
    }
  }
  if (sets.length === 0) return c.json({ error: 'No updatable fields provided' }, 400);
  params.push(id);
  try {
    const res = await query(
      `UPDATE support_tickets SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id::text, status, priority, discord_thread_id, satisfaction`,
      params,
    );
    if (res.rows.length === 0) return c.json({ error: 'Ticket not found' }, 404);
    return c.json({ updated: res.rows[0] });
  } catch (err) {
    logger.error({ err: String(err) }, 'v2 tickets: patch failed');
    return c.json({ error: 'Ticket update failed' }, 500);
  }
});

ticketsV2.post('/tickets/:id/notes', writeRateLimit, async (c) => {
  const id = c.req.param('id');
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const author = body.author === 'player' ? 'player' : body.author === 'discord' ? 'discord' : 'staff';
  const note = typeof body.body === 'string' ? body.body.trim().slice(0, 2000) : '';
  if (!note) return c.json({ error: 'body is required' }, 400);
  try {
    const res = await query(
      'INSERT INTO ticket_notes (ticket_id, author, body) SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM support_tickets WHERE id = $1) RETURNING id::text',
      [id, author, note],
    );
    if (res.rows.length === 0) return c.json({ error: 'Ticket not found' }, 404);
    return c.json({ appended: true }, 201);
  } catch (err) {
    logger.error({ err: String(err) }, 'v2 tickets: note append failed');
    return c.json({ error: 'Note append failed' }, 500);
  }
});
