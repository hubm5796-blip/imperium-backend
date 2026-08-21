/**
 * V6 — Discord DM notifications for linked players + changelog posting.
 *
 * DM NOTIFICATIONS: when the game emits an event that affects a player (punishment,
 * ticket response, purchase delivery, rank-up milestone), the backend resolves the
 * player's linked Discord and DMs them. Opt-in by design (linking IS the opt-in).
 *
 * CHANGELOG: posts the formatted changelog to the owner's configured channel.
 * Set CHANGELOG_CHANNEL_ID + the bot must be in the guild.
 */
import { Hono } from 'hono';
import { getDiscordIdByUuid } from '../../db/pool.js';
import { botTokenMatches } from '../../middleware/auth.js';
import { readRateLimit, writeRateLimit } from '../../middleware/rateLimit.js';
import { getD1 } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { env } from '../../env.js';
import type { AppContextVariables } from '../../types/index.js';

type ApiEnv = { Variables: AppContextVariables };

// ── DM notification types ──────────────────────────────────────────────────
export interface DmNotification {
  uuid: string;            // the Minecraft player UUID
  type: 'punishment' | 'ticket_reply' | 'purchase' | 'rank_up' | 'vote' | 'security';
  title: string;           // bold title
  message: string;         // body text
  color?: number;          // embed color (defaults by type)
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

async function ensureSchema(): Promise<void> {
  await getD1().prepare(SCHEMA).run();
}

// ── The bot-side DM sender (needs the live bot token) ─────────────────────
async function sendDm(botToken: string, discordId: string, notif: DmNotification): Promise<boolean> {
  try {
    // Open DM channel
    const channelRes = await fetch('https://discord.com/api/v10/users/@me/channels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${botToken}` },
      body: JSON.stringify({ recipient_id: discordId }),
    });
    if (!channelRes.ok) return false;
    const channel = (await channelRes.json()) as { id?: string };
    if (!channel.id) return false;

    // Send embed DM
    const color = notif.color ?? DM_COLORS[notif.type] ?? 0xd4af37;
    const icon = DM_ICONS[notif.type] ?? '📢';
    const msgRes = await fetch(`https://discord.com/api/v10/channels/${channel.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${botToken}` },
      body: JSON.stringify({
        embeds: [{
          title: `${icon} ${notif.title}`,
          description: notif.message,
          color,
          footer: { text: 'ImperiumMC • imperiummc.net' },
          timestamp: new Date().toISOString(),
        }],
      }),
    });
    return msgRes.ok;
  } catch {
    return false;
  }
}

// ── API routes ──────────────────────────────────────────────────────────────
export const dmApi = new Hono<ApiEnv>();

dmApi.use('*', readRateLimit, async (c, next) => {
  if (!botTokenMatches(c)) return c.json({ error: 'Unauthorized' }, 401);
  await next();
});

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

  const uuid = typeof body.uuid === 'string' ? body.uuid : '';
  const type = typeof body.type === 'string' ? body.type : '';
  const title = typeof body.title === 'string' ? body.title.slice(0, 200) : '';
  const message = typeof body.message === 'string' ? body.message.slice(0, 2000) : '';

  if (!uuid || !title || !message) {
    return c.json({ error: 'uuid, title, and message are required' }, 400);
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
    const id = 'dm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
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

changelogApi.use('*', readRateLimit, async (c, next) => {
  if (!botTokenMatches(c)) return c.json({ error: 'Unauthorized' }, 401);
  await next();
});

/**
 * POST /api/v2/changelog/post
 * Body: { title, description, changes: string[] }
 * Posts the changelog embed to the configured channel.
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

  const channelId = env.changelogChannelId || '1430014299425738752'; // owner's changelog channel
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
      body: JSON.stringify({ embeds: [embed] }),
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
    const { results } = await getD1()
      .prepare("SELECT id, uuid, discord_id, type, title, message, color, attempts FROM dm_queue WHERE status = 'pending' AND attempts < 3 ORDER BY created_at LIMIT 10")
      .all<{ id: string; uuid: string; discord_id: string; type: string; title: string; message: string; color: number; attempts: number }>();
    for (const row of results ?? []) {
      const ok = await sendDm(botToken, row.discord_id, {
        uuid: row.uuid,
        type: row.type as DmNotification['type'],
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
