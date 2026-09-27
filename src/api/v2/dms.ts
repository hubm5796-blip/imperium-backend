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
import { logger } from '../../utils/logger.js';
import { env } from '../../env.js';
import type { AppContextVariables } from '../../types/index.js';

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
          footer: { text: 'ImperiumMC • imperiummc.net' },
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

changelogApi.use('/changelog*', readRateLimit, requireServiceToken);

/**
 * POST /api/v2/changelog/post
 * Body: { title, description, changes: string[] }
 * Posts the changelog embed to the configured channel (CHANGELOG_CHANNEL_ID).
 * Unconfigured → 503; no fallback channel exists (B-23).
 */
changelogApi.post('/changelog/post', writeRateLimit, async (c) => {
  let body: Record<string, unknown> = {};
  try {
    const raw = await c.req.json();
    if (raw && typeof raw === 'object') body = raw as Record<string, unknown>;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const title = typeof body.title === 'string' ? body.title.slice(0, 200) : '';
  const description = typeof body.description === 'string' ? body.description.slice(0, 1000) : '';
  const changes = Array.isArray(body.changes)
    ? (body.changes as unknown[]).filter((c): c is string => typeof c === 'string').slice(0, 25)
    : [];

  if (!title || changes.length === 0) {
    return c.json({ error: 'title and at least one change are required' }, 400);
  }

  const channelId = env.changelogChannelId;
  const botToken = env.discord.botToken;
  if (!channelId || !botToken) {
    return c.json({ error: 'Changelog channel not configured' }, 503);
  }

  // Build the embed
  const embed = {
    title: `📜 ${title}`,
    description: description || undefined,
    color: 0xd4af37,
    fields: changes.map((change) => ({
      name: '•',
      value: change.slice(0, 1000),
    })),
    footer: { text: 'ImperiumMC • imperiummc.net' },
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
    return c.json({ posted: true });
  } catch (err) {
    logger.error({ err: String(err) }, 'changelog post crashed');
    return c.json({ error: 'Post failed' }, 502);
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
