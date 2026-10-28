/**
 * V6 — Discord DM notifications for linked players + changelog posting.
 *
 * DM NOTIFICATIONS: when the game emits an event that affects a player (punishment,
 * ticket response, purchase delivery, rank-up milestone), the backend resolves the
 * player's linked Discord and DMs them. Opt-in by design (linking IS the opt-in).
 *
 * CHANGELOG: posts the formatted changelog to the owner's configured channel
 * (CHANGELOG_CHANNEL_ID). Unconfigured = 503 — there is NO hardcoded fallback
 * channel anymore (B-23: caller content speaking as the server must not have
 * a default audience).
 *
 * B-23 hardening:
 *   - Both surfaces demand the INTERNAL_SERVICE_TOKEN (see
 *     middleware/serviceToken.ts) — the shared bot token no longer confers
 *     the right to speak as the server.
 *   - DM enqueue validates the uuid shape, allowlists the notification type,
 *     and caps per-target queue depth (a rotating-uuid spammer can't fill
 *     one player's DMs).
 *   - Queue drains CLAIM each row (status flip) before sending, so
 *     overlapping cron isolates can't double-deliver.
 */
import { Hono } from 'hono';
import { getDiscordIdByUuid, getD1 } from '../../db/pool.js';
import { readRateLimit, writeRateLimit } from '../../middleware/rateLimit.js';
import { requireServiceToken } from '../../middleware/serviceToken.js';
import { parseMcUuid } from '../../middleware/gates.js';
import { recordAction } from '../../db/actionLog.js';
import { recordChangelogPost, pruneDuplicateChangelogPosts } from '../../db/changelogStore.js';
import { listChangelogEntries, upsertChangelogEntry } from '../../changelog/store.js';
import { CHANGELOG_PRODUCTS, isChangelogProduct } from '../../changelog/types.js';
import type { ChangelogProduct } from '../../changelog/types.js';
import { resolveAuditActor } from '../../utils/auditActor.js';
import { logger } from '../../utils/logger.js';
import { env } from '../../env.js';
import type { AppContextVariables } from '../../types/index.js';
import { limitParam } from '../../utils/paging.js';

type ApiEnv = { Variables: AppContextVariables };

// ── DM notification types ──────────────────────────────────────────────────
export interface DmNotification {
  uuid: string;            // the Minecraft player UUID
  type: DmType;            // allowlisted below — free-form types are rejected
  title: string;           // bold title
  message: string;         // body text
  color?: number;          // embed color (defaults by type)
}

/** Closed allowlist (B-23): `type` used to ride into DM_COLORS lookups and the
 *  queue untouched — any string was storable and later rendered. */
const DM_TYPES = ['punishment', 'ticket_reply', 'purchase', 'rank_up', 'vote', 'security'] as const;
type DmType = (typeof DM_TYPES)[number];
function isDmType(value: string): value is DmType {
  return (DM_TYPES as readonly string[]).includes(value);
}

const DM_COLORS: Record<string, number> = {
  punishment: 0xdc2626,
  ticket_reply: 0x3b82f6,
  purchase: 0x16a34a,
  rank_up: 0xd4af37,
  vote: 0x8b5cf6,
  security: 0xf59e0b,
};

const DM_ICONS: Record<string, string> = {
  punishment: '⚖',
  ticket_reply: '🎫',
  purchase: '📦',
  rank_up: '⬆',
  vote: '🗳',
  security: '🔒',
};

// ── D1 persistence (so the cron can retry failed DMs) ─────────────────────
const SCHEMA = `
CREATE TABLE IF NOT EXISTS dm_queue (
  id text primary key,
  uuid text not null,
  discord_id text not null,
  type text not null,
  title text not null,
  message text not null,
  color integer,
  status text not null default 'pending',
  attempts integer not null default 0,
  created_at integer not null,
  sent_at integer
)`;

/** Claim bookkeeping column (B-23): when a row entered 'sending'. Added
 *  best-effort — SQLite has no ADD COLUMN IF NOT EXISTS, so a duplicate
 *  -column error is the deployed-already case and swallowed. */
