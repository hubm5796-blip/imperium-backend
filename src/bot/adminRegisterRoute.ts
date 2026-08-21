/**
 * V6 02-09 companion — POST /api/admin/bot/register-commands: the Worker
 * registers its own slash commands with Discord using the secrets only it
 * holds (env.discord.botToken/clientId). The local .env copies of those
 * credentials are stale, so the tsx registerCommands script cannot run from
 * the dev machine — but the deployed Worker always has the live values.
 *
 * Auth: the WEBPANEL_HMAC secret (the same trust the Redis command bus uses —
 * possession of the secret is authority). Headers:
 *   X-Timestamp: unix seconds (±120s replay window)
 *   X-Nonce:     random string
 *   X-Signature: hex HMAC-SHA256(secret, "<timestamp>|<nonce>")
 */
import { Hono } from 'hono';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';
import { commands } from './commands/index.js';
import { writeRateLimit } from '../middleware/rateLimit.js';
import { logger } from '../utils/logger.js';

export const botAdmin = new Hono();

const REPLAY_WINDOW_SECONDS = 120;

/** Timing-safe hex compare of the expected vs provided HMAC signature. */
function signatureOk(provided: string, expected: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

function authorized(headers: Headers): boolean {
  const secret = env.webpanelHmacSecret;
  const ts = headers.get('X-Timestamp') ?? '';
  const nonce = headers.get('X-Nonce') ?? '';
  const sig = headers.get('X-Signature') ?? '';
  if (!secret || !ts || !nonce || !sig) return false;
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - tsNum) > REPLAY_WINDOW_SECONDS) return false;
  const expected = createHmac('sha256', secret).update(`${ts}|${nonce}`).digest('hex');
  return signatureOk(sig, expected);
}

botAdmin.post('/bot/register-commands', writeRateLimit, async (c) => {
  const h = c.req.header();
  if (!authorized(new Headers(Object.entries(h)))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = env.discord.botToken;
  const clientId = env.discord.clientId;
  if (!token || !clientId) {
    return c.json({ error: 'Discord credentials not configured on the Worker' }, 503);
  }

  const payload = commands.map((cmd) => cmd.toJSON());
  try {
    const res = await fetch(`https://discord.com/api/v10/applications/${clientId}/commands`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bot ${token}` },
      body: JSON.stringify(payload),
    });
    const json = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      logger.error({ status: res.status, body: JSON.stringify(json)?.slice(0, 400) }, 'bot command registration failed');
      return c.json({ error: 'Discord rejected the registration', detail: json }, 502);
    }
    const names = Array.isArray(json) ? (json as Array<{ name: string }>).map((x) => x.name) : [];
    logger.info({ count: names.length }, 'bot slash commands registered');
    return c.json({ registered: names });
  } catch (err) {
    logger.error({ err: String(err) }, 'bot command registration crashed');
    return c.json({ error: 'Registration request failed' }, 502);
  }
});
