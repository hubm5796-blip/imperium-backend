/**
 * Q9 — the season suggestion board (roadmap §6, Netherite-inspired): players
 * post and upvote ideas for next-season features on romanica.net.
 *
 *   GET   /api/v2/suggestions                 public, top-voted first, capped
 *   POST  /api/v2/suggestions                 linked session or delegated (create)
 *   POST  /api/v2/suggestions/:id/upvote      linked session or delegated (one per account)
 *   POST  /api/v2/suggestions/:id/moderate    staff (admin) hide/show
 *
 * Identity: same rule as the other UGC surfaces — a suggestion attaches to a
 * linked Minecraft account (no anonymous posts). The gate is requireMcIdentity
 * (NOT requireLinked): the frontend's same-origin proxy authenticates as a
 * delegated service call (X-Bot-Token INTERNAL_SERVICE_TOKEN + X-Mc-Uuid),
 * which requireLinked 401'd — the Q9 gate finding, fixed for comments/gallery
 * in the same branch.
 *
 * Moderation: every row carries a `hidden` flag (0 on create). Hidden rows
 * vanish from the public list and cannot be upvoted (404 — existence is not
 * leaked). The hide/show endpoint is gated on requireStaffRole('admin'):
 * a session cookie (or service token) plus X-Staff-Role: admin, per the
 * established staff pattern. There is no moderation-queue UI in this lane —
 * staff curl the endpoint (or wire Discord later); every flip is written to
 * action_log with the acting staff identity.
 *
 * Anti-abuse: the shared writeRateLimit (10/min/IP) plus a per-author
 * cooldown (30 s between posts) and daily quota (10/day); body capped at
 * 300 chars and stored/rendered as PLAIN TEXT (no markdown, no HTML — the
 * frontend renders it as React text, never dangerouslySetInnerHTML).
 *
 * Vote integrity (B-15, same as guides): one vote per account, enforced by
 * the (suggestion_id, voter_uuid) primary key with ON CONFLICT DO NOTHING,
 * and the denormalized score is RECOMPUTED from suggestion_votes inside the
 * same D1 batch() as the vote insert — never incremented from a separately
 * read value. Repeated upvotes are idempotent (score converges to the exact
 * vote count).
 */
import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import { getD1 } from '../../db/pool.js';
import { requireMcIdentity, requireStaffRole, getPrincipal } from '../../middleware/gates.js';
import { readRateLimit, writeRateLimit } from '../../middleware/rateLimit.js';
import { recordAction } from '../../db/actionLog.js';
import { logger } from '../../utils/logger.js';
import { ok, fail } from './respond.js';
import type { AppContextVariables } from '../../types/index.js';

type ApiEnv = { Variables: AppContextVariables };

export const suggestionsV2 = new Hono<ApiEnv>();