const SCHEMA_CLAIMED_AT = `ALTER TABLE dm_queue ADD COLUMN claimed_at integer`;
const CLAIM_LEASE_MS = 120_000;
/** Per-target pending cap: a linked Discord can hold at most this many unsent
 *  rows less than an hour old (B-23 per-target caps). */
const TARGET_HOURLY_CAP = 10;

async function ensureSchema(): Promise<void> {
  const d1 = getD1();
  await d1.prepare(SCHEMA).run();
  try {
    await d1.prepare(SCHEMA_CLAIMED_AT).run();
  } catch {
    // Column already exists — deployed before the claim rework.
  }
}

// ── The bot-side DM sender (needs the live bot token) ─────────────────────
const DISCORD_TIMEOUT_MS = 8_000;

async function sendDm(botToken: string, discordId: string, notif: DmNotification): Promise<boolean> {
  try {
    // Open DM channel
    const channelRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${botToken}` },
      body: JSON.stringify({ recipient_id: discordId }),
      signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
    });
    if (!channelRes.ok) return false;
    const channel = (await channelRes.json()) as { id?: string };
    if (!channel.id) return false;

    // Send embed DM (no mentions ever resolve — B-23 allowed_mentions)
    const color = notif.color ?? DM_COLORS[notif.type] ?? 0xd4af37;
    const icon = DM_ICONS[notif.type] ?? '📢';
    const msgRes = await fetch(`https://discord.com/api/v10/channels/${channel.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${botToken}` },
      body: JSON.stringify({
        allowed_mentions: { parse: [] },
        embeds: [{
          title: `${icon} ${notif.title}`,
          description: notif.message,
          color,
          footer: { text: 'Romanica - romanica.net' },
          timestamp: new Date().toISOString(),
        }],
      }),
      signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
    });
    return msgRes.ok;
  } catch {
    return false;
  }
}

// ── API routes ──────────────────────────────────────────────────────────────
export const dmApi = new Hono<ApiEnv>();

dmApi.use('/notifications*', readRateLimit, requireServiceToken);

/**
 * POST /api/v2/notifications/dm
 * Body: { uuid, type, title, message }
 * Queues a DM to the player's linked Discord. If the player has no Discord
 * linked, returns { queued: false, reason: 'not_linked' } (not an error —
 * the game-side caller should just skip).
 */
