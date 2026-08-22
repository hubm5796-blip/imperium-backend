/**
 * V6 04-05 — screenshot gallery (the R2-backed UGC feature).
 *
 *   POST /api/v2/community/gallery          requireAuth+linked  multipart → R2 put, status=pending
 *   GET  /api/v2/community/gallery?album=&page=                 public, approved only
 *   GET  /api/v2/community/gallery/img/:key                     public — bytes proxied from R2
 *   POST /api/v2/community/gallery/:id/moderate                 staff (LuckPerms) — approve/remove
 *
 * Identity rule (binding, same as guides): uploads attach to a LINKED Minecraft
 * account — no anonymous UGC. Metadata in D1 (gallery_posts); image bytes in the
 * R2 bucket `imperium-community` via the COMMUNITY_R2 binding (wrangler.jsonc).
 * Serving is proxied through the Worker so the bucket needs no public domain.
 *
 * Upload safety (spec): magic-byte content-type validation (png/jpg/webp only),
 * 5 MB cap, 3 uploads/day per author (D1 sliding window). Gallery posts start
 * `pending` — only staff approval (LuckPerms admin/mod groups, same derivation
 * as /api/permissions) makes them public.
 *
 * Degradation: if the COMMUNITY_R2 binding is absent (config drift), uploads and
 * image serving return 503 — the worker never crashes on a missing binding.
 */
import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import { getD1 } from '../../db/pool.js';
import { query } from '../../db/pool.js';
import { requireLinked } from '../../middleware/auth.js';
import { writeRateLimit } from '../../middleware/rateLimit.js';
import { logger } from '../../utils/logger.js';
import { ok, fail } from './respond.js';
import type { AppContextVariables } from '../../types/index.js';

type ApiEnv = { Variables: AppContextVariables };

export const galleryV2 = new Hono<ApiEnv>();

