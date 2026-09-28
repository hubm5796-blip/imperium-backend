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
 *   X-Nonce:     random string — SINGLE-USE: stored via SET NX with a TTL
 *                covering the window, so a captured request cannot be
 *                replayed even within the ±120s window (B-10; it previously
 *                only existed to be signed)
 *   X-Signature: hex HMAC-SHA256(secret, "<timestamp>|<nonce>")
 */
import { serviceTokenMatches } from '../middleware/serviceToken.js';
import { Hono } from 'hono';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';
import { commands } from './commands/index.js';
import { writeRateLimit } from '../middleware/rateLimit.js';
import { claimNonceOnce } from '../db/redis.js';
import { logger } from '../utils/logger.js';

export const botAdmin = new Hono();

const REPLAY_WINDOW_SECONDS = 120;
const NONCE_NAMESPACE = 'ImperiumMC:reg_nonce:';

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
  // Service token OR the signed HMAC trigger both register commands — the
  // service principal is our own trusted proxy (B-23 posture), and ops needs
  // to re-register after adding commands without fetching the HMAC secret.
  const viaServiceToken = serviceTokenMatches(c as never);
  if (!viaServiceToken && !authorized(new Headers(Object.entries(h)))) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // B-10: the nonce is single-use. SET NX + EX claims it atomically for the
  // replay window's span; a repeat sighting is a replay and rejected. Redis
  // being unavailable fails OPEN here on purpose: the ±120s timestamp window
  // still bounds replay, and bricking command registration on a cache outage
  // would be a worse failure — logged so the gap is visible.
  const nonce = h['x-nonce'] ?? '';
  const claimed = await claimNonceOnce(NONCE_NAMESPACE, nonce, REPLAY_WINDOW_SECONDS * 2);
  if (claimed === false) {
    logger.warn({ noncePrefix: nonce.slice(0, 8) }, 'bot command registration: replayed nonce rejected');
    return c.json({ error: 'Replayed request' }, 401);
  }
  if (claimed === null) {
    logger.warn('bot command registration: nonce store unavailable — timestamp window alone in effect');
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