dmApi.post('/notifications/dm', writeRateLimit, async (c) => {
  let body: Record<string, unknown>;
  try { body = (await c.req.json()) as Record<string, unknown>; } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const uuidRaw = typeof body.uuid === 'string' ? body.uuid : '';
  const type = typeof body.type === 'string' ? body.type : '';
  const title = typeof body.title === 'string' ? body.title.slice(0, 200) : '';
  const message = typeof body.message === 'string' ? body.message.slice(0, 2000) : '';

  // B-23: uuid shape-validated + normalized (garbage used to cost a DB lookup
  // and could queue rows keyed to junk identities).
  const uuid = parseMcUuid(uuidRaw);
  if (!uuid) return c.json({ error: 'uuid must be a Minecraft UUID' }, 400);
  if (!isDmType(type)) {
    return c.json({ error: `type must be one of: ${DM_TYPES.join(', ')}` }, 400);
  }
  if (!title || !message) {
    return c.json({ error: 'title and message are required' }, 400);
  }

  // Resolve the Discord ID
  let discordId: string | null = null;
  try {
    discordId = await getDiscordIdByUuid(uuid);
  } catch { /* DB blip */ }

  if (!discordId) {
    return c.json({ queued: false, reason: 'not_linked' });
  }

  // Queue in D1 for the cron to deliver (with retry)
  try {
    await ensureSchema();
    // B-23 per-target cap: at most TARGET_HOURLY_CAP pending rows per Discord
    // account per hour — a compromised caller rotating uuids cannot trench one
    // player, and a runaway game loop cannot either.
    const recent = await getD1()
      .prepare("SELECT COUNT(*) AS n FROM dm_queue WHERE discord_id = ? AND created_at > ? AND status = 'pending'")
      .bind(discordId, Date.now() - 3_600_000)
      .first<{ n: number }>();
    if ((recent?.n ?? 0) >= TARGET_HOURLY_CAP) {
      c.header('Retry-After', '3600');
      return c.json({ error: 'Too many queued notifications for this recipient', cap: TARGET_HOURLY_CAP }, 429);
    }
    const id = 'dm_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    await getD1()
      .prepare('INSERT INTO dm_queue (id, uuid, discord_id, type, title, message, color, status, attempts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, uuid, discordId, type, title, message, DM_COLORS[type] ?? 0xd4af37, 'pending', 0, Date.now())
      .run();
    return c.json({ queued: true, id });
  } catch (err) {
    logger.error({ err: String(err) }, 'dm queue insert failed');
    return c.json({ error: 'Queue failed' }, 500);
  }
});

// ── Changelog posting ──────────────────────────────────────────────────────
export const changelogApi = new Hono<ApiEnv>();

/**
 * GET /api/v2/changelog/list?limit=5&product=server — public, cacheable read
 * of the ONE changelog store (D1, changelog_entry; see src/changelog/store.ts).
 * Serves every origin: the imported site updates (id = the site slug, so
 * /changelog/<slug> permalinks resolve), Discord-posted server changelogs and
 * synced GitHub releases. Optional exact `product` filter (400 on anything
 * outside the vocabulary); stable newest-first ordering (date DESC, id DESC).
 * Each entry carries its product, version and links. The service-token guard
 * below is mounted on /changelog/post and /changelog/release only — this list
 * is what the /changelog bot command, the website and the client title screen
 * read (client tokens: explicitly allowlisted in middleware/gates.ts).
 */
changelogApi.get('/changelog/list', readRateLimit, async (c) => {
  const limit = limitParam(c.req.query('limit'), 5, 200);
  const productParam = c.req.query('product');
  let product: ChangelogProduct | undefined;
  if (productParam) {
    if (!isChangelogProduct(productParam)) {
      return c.json({ error: `product must be one of: ${CHANGELOG_PRODUCTS.join(', ')}` }, 400);
    }
    product = productParam;
  }
  const entries = await listChangelogEntries({ limit, product });
  c.header('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
  return c.json({
    // Straight from the store's single source (src/changelog/types.ts) so no
    // consumer hardcodes a second copy of the vocabulary.
    products: CHANGELOG_PRODUCTS,
    count: entries.length,
    posts: entries.map((p) => ({
      id: p.id,
      product: p.product,
      version: p.version,
      title: p.title,
      lead: p.summary, // legacy alias (pre-#9 consumers read `lead`)
      summary: p.summary,
      postedAt: new Date(p.date).toISOString(), // legacy alias — same instant as `date`
      date: new Date(p.date).toISOString(),
      sections: p.body.sections ?? (p.body.changes?.length ? [{ name: 'Changes', changes: p.body.changes }] : []),
      keyChanges: p.body.keyChanges ?? [],
      action: p.body.action ?? null,
      tags: p.body.tags ?? [],
      links: p.links,
      related: p.related,
      syncedAt: p.syncedAt !== null ? new Date(p.syncedAt).toISOString() : null,
    })),
  });
});

changelogApi.use('/changelog/post*', readRateLimit, requireServiceToken);

/**
 * POST /api/v2/changelog/prune - service-token-gated on-demand dedup pass (the
 * same hygiene ensure() runs per isolate; the operator's manual lever when a
 * replaced post's stale row lingers, e.g. after an offline re-post).
 */
changelogApi.post('/changelog/prune', writeRateLimit, requireServiceToken, async (c) => {
  const removed = await pruneDuplicateChangelogPosts();
  return c.json({ pruned: removed });
});

/**
 * POST /api/v2/changelog/post
 * Body: { title, description, changes: string[] }
 * Posts the changelog embed to the configured channel (CHANGELOG_CHANNEL_ID).
 * Unconfigured → 503; no fallback channel exists (B-23).
 */
  // Owner-facing garble guard (2026-09-28): some clients render em-dashes, middle
  // dots, curly quotes and multiplication signs as replacement characters. Every
  // string that reaches a Discord embed passes through asciify() first — plain
  // ASCII regardless of what the caller composed.
  const asciify = (input: string): string => input
    .replace(/[\u2014\u2013]/g, '-')
    .replace(/[\u2022\u00b7]/g, '-')
    .replace(/\u00d7/g, 'x')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7e]/g, '');