/** Plain-text body bounds: short enough to skim, long enough to be an idea. */
const BODY_MIN = 3;
const BODY_MAX = 300;
/** Per-author anti-spam: a pause between posts and a daily ceiling. */
const POST_COOLDOWN_MS = 30_000;
const POSTS_PER_DAY = 10;
/** The board is one screen of the best ideas, not an archive: top 100 rows. */
const LIST_LIMIT = 100;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS suggestions (
  id text primary key,
  author_uuid text not null,
  body text not null,
  hidden integer not null default 0,
  score integer not null default 0,
  created_at integer not null
);`;

const SCHEMA_VOTES = `
CREATE TABLE IF NOT EXISTS suggestion_votes (
  suggestion_id text not null,
  voter_uuid text not null,
  created_at integer not null,
  primary key (suggestion_id, voter_uuid)
)`;

// D1 constraints: prepare() takes ONE statement — two sequential prepares.
async function ensureSchema(): Promise<void> {
  const d1 = getD1();
  await d1.prepare(SCHEMA).run();
  await d1.prepare(SCHEMA_VOTES.trim().replace(/;$/, '')).run();
}

suggestionsV2.use('/suggestions/*', readRateLimit, async (c, next) => {
  try {
    await ensureSchema();
  } catch {
    // D1 unavailable — reads degrade below; writes fail loudly.
  }
  await next();
});

/**
 * The viewer's uuid when one is legitimately present (linked session or
 * delegated service call), else null. NOT a gate — the list is public; this
 * only powers the "you already upvoted this" flag. Anonymous and bare-bot
 * principals get no vote flags.
 */
async function viewerUuid(c: Parameters<typeof getPrincipal>[0]): Promise<string | null> {
  try {
    const p = await getPrincipal(c);
    if (p.kind === 'session') return p.mcUuid;
    if (p.kind === 'delegated') return p.mcUuid;
  } catch {
    // principal resolution must never break a public read
  }
  return null;
}

suggestionsV2.get('/suggestions', async (c) => {
  try {
    const { results } = await getD1()
      .prepare('SELECT id, author_uuid, body, score, created_at FROM suggestions WHERE hidden = 0 ORDER BY score DESC, created_at DESC LIMIT ?')
      .bind(LIST_LIMIT)
      .all<{ id: string; author_uuid: string; body: string; score: number; created_at: number }>();
    const rows = results ?? [];
    // Which of these has the viewer already upvoted? One bounded query; an
    // anonymous viewer skips it entirely.
    const uuid = await viewerUuid(c);
    let mine = new Set<string>();
    if (uuid && rows.length > 0) {
      const { results: voted } = await getD1()
        .prepare('SELECT suggestion_id FROM suggestion_votes WHERE voter_uuid = ? LIMIT 500')
        .bind(uuid)
        .all<{ suggestion_id: string }>();
      mine = new Set((voted ?? []).map((r) => r.suggestion_id));
    }
    return ok(c, {
      suggestions: rows.map((r) => ({
        id: r.id,
        authorUuid: r.author_uuid,
        body: r.body,
        score: r.score,
        createdAt: r.created_at,
        voted: mine.has(r.id),
      })),
    });
  } catch (err) {
    logger.error({ err: String(err) }, 'v2 suggestions list failed');
    return fail(c, 503, 'REGISTRY_UNAVAILABLE', 'Suggestions unavailable.');
  }
});

suggestionsV2.post('/suggestions', writeRateLimit, requireMcIdentity, async (c) => {
  const uuid = c.get('mcUuid');
  if (!uuid) return fail(c, 401, 'UNAUTHORIZED', 'Unauthorized.');
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return fail(c, 400, 'INVALID_PARAM', 'Invalid JSON body.');
  }
  // Plain text only: trim, then length-check. Whatever survives is stored
  // verbatim — no markdown, no HTML processing anywhere in this pipeline.
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, BODY_MAX) : '';
  if (text.length < BODY_MIN) {
    return fail(c, 400, 'INVALID_PARAM', `Suggestion must be ${BODY_MIN}-${BODY_MAX} characters.`);
  }

  const now = Date.now();
  try {
    // Per-author cooldown + daily quota (B-34 discipline, suggestion-sized
    // numbers). A D1 failure here is a 503, not a silent skip.
    const recent = await getD1()
      .prepare('SELECT id FROM suggestions WHERE author_uuid = ? AND created_at > ? LIMIT 1')
      .bind(uuid, now - POST_COOLDOWN_MS)
      .first();
    if (recent) {
      return fail(c, 429, 'RATE_LIMITED', 'Please wait half a minute between suggestions.');
    }
    const dayAgo = now - 24 * 3600 * 1000;
    const { results } = await getD1()
      .prepare('SELECT COUNT(*) AS n FROM suggestions WHERE author_uuid = ? AND created_at > ?')
      .bind(uuid, dayAgo)
      .all<{ n: number }>();
    if (((results ?? [])[0]?.n ?? 0) >= POSTS_PER_DAY) {
      return fail(c, 429, 'RATE_LIMITED', `Daily suggestion limit reached (${POSTS_PER_DAY}/day). Try again tomorrow.`);
    }
  } catch (err) {
    logger.error({ err: String(err) }, 'v2 suggestion quota check failed');
    return fail(c, 503, 'REGISTRY_UNAVAILABLE', 'Suggestions unavailable.');
  }

  const id = 's_' + randomBytes(6).toString('base64url');
  try {
    await getD1()
      .prepare('INSERT INTO suggestions (id, author_uuid, body, hidden, score, created_at) VALUES (?, ?, ?, 0, 0, ?)')
      .bind(id, uuid, text, now)
      .run();
    return c.json({ data: { id } }, 201);
  } catch (err) {
    logger.error({ err: String(err) }, 'v2 suggestion create failed');
    return fail(c, 503, 'REGISTRY_UNAVAILABLE', 'Suggestions unavailable.');
  }
});

suggestionsV2.post('/suggestions/:id/upvote', writeRateLimit, requireMcIdentity, async (c) => {
  const uuid = c.get('mcUuid');
  if (!uuid) return fail(c, 401, 'UNAUTHORIZED', 'Unauthorized.');
  const id = c.req.param('id');
  try {
    // Existence + visibility BEFORE any write: a hidden (or missing) row 404s
    // and never receives a vote.
    const row = await getD1()
      .prepare('SELECT id FROM suggestions WHERE id = ? AND hidden = 0')
      .bind(id)
      .first<{ id: string }>();
    if (!row) return fail(c, 404, 'NOT_FOUND', 'Suggestion not found.');
    // One vote per account + score recompute in ONE batch (B-15): the
    // (suggestion_id, voter_uuid) PK makes the insert idempotent, and the
    // score is recomputed from the votes table, never incremented from a
    // separately-read value. Concurrent upvotes converge to the exact count.
    const results = await getD1().batch([
      getD1()
        .prepare(
          `INSERT INTO suggestion_votes (suggestion_id, voter_uuid, created_at) VALUES (?, ?, ?)
           ON CONFLICT (suggestion_id, voter_uuid) DO NOTHING`,
        )
        .bind(id, uuid, Date.now()),
      getD1()
        .prepare(
          `UPDATE suggestions
              SET score = (SELECT COUNT(*) FROM suggestion_votes WHERE suggestion_id = ?)
            WHERE id = ?`,
        )
        .bind(id, id),
    ]);
    if ((results[1]?.meta.changes ?? 0) === 0) return fail(c, 503, 'REGISTRY_UNAVAILABLE', 'Vote failed.');
    return ok(c, { voted: true });
  } catch (err) {
    logger.error({ err: String(err) }, 'v2 suggestion upvote failed');
    return fail(c, 503, 'REGISTRY_UNAVAILABLE', 'Vote failed.');
  }
});

suggestionsV2.post('/suggestions/:id/moderate', writeRateLimit, requireStaffRole('admin'), async (c) => {
  const id = c.req.param('id');
  let body: { hidden?: unknown };
  try {
    body = (await c.req.json()) as { hidden?: unknown };
  } catch {
    return fail(c, 400, 'INVALID_PARAM', 'Invalid JSON body.');
  }
  if (typeof body.hidden !== 'boolean') {
    return fail(c, 400, 'INVALID_PARAM', 'hidden must be true or false.');
  }
  const hidden = body.hidden ? 1 : 0;
  try {
    const res = await getD1()
      .prepare('UPDATE suggestions SET hidden = ? WHERE id = ?')
      .bind(hidden, id)
      .run();
    if ((res.meta.changes ?? 0) === 0) return fail(c, 404, 'NOT_FOUND', 'Suggestion not found.');
  } catch (err) {
    logger.error({ err: String(err), id }, 'v2 suggestion moderate failed');
    return fail(c, 503, 'REGISTRY_UNAVAILABLE', 'Suggestions unavailable.');
  }
  // Audit: which staff account hid/showed which suggestion.
  const actor = c.get('staffActor');
  await recordAction({
    actor: { id: `staff:${actor?.name ?? 'unknown'}`, name: actor?.name ?? 'unknown' },
    action: 'suggestions.moderate',
    target: id,
    detail: `hidden=${hidden}`,
  });
  logger.info({ id, hidden, by: actor?.name }, 'suggestion moderated');
  return ok(c, { id, hidden: body.hidden });
});
