/**
 * V6 04-05 — guide comments: the discussion layer on player guides.
 *
 *   GET  /api/v2/community/guides/:id/comments   public, newest-first, capped
 *   POST /api/v2/community/guides/:id/comments   requireAuth + linked
 *
 * Identity rule (same as guides): comments attach to a linked Minecraft account —
 * no anonymous UGC. D1-backed (web-only). Body is ≤ 2,000 chars; a player can
 * delete their own comment; guide authors can delete any comment on their guide.
 */
import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import { getD1 } from '../../db/pool.js';
import { requireLinked } from '../../middleware/auth.js';
import { readRateLimit, writeRateLimit } from '../../middleware/rateLimit.js';
import { logger } from '../../utils/logger.js';
import type { AppContextVariables } from '../../types/index.js';

type ApiEnv = { Variables: AppContextVariables };

export const guideCommentsV2 = new Hono<ApiEnv>();

const SCHEMA = `
CREATE TABLE IF NOT EXISTS guide_comments (
  id text primary key,
  guide_id text not null,
  author_uuid text not null,
  body_md text not null,
  status text not null default 'visible',
  created_at integer not null
)`;

async function ensureSchema(): Promise<void> {
  await getD1().prepare(SCHEMA).run();
}

guideCommentsV2.use('/community/*', readRateLimit, async (c, next) => {
  try { await ensureSchema(); } catch { /* degrade */ }
  await next();
});

guideCommentsV2.get('/community/guides/:id/comments', async (c) => {
  const guideId = c.req.param('id');
  try {
    const { results } = await getD1()
      .prepare("SELECT id, author_uuid, body_md, created_at FROM guide_comments WHERE guide_id = ? AND status = 'visible' ORDER BY created_at DESC LIMIT 100")
      .bind(guideId)
      .all<{ id: string; author_uuid: string; body_md: string; created_at: number }>();
    return c.json({ comments: results ?? [] });
  } catch (err) {
    logger.error({ err: String(err) }, 'v2 guide comments list failed');
    return c.json({ error: 'Comments unavailable' }, 503);
  }
});

guideCommentsV2.post('/community/guides/:id/comments', writeRateLimit, requireLinked, async (c) => {
  const uuid = c.get('mcUuid');
  if (!uuid) return c.json({ error: 'Unauthorized' }, 401);
  const guideId = c.req.param('id');
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const text = typeof body.body_md === 'string' ? body.body_md.trim().slice(0, 2000) : '';
  if (!text) return c.json({ error: 'body_md is required' }, 400);
  if (text.length < 2) return c.json({ error: 'Comment too short' }, 400);

  // Verify the guide exists and is published.
  const guide = await getD1()
    .prepare("SELECT author_uuid FROM guides WHERE id = ? AND status = 'published'")
    .bind(guideId)
    .first<{ author_uuid: string }>();
  if (!guide) return c.json({ error: 'Guide not found' }, 404);

  // Anti-spam: max 1 comment per 30 seconds per player per guide.
  const thirtySecAgo = Date.now() - 30_000;
  const existing = await getD1()
    .prepare('SELECT id FROM guide_comments WHERE guide_id = ? AND author_uuid = ? AND created_at > ? LIMIT 1')
    .bind(guideId, uuid, thirtySecAgo)
    .first();
  if (existing) return c.json({ error: 'Please wait before commenting again', code: 'RATE_LIMIT' }, 429);

  const id = 'c_' + randomBytes(6).toString('base64url');
  try {
    await getD1()
      .prepare('INSERT INTO guide_comments (id, guide_id, author_uuid, body_md, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, guideId, uuid, text, 'visible', Date.now())
      .run();
    return c.json({ id }, 201);
  } catch (err) {
    logger.error({ err: String(err) }, 'v2 guide comment create failed');
    return c.json({ error: 'Comment failed' }, 500);
  }
});

guideCommentsV2.delete('/community/guides/:id/comments/:commentId', writeRateLimit, requireLinked, async (c) => {
  const uuid = c.get('mcUuid');
  if (!uuid) return c.json({ error: 'Unauthorized' }, 401);
  const guideId = c.req.param('id');
  const commentId = c.req.param('commentId');

  // Allow deletion if: commenter OR guide author.
  const comment = await getD1()
    .prepare('SELECT author_uuid FROM guide_comments WHERE id = ? AND guide_id = ?')
    .bind(commentId, guideId)
    .first<{ author_uuid: string }>();
  if (!comment) return c.json({ error: 'Comment not found' }, 404);

  const guide = await getD1()
    .prepare('SELECT author_uuid FROM guides WHERE id = ?')
    .bind(guideId)
    .first<{ author_uuid: string }>();

  const isCommenter = comment.author_uuid === uuid;
  const isGuideAuthor = guide?.author_uuid === uuid;
  if (!isCommenter && !isGuideAuthor) return c.json({ error: 'Not your comment' }, 403);

  try {
    await getD1()
      .prepare("UPDATE guide_comments SET status = 'deleted' WHERE id = ?")
      .bind(commentId)
      .run();
    return c.json({ deleted: true });
  } catch (err) {
    logger.error({ err: String(err) }, 'v2 guide comment delete failed');
    return c.json({ error: 'Delete failed' }, 500);
  }
});