changelogApi.post('/changelog/post', writeRateLimit, async (c) => {
  let body: Record<string, unknown> = {};
  try {
    const raw = await c.req.json();
    if (raw && typeof raw === 'object') body = raw as Record<string, unknown>;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const title = typeof body.title === 'string' ? asciify(body.title).slice(0, 200) : '';
  const description = typeof body.description === 'string' ? asciify(body.description).slice(0, 1000) : '';
  const changes = Array.isArray(body.changes)
    ? (body.changes as unknown[]).filter((c): c is string => typeof c === 'string').slice(0, 25)
    : [];
  // Optional grouping: sections: [{ name, changes: [] }] renders as bold headers
  // over bullet lists; the flat changes[] renders as one bullet list.
  const sections = Array.isArray(body.sections)
    ? (body.sections as Record<string, unknown>[])
        .filter((sec) => sec && typeof sec.name === 'string' && Array.isArray(sec.changes))
        .map((sec) => ({
          name: asciify(String(sec.name).slice(0, 100)),
          changes: (sec.changes as unknown[]).filter((c): c is string => typeof c === 'string').slice(0, 25),
        }))
        .filter((sec) => sec.changes.length > 0)
        .slice(0, 8)
    : [];

  if (!title || (changes.length === 0 && sections.length === 0)) {
    return c.json({ error: 'title and at least one change are required' }, 400);
  }

  // Optional product stamping (#9): Discord posts are server changelogs unless
  // the caller says otherwise. Validated against the store's vocabulary.
  const product = typeof body.product === 'string' && body.product !== '' ? body.product : 'server';
  if (!isChangelogProduct(product)) {
    return c.json({ error: `product must be one of: ${CHANGELOG_PRODUCTS.join(', ')}` }, 400);
  }
  const version = typeof body.version === 'string' && body.version.trim() !== '' ? body.version.trim().slice(0, 50) : null;

  const channelId = env.changelogChannelId;
  const botToken = env.discord.botToken;
  if (!channelId || !botToken) {
    return c.json({ error: 'Changelog channel not configured' }, 503);
  }

  // Body: markdown bullets in the description. The old per-change '•' FIELDS
  // rendered as a wall of one-line name/value rows on Discord — bold section
  // headers over bullet lists reads like a changelog instead of a receipt.
  const sectionText = sections
    .map((sec) => `**${sec.name}**\n${sec.changes.map((c) => '- ' + asciify(c).slice(0, 500)).join('\n')}`)
    .join('\n\n');
  const flatText = changes.map((c) => '- ' + c.slice(0, 500)).join('\n');
  const lead = description ? description + '\n\n' : '';
  const embed = {
    title: title,
    description: (lead + (sectionText || flatText)).slice(0, 4000),
    color: 0xcea464,
    footer: { text: 'Romanica • romanica.net' },
    timestamp: new Date().toISOString(),
  };

  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${botToken}` },
      body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      const errBody = await res.text();
      logger.error({ status: res.status, body: errBody.slice(0, 300) }, 'changelog post failed');
      return c.json({ error: `Discord returned ${res.status}` }, 502);
    }
    // Per-actor audit attribution: a changelog post speaks as the server, so
    // the action_log must name WHO triggered it — a per-staff token / session
    // when a human posted, the service identity for the owner's script, and
    // the shared-bot attribution only as the no-actor fallback.
    const actor = await resolveAuditActor(c);
    await recordAction({
      actor,
      action: 'changelog.post',
      target: title.slice(0, 120),
      detail: `channel=${channelId}`,
    });
    // Durable record for /api/v2/changelog/list + the /changelog bot command
    // (write-after-action; a store failure never fails the delivered post).
    // Dual-writes the legacy table AND the canonical changelog_entry store
    // (same id) — see db/changelogStore.ts.
    await recordChangelogPost({
      title,
      lead: description,
      sections: sections.map((s) => ({ name: s.name, changes: s.changes })),
      changes,
      product,
      version,
    });
    return c.json({ posted: true, actor: actor.id });
  } catch (err) {
    logger.error({ err: String(err) }, 'changelog post crashed');
    return c.json({ error: 'Post failed' }, 502);
  }
});

// ── GitHub release sync (#9) ────────────────────────────────────────────────
// POST /api/v2/changelog/release — the upsert endpoint of the release-sync
// design. A sync job (follow-up wiring: a scheduled() step per product repo —
// client, launcher, pack — that lists GitHub releases newer than the last
// syncedAt and POSTs each one here) turns a release into a changelog entry
// WITHOUT hand-posting. The endpoint is the contract; the cron is a follow-up.
//
// Idempotency: the id defaults to the deterministic `<product>-<version>`, so
// replaying the same release (retry, cron re-run, backfill) UPSERTS one row —
// never a duplicate — and refreshes synced_at. Different versions coexist.
// Unlike the curated store path, failures here are REPORTED (502), not
// absorbed: a sync that lies about success is worse than a retry.
changelogApi.use('/changelog/release*', readRateLimit, requireServiceToken);

changelogApi.post('/changelog/release', writeRateLimit, async (c) => {
  let body: Record<string, unknown> = {};
  try {
    const raw = await c.req.json();
    if (raw && typeof raw === 'object') body = raw as Record<string, unknown>;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const product = typeof body.product === 'string' ? body.product : '';
  if (!isChangelogProduct(product)) {
    return c.json({ error: `product must be one of: ${CHANGELOG_PRODUCTS.join(', ')}` }, 400);
  }
  const version = typeof body.version === 'string' ? body.version.trim() : '';
  if (!/^[A-Za-z0-9._+-]{1,50}$/.test(version)) {
    return c.json({ error: 'version is required (1-50 chars of [A-Za-z0-9._+-])' }, 400);
  }
  const title = typeof body.title === 'string' && body.title.trim() !== '' ? body.title.trim().slice(0, 200) : `${product} ${version}`;
  const markdown = typeof body.body === 'string' ? body.body : '';
  if (!markdown.trim()) return c.json({ error: 'body is required (release notes)' }, 400);
  if (markdown.length > 32_000) return c.json({ error: 'body must be 32,000 characters or fewer' }, 400);

  // Summary: caller-supplied, else the first non-empty line of the notes with
  // markdown list/heading prefixes stripped — enough for a one-line lead.
  const summary =
    typeof body.summary === 'string' && body.summary.trim() !== ''
      ? body.summary.trim().slice(0, 300)
      : markdown
          .split('\n')
          .map((l) => l.replace(/^#{1,6}\s*|^[-*]\s*|^\d+\.\s*/, '').trim())
          .find((l) => l !== '')
          ?.slice(0, 300) ?? title;

  // date: release publication date (ms epoch); defaults to now.
  let date = Date.now();
  if (body.date !== undefined) {
    const parsed = typeof body.date === 'number' ? body.date : typeof body.date === 'string' ? Date.parse(body.date) : NaN;
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return c.json({ error: 'date must be an epoch-ms number or an ISO date string' }, 400);
    }
    date = parsed;
  }

  // links: release URL must be https; pr/issue accept a number string or URL.
  const links: { release?: string; pr?: string; issue?: string } = {};
  if (body.releaseUrl !== undefined) {
    const releaseUrl = typeof body.releaseUrl === 'string' ? body.releaseUrl : '';
    if (!/^https:\/\/[\w.-]+(:\d+)?(\/[\w.\-~/]*)?$/.test(releaseUrl) || releaseUrl.length > 500) {
      return c.json({ error: 'releaseUrl must be an https URL' }, 400);
    }
    links.release = releaseUrl;
  }
  for (const key of ['pr', 'issue'] as const) {
    const raw = body[key];
    if (raw === undefined) continue;
    const value = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
    if (/^\d{1,12}$/.test(value) || /^https:\/\/[\w.-]+(\/[\w.\-~/]*)?$/.test(value)) {
      links[key] = value.slice(0, 500);
    } else {
      return c.json({ error: `${key} must be a number or an https URL` }, 400);
    }
  }

  const related = Array.isArray(body.related)
    ? (body.related as unknown[]).filter((r): r is string => typeof r === 'string' && /^[\w.-]{1,120}$/.test(r)).slice(0, 20)
    : [];

  // Deterministic id (the idempotency anchor); an explicit id must stay slug-like.
  const id = typeof body.id === 'string' && body.id !== '' ? body.id.trim() : `${product}-${version}`;
  if (!/^[\w.-]{1,140}$/.test(id)) {
    return c.json({ error: 'id must be 1-140 chars of [A-Za-z0-9._-]' }, 400);
  }

  try {
    const result = await upsertChangelogEntry({
      id,
      date,
      product,
      version,
      title,
      summary,
      body: { markdown },
      links,
      related,
      syncedAt: Date.now(), // the sync stamp — every successful upsert refreshes it
    });
    // Per-actor audit attribution (same doctrine as /changelog/post): a sync
    // speaks with the service principal's identity; an audit failure must not
    // undo the committed upsert.
    try {
      const actor = await resolveAuditActor(c);
      await recordAction({
        actor,
        action: 'changelog.release.sync',
        target: id,
        detail: `${product}@${version} created=${result.created}`,
      });
    } catch (err) {
      logger.warn({ err: String(err) }, 'changelog release sync audit write failed (upsert committed)');
    }
    return c.json({ upserted: true, id, created: result.created, product, version });
  } catch (err) {
    logger.error({ err: String(err) }, 'changelog release sync failed');
    return c.json({ error: 'Sync failed' }, 502);
  }
});

// ── Cron: deliver pending DMs ──────────────────────────────────────────────
export async function processDmQueue(botToken: string): Promise<{ sent: number; failed: number; skipped: number }> {
  const out = { sent: 0, failed: 0, skipped: 0 };
  try {
    await ensureSchema();
    const now = Date.now();
    // B-23/B-39: claim-based drain. A row is due when pending, or when a
    // previous isolate died mid-send and its 'sending' lease expired —
    // overlapping cron ticks used to SELECT the same pending rows and
    // double-DM.
    const { results } = await getD1()
      .prepare(
        "SELECT id, uuid, discord_id, type, title, message, color, attempts FROM dm_queue " +
          "WHERE (status = 'pending' AND attempts < 3) OR (status = 'sending' AND claimed_at IS NOT NULL AND claimed_at < ?) " +
          'ORDER BY created_at LIMIT 10',
      )
      .bind(now - CLAIM_LEASE_MS)
      .all<{ id: string; uuid: string; discord_id: string; type: string; title: string; message: string; color: number; attempts: number }>();
    for (const row of results ?? []) {
      // Atomic claim: only the isolate that flips pending→sending (or renews
      // an expired lease) gets to send. UPDATE is conditional so two racing
      // drains cannot both win.
      const claim = await getD1()
        .prepare(
          "UPDATE dm_queue SET status = 'sending', claimed_at = ? WHERE id = ? AND ((status = 'pending' AND attempts < 3) OR (status = 'sending' AND claimed_at IS NOT NULL AND claimed_at < ?))",
        )
        .bind(now, row.id, now - CLAIM_LEASE_MS)
        .run();
      if ((claim.meta.changes ?? 0) === 0) continue; // lost the race — other isolate owns it

      const ok = await sendDm(botToken, row.discord_id, {
        uuid: row.uuid,
        // Rows queued before the allowlist may carry unknown types — render
        // them under the security styling rather than rejecting the send.
        type: isDmType(row.type) ? row.type : 'security',
        title: row.title,
        message: row.message,
        color: row.color,
      });
      if (ok) {
        await getD1().prepare("UPDATE dm_queue SET status = 'sent', sent_at = ? WHERE id = ?").bind(Date.now(), row.id).run();
        out.sent++;
      } else {
        const attempts = row.attempts + 1;
        const status = attempts >= 3 ? 'failed' : 'pending';
        await getD1().prepare('UPDATE dm_queue SET attempts = ?, status = ? WHERE id = ?').bind(attempts, status, row.id).run();
        if (status === 'failed') out.failed++; else out.skipped++;
      }
    }
  } catch (err) {
    logger.error({ err: String(err) }, 'dm queue process failed');
  }
  return out;
}
