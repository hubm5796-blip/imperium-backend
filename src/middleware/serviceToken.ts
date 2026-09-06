/**
 * B-23 — the service-principal gate for routes whose CALLER CONTENT speaks
 * as the server on Discord (DM enqueue, changelog posting).
 *
 * Why not the shared bot token: BOT_API_TOKEN is held by every integration
 * (plugin, panel, frontend proxies), so gating on it lets any of them push
 * arbitrary text into players' DMs and the owner's changelog channel. Those
 * surfaces demand the dedicated INTERNAL_SERVICE_TOKEN — the delegated-
 * principal secret (V6 05-04) whose only legitimate holders are the backend's
 * own trusted proxies.
 *
 * Compat: until the owner sets INTERNAL_SERVICE_TOKEN, env.ts falls back to
 * BOT_API_TOKEN, so existing callers keep working — the same transitional
 * state as the delegated-identity split. The moment the var is set, the
 * shared token stops working on these routes.
 */
import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { env } from '../env.js';
import type { AppContextVariables } from '../types/index.js';

type RL = { Variables: AppContextVariables };

/** True when the presented X-Bot-Token is the INTERNAL_SERVICE_TOKEN. */
export function serviceTokenMatches(c: { req: { header: (name: string) => string | undefined } }): boolean {
  const token = c.req.header('X-Bot-Token') ?? '';
  const expected = env.internalServiceToken;
  if (!token || !expected) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Middleware form: 401 unless the service token is presented. */
export const requireServiceToken: MiddlewareHandler<RL> = async (c, next) => {
  if (!serviceTokenMatches(c)) return c.json({ error: 'Unauthorized' }, 401);
  await next();
};
