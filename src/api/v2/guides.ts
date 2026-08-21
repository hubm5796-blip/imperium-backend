/**
 * V6 04-05 — player guides (the core UGC feature; gallery/comments ride the
 * same D1 pattern in follow-up waves).
 *
 *   GET  /api/v2/community/guides?category=&sort=top|new&page=   public
 *   GET  /api/v2/community/guides/:id                            public
 *   POST /api/v2/community/guides          requireAuth + linked
 *   POST /api/v2/community/guides/:id/vote requireAuth + linked (±1, unique)
 *
 * Identity rule (binding): guides attach to a LINKED Minecraft account — no
 * anonymous UGC, moderation has a real lever. Storage: D1 (web-only; the
 * plugin never reads it). Score is a denormalized vote sum maintained on the
 * same statement as the vote insert (D1 serializes writes per database).
 */
import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import { getD1 } from '../../db/pool.js';
import { requireLinked } from '../../middleware/auth.js';
import { readRateLimit, writeRateLimit } from '../../middleware/rateLimit.js';
import { logger } from '../../utils/logger.js';
import type { AppContextVariables } from '../../types/index.js';

type ApiEnv = { Variables: AppContextVariables };

export const guidesV2 = new Hono<ApiEnv>();

const CATEGORIES = new Set(['enchanting', 'prestige-routes', 'pvp', 'economy', 'general']);
const PAGE_SIZE = 20;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS guides (
  id text primary key,
  author_uuid text not null,
  title text not null,
  category text not null,
  body_md text not null,
  status text not null default 'published',
  score integer not null default 0,
  views integer not null default 0,
  created_at integer not null,
  updated_at integer not null
);
CREATE TABLE IF NOT EXISTS guide_votes (
  guide_id text not null,
  voter_uuid text not null,
  value integer not null,
  primary key (guide_id, voter_uuid)
)`;

// D1 constraints: prepare() takes ONE statement, and batch() rejects DDL —
// so the two CREATE TABLEs run as separate sequential prepares.
async function ensureSchema(): Promise<void> {
  const d1 = getD1();
  const mid = SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS guide_votes');
  await d1.prepare(SCHEMA.slice(0, mid).trim()).run();
  await d1.prepare(SCHEMA.slice(mid).trim().replace(/;$/, '')).run();
}

guidesV2.use('/community*', readRateLimit, async (c, next) => {
  try {
    await ensureSchema();
  } catch (e) {
    console.error('[guides] schema ensure failed:', String(e));
  }
  await next();
});

guidesV2.get('/community/guides', async (c) => {
  const category = c.req.query('category') ?? '';
  const sort = c.req.query('sort') === 'new' ? 'new' : 'top';
  const page = Math.max(1, Number.parseInt(c.req.query('page') ?? '1', 10) || 1);
  const where = category && CATEGORIES.has(category) ? "WHERE status = 'published' AND category = ?" : "WHERE status = 'published'";
  const order = sort === 'new' ? 'created_at DESC' : 'score DESC, created_at DESC';
  try {
    const stmt = category && CATEGORIES.has(category)
      ? getD1().prepare(`SELECT id, author_uuid, title, category, score, views, created_at FROM guides ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(category, PAGE_SIZE, (page - 1) * PAGE_SIZE)
      : getD1().prepare(`SELECT id, author_uuid, title, category, score, views, created_at FROM guides ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(PAGE_SIZE, (page - 1) * PAGE_SIZE);
    const { results } = await stmt.all<{ id: string; author_uuid: string; title: string; category: string; score: number; views: number; created_at: number }>();
    return c.json({ guides: results ?? [] });
  } catch (err) {
    logger.error({ err: String(err) }, 'v2 guides list failed');
    return c.json({ error: 'Guides unavailable', detail: String(err).slice(0, 200) }, 503);
  }
});

guidesV2.get('/community/guides/:id', async (c) => {
  const id = c.req.param('id');
  try {
    const { results } = await getD1()
      .prepare("SELECT id, author_uuid, title, category, body_md, score, views, created_at, updated_at FROM guides WHERE id = ? AND status = 'published'")
      .bind(id)
      .all<{ id: string; author_uuid: string; title: string; category: string; body_md: string; score: number; views: number; created_at: number; updated_at: number }>();
    const guide = (results ?? [])[0];
    if (!guide) return c.json({ error: 'Guide not found' }, 404);
    void getD1().prepare('UPDATE guides SET views = views + 1 WHERE id = ?').bind(id).run().catch(() => undefined);
    return c.json({ guide });
  } catch (err) {
    logger.error({ err: String(err) }, 'v2 guide read failed');
    return c.json({ error: 'Guides unavailable' }, 503);
  }
});

guidesV2.post('/community/guides', writeRateLimit, requireLinked, async (c) => {
  const uuid = c.get('mcUuid');
  if (!uuid) return c.json({ error: 'Unauthorized' }, 401);
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 160) : '';
  const category = typeof body.category === 'string' ? body.category.trim() : '';
  const bodyMd = typeof body.body_md === 'string' ? body.body_md.slice(0, 50_000) : '';
  if (!title || !bodyMd) return c.json({ error: 'title and body_md are required' }, 400);
  if (!CATEGORIES.has(category)) {
    return c.json({ error: 'Invalid category', categories: [...CATEGORIES] }, 400);
  }
  const id = 'g_' + randomBytes(6).toString('base64url');
  const now = Date.now();
  try {
    await getD1()
      .prepare('INSERT INTO guides (id, author_uuid, title, category, body_md, status, score, views, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)')
      .bind(id, uuid, title, category, bodyMd, 'published', now, now)
      .run();
    return c.json({ id }, 201);
  } catch (err) {
    logger.error({ err: String(err) }, 'v2 guide create failed');
    return c.json({ error: 'Guide creation failed' }, 500);
  }
});

guidesV2.post('/community/guides/:id/vote', writeRateLimit, requireLinked, async (c) => {
  const uuid = c.get('mcUuid');
  if (!uuid) return c.json({ error: 'Unauthorized' }, 401);
  const id = c.req.param('id');
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const value = body.value === 1 ? 1 : body.value === -1 ? -1 : 0;
  if (value === 0) return c.json({ error: 'value must be 1 or -1' }, 400);
  try {
    const guide = await getD1().prepare('SELECT author_uuid FROM guides WHERE id = ?').bind(id).first<{ author_uuid: string }>();
    if (!guide) return c.json({ error: 'Guide not found' }, 404);
    if (guide.author_uuid === uuid) return c.json({ error: 'Cannot vote on your own guide' }, 400);
    const existing = await getD1().prepare('SELECT value FROM guide_votes WHERE guide_id = ? AND voter_uuid = ?').bind(id, uuid).first<{ value: number }>();
    const res = await getD1()
      .prepare(
        existing
          ? 'UPDATE guide_votes SET value = ? WHERE guide_id = ? AND voter_uuid = ?'
          : 'INSERT INTO guide_votes (guide_id, voter_uuid, value) VALUES (?, ?, ?)',
      )
      .bind(...(existing ? [value, id, uuid] : [id, uuid, value]))
      .run();
    if ((res.meta.changes ?? 0) === 0) return c.json({ error: 'Vote failed' }, 500);
    // Score delta: new vote adds value; a changed vote adds value - old.
    const delta = existing ? value - existing.value : value;
    await getD1().prepare('UPDATE guides SET score = score + ? WHERE id = ?').bind(delta, id).run();
    return c.json({ voted: value });
  } catch (err) {
    logger.error({ err: String(err) }, 'v2 guide vote failed');
    return c.json({ error: 'Vote failed' }, 500);
  }
});
