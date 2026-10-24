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
 * plugin never reads it). Score is a denormalized vote sum recomputed from
 * guide_votes inside the same batch() as the vote upsert (D1 runs a batch as
 * a transaction) — never incremented from a separately-read value (B-15).
 */
import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import { getD1 } from '../../db/pool.js';
import { requireLinked } from '../../middleware/auth.js';
import { readRateLimit, writeRateLimit } from '../../middleware/rateLimit.js';
import { logger } from '../../utils/logger.js';
import type { AppContextVariables } from '../../types/index.js';
import { pageParam } from '../../utils/paging.js';

type ApiEnv = { Variables: AppContextVariables };

export const guidesV2 = new Hono<ApiEnv>();

const CATEGORIES = new Set(['enchanting', 'prestige-routes', 'pvp', 'economy', 'general']);
const PAGE_SIZE = 20;

// B-34: per-author publish limits. Guides used to publish instantly with no
// per-author control beyond the shared 10/min IP bucket — instant-public
// spam/defacement, while both sibling UGC surfaces are stricter (gallery:
// 3/day + pending-until-approve; comments: 1/30 s/player/guide). Mirrored
// here: a 60 s cooldown between publishes plus a 5/day per-author quota.
// (First-post-moderation was considered and deliberately left out — there is
// no guide review queue for moderation yet.)
const GUIDE_PUBLISH_COOLDOWN_MS = 60_000;
const GUIDES_PER_DAY = 5;

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

guidesV2.use('/community/*', readRateLimit, async (c, next) => {
  try {
    await ensureSchema();
  } catch {
    // D1 unavailable — read routes degrade to empty; writes will fail loudly.
  }
  await next();
});

guidesV2.get('/community/guides', async (c) => {
  const category = c.req.query('category') ?? '';
  const sort = c.req.query('sort') === 'new' ? 'new' : 'top';
  const page = pageParam(c.req.query('page'));
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
    return c.json({ error: 'Guides unavailable' }, 503);
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
  // B-34: per-author cooldown + daily quota (see constants above). A D1
  // failure here is a 503, not a silent skip — publishing without the quota
  // check is exactly the state the finding flagged.
  try {
    const recent = await getD1()
      .prepare('SELECT id FROM guides WHERE author_uuid = ? AND created_at > ? LIMIT 1')
      .bind(uuid, now - GUIDE_PUBLISH_COOLDOWN_MS)
      .first();
    if (recent) {
      return c.json({ error: 'Please wait a minute between publishing guides', code: 'RATE_LIMIT' }, 429);
    }
    const dayAgo = now - 24 * 3600 * 1000;
    const { results } = await getD1()
      .prepare('SELECT COUNT(*) AS n FROM guides WHERE author_uuid = ? AND created_at > ?')
      .bind(uuid, dayAgo)
      .all<{ n: number }>();
    if (((results ?? [])[0]?.n ?? 0) >= GUIDES_PER_DAY) {
      return c.json({ error: `Daily guide limit reached (${GUIDES_PER_DAY}/day). Try again tomorrow.`, code: 'RATE_LIMIT' }, 429);
    }
  } catch (err) {
    logger.error({ err: String(err) }, 'v2 guide quota check failed');
    return c.json({ error: 'Guides unavailable' }, 503);
  }
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
    // B-15: the vote write and the score maintenance run as ONE batch (D1
    // executes batch() as a transaction) and the score is RECOMPUTED from
    // guide_votes, never incremented from a value read in a prior statement.
    // The old four-statement read-modify-write (SELECT vote → write vote →
    // `score = score + delta`) let concurrent votes interleave and lose
    // updates, drifting score off the true vote sum with no reconciliation.
    // A recompute is also self-healing: any interleaving converges to the
    // correct sum as long as each voter's batch runs after its own vote write.
    const results = await getD1().batch([
      getD1()
        .prepare(
          `INSERT INTO guide_votes (guide_id, voter_uuid, value) VALUES (?, ?, ?)
           ON CONFLICT (guide_id, voter_uuid) DO UPDATE SET value = excluded.value`,
        )
        .bind(id, uuid, value),
      getD1()
        .prepare(
          `UPDATE guides
              SET score = (SELECT COALESCE(SUM(value), 0) FROM guide_votes WHERE guide_id = ?)
            WHERE id = ?`,
        )
        .bind(id, id),
    ]);
    if ((results[0]?.meta.changes ?? 0) === 0) return c.json({ error: 'Vote failed' }, 500);
    return c.json({ voted: value });
  } catch (err) {
    logger.error({ err: String(err) }, 'v2 guide vote failed');
    return c.json({ error: 'Vote failed' }, 500);
  }
});