const ALBUMS = new Set(['base-showcase', 'event-recap', 'spawn-builds', 'community']);
const PAGE_SIZE = 24;
const MAX_BYTES = 5 * 1024 * 1024;
const UPLOADS_PER_DAY = 3;

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS gallery_posts (
     id text primary key,
     author_uuid text not null,
     image_key text not null,
     content_type text not null,
     caption text,
     album text not null,
     status text not null default 'pending',
     created_at integer not null
   )`,
  `CREATE INDEX IF NOT EXISTS idx_gallery_album ON gallery_posts(album, status, created_at DESC)`,
];

let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  const d1 = getD1();
  // D1 constraints: prepare() takes ONE statement, batch() rejects DDL — sequential prepares.
  for (const stmt of SCHEMA_STATEMENTS) {
    await d1.prepare(stmt).run();
  }
  schemaReady = true;
}

interface R2Like {
  put(key: string, value: ArrayBuffer | Uint8Array, opts?: { httpMetadata?: Record<string, string> }): Promise<unknown>;
  get(key: string): Promise<{ body: ReadableStream; httpMetadata?: Record<string, string> } | null>;
}

function r2Bucket(c: { env?: unknown }): R2Like | null {
  const binding = (c.env as Record<string, unknown> | undefined)?.COMMUNITY_R2;
  return binding ? (binding as unknown as R2Like) : null;
}

/** Magic-byte sniffing — the declared content-type is never trusted. */
function detectImageType(b: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (b.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  // WebP: RIFF....WEBP
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

/** Staff derivation — identical group sets to /api/permissions (routes.ts). */
const ADMIN_GROUPS = ['admin', 'sr_admin', 'head_admin', 'developer', 'manager', 'owner'];
const MOD_GROUPS = ['mod', 'sr_mod', 'jr_mod', ...ADMIN_GROUPS];

async function isModerator(uuid: string): Promise<boolean> {
  try {
    const result = await query<{ primary_group: string }>(
      'SELECT primary_group FROM luckperms_players WHERE uuid = $1',
      [uuid],
    );
    const groups = result.rows.map((r) => r.primary_group.toLowerCase());
    return groups.some((g) => MOD_GROUPS.includes(g));
  } catch (err) {
    // Fail closed — an outage locking moderation is traceable, an outage opening it is not.
    logger.warn({ err: String(err), uuid }, 'gallery: LuckPerms group query failed — denying moderation');
    return false;
  }
}

// ── Public: album feed ──────────────────────────────────────────────────────

galleryV2.get('/community/gallery', async (c) => {
  try {
    await ensureSchema();
  } catch {
    return fail(c, 503, 'REGISTRY_UNAVAILABLE', 'Gallery unavailable.');
  }
  const album = c.req.query('album') ?? '';
  const page = Math.max(1, Number.parseInt(c.req.query('page') ?? '1', 10) || 1);
  const byAlbum = album && ALBUMS.has(album);
  try {
    const stmt = byAlbum
      ? getD1().prepare("SELECT id, author_uuid, image_key, caption, album, created_at FROM gallery_posts WHERE status = 'approved' AND album = ? ORDER BY created_at DESC LIMIT ? OFFSET ?").bind(album, PAGE_SIZE, (page - 1) * PAGE_SIZE)
      : getD1().prepare("SELECT id, author_uuid, image_key, caption, album, created_at FROM gallery_posts WHERE status = 'approved' ORDER BY created_at DESC LIMIT ? OFFSET ?").bind(PAGE_SIZE, (page - 1) * PAGE_SIZE);
    const { results } = await stmt.all<{ id: string; author_uuid: string; image_key: string; caption: string | null; album: string; created_at: number }>();
    return ok(c, {
      entries: (results ?? []).map((r) => ({
        id: r.id,
        authorUuid: r.author_uuid,
        imageUrl: `/api/v2/community/gallery/img/${r.image_key}`,
        caption: r.caption ?? '',
        album: r.album,
        createdAt: r.created_at,
      })),
      page,
      albums: [...ALBUMS],
    });
  } catch (err) {
    logger.error({ err: String(err) }, 'gallery list failed');
    return fail(c, 503, 'REGISTRY_UNAVAILABLE', 'Gallery unavailable.');
  }
});

// ── Linked: upload ──────────────────────────────────────────────────────────

galleryV2.post('/community/gallery', requireLinked, writeRateLimit, async (c) => {
  const bucket = r2Bucket(c);
  if (!bucket) return fail(c, 503, 'REGISTRY_UNAVAILABLE', 'Gallery storage is not configured (missing R2 binding).');

  const uuid = c.get('mcUuid');
  if (!uuid) return fail(c, 401, 'UNAUTHORIZED', 'Unauthorized.');

  try {
    await ensureSchema();
  } catch {
    return fail(c, 503, 'REGISTRY_UNAVAILABLE', 'Gallery unavailable.');
  }

  // Upload quota: 3/day per author, D1 sliding window.
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  try {
    const { results } = await getD1()
      .prepare('SELECT COUNT(*) AS n FROM gallery_posts WHERE author_uuid = ? AND created_at > ?')
      .bind(uuid, dayAgo)
      .all<{ n: number }>();
    if (((results ?? [])[0]?.n ?? 0) >= UPLOADS_PER_DAY) {
      return fail(c, 429, 'RATE_LIMITED', `Upload limit reached (${UPLOADS_PER_DAY}/day). Try again tomorrow.`);
    }
  } catch (err) {
    logger.error({ err: String(err) }, 'gallery quota check failed');
    return fail(c, 503, 'REGISTRY_UNAVAILABLE', 'Gallery unavailable.');
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return fail(c, 400, 'INVALID_PARAM', 'Expected multipart/form-data with `image`, `album`, and optional `caption`.');
  }
  const file = form.get('image');
  const album = String(form.get('album') ?? '');
  const caption = String(form.get('caption') ?? '').slice(0, 200);
  if (!(file instanceof File)) return fail(c, 400, 'INVALID_PARAM', 'Missing `image` file field.');
  if (!ALBUMS.has(album)) return fail(c, 400, 'INVALID_PARAM', `Unknown album. Valid: ${[...ALBUMS].join(', ')}.`);
  if (file.size > MAX_BYTES) return fail(c, 400, 'INVALID_PARAM', 'Image exceeds the 5 MB limit.');

  const bytes = new Uint8Array(await file.arrayBuffer());
  const contentType = detectImageType(bytes);
  if (!contentType) return fail(c, 400, 'INVALID_PARAM', 'Unsupported image type — PNG, JPEG, or WebP only.');

  const id = randomBytes(8).toString('hex');
  const ext = contentType === 'image/png' ? 'png' : contentType === 'image/jpeg' ? 'jpg' : 'webp';
  const key = `gallery/${uuid.replace(/-/g, '').slice(0, 8)}-${id}.${ext}`;

  await bucket.put(key, bytes, {
    httpMetadata: { contentType, cacheControl: 'public, max-age=31536000, immutable' },
  });
  await getD1()
    .prepare("INSERT INTO gallery_posts (id, author_uuid, image_key, content_type, caption, album, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)")
    .bind(id, uuid, key, contentType, caption || null, album, Date.now())
    .run();
  logger.info({ id, album, author: uuid }, 'gallery upload accepted (pending review)');
  return ok(c, { id, status: 'pending', album, message: 'Uploaded — a staff member will review it shortly.' });
});

// ── Public: image bytes proxied from R2 ─────────────────────────────────────

galleryV2.get('/community/gallery/img/:key', async (c) => {
  const bucket = r2Bucket(c);
  if (!bucket) return fail(c, 503, 'REGISTRY_UNAVAILABLE', 'Gallery storage is not configured.');
  // Key shape enforced: gallery/<hex>.<ext> — no path traversal into other prefixes.
  const key = c.req.param('key');
  if (!/^gallery\/[a-f0-9-]+\.(png|jpg|webp)$/.test(key)) return fail(c, 400, 'INVALID_PARAM', 'Bad key.');
  const obj = await bucket.get(key);
  if (!obj) return fail(c, 404, 'NOT_FOUND', 'Not found.');
  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType ?? 'application/octet-stream',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
});

// ── Staff: moderation ───────────────────────────────────────────────────────

galleryV2.post('/community/gallery/:id/moderate', requireLinked, writeRateLimit, async (c) => {
  const uuid = c.get('mcUuid');
  if (!uuid) return fail(c, 401, 'UNAUTHORIZED', 'Unauthorized.');
  if (!(await isModerator(uuid))) return fail(c, 403, 'FORBIDDEN', 'Staff only.');

  try {
    await ensureSchema();
  } catch {
    return fail(c, 503, 'REGISTRY_UNAVAILABLE', 'Gallery unavailable.');
  }
  const id = c.req.param('id');
  let body: { action?: string };
  try {
    body = (await c.req.json()) as { action?: string };
  } catch {
    return fail(c, 400, 'INVALID_PARAM', 'Invalid JSON body.');
  }
  if (body.action !== 'approve' && body.action !== 'remove') {
    return fail(c, 400, 'INVALID_PARAM', 'action must be "approve" or "remove".');
  }
  const status = body.action === 'approve' ? 'approved' : 'removed';
  try {
    await getD1().prepare('UPDATE gallery_posts SET status = ? WHERE id = ?').bind(status, id).run();
  } catch (err) {
    logger.error({ err: String(err), id }, 'gallery moderate failed');
    return fail(c, 503, 'REGISTRY_UNAVAILABLE', 'Gallery unavailable.');
  }
  logger.info({ id, status, by: uuid }, 'gallery moderated');
  return ok(c, { id, status });
});
