import { timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import {
  AUTH_COOKIE_NAME,
  clearAuthCookieOptions,
  verifyJwt,
} from '../auth/jwt.js';
import { env } from '../env.js';
import { getUuidByDiscordId } from '../db/pool.js';
import type { AppContextVariables } from '../types/index.js';

type AuthEnv = { Variables: AppContextVariables };

/**
 * Read the JWT from the auth cookie, verify it, and attach the decoded user
 * (plus the linked MC UUID, if any) to the context. Never blocks the request —
 * if there's no valid token, `c.var.user` is simply null. Use `requireAuth`
 * to actually enforce authentication.
 */
export const attachUser: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const token = getCookie(c, AUTH_COOKIE_NAME);
  const user = await verifyJwt(token);
  c.set('user', user);

  if (user?.authMethod === 'mc_code') {
    // The UUID was baked into the token at login (the player proved it
    // in-game); no DB lookup needed.
    c.set('mcUuid', user.mcUuid ?? null);
  } else if (user?.authMethod === 'discord' && user.discordId) {
    try {
      const uuid = await getUuidByDiscordId(user.discordId);
      c.set('mcUuid', uuid);
    } catch {
      // Database may be temporarily unavailable; treat as unlinked.
      c.set('mcUuid', null);
    }
  } else {
    c.set('mcUuid', null);
  }

  await next();
};

/**
 * Requires a valid authenticated user. Returns 401 if none. Must be applied
 * after `attachUser`.
 */
export const requireAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (!c.var.user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
};

/**
 * Requires the authenticated user to also have a linked Minecraft account.
 * Returns 403 with `linkRequired: true` so the client can prompt for linking.
 */
export const requireLinked: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (!c.var.user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  if (!c.var.mcUuid) {
    return c.json({ error: 'Minecraft account not linked', linkRequired: true }, 403);
  }
  await next();
};

/**
 * Trusted-server check for the expansion's machine-to-machine endpoints
 * (Discord worker, frontend edge proxies): the request must carry
 * `X-Bot-Token` matching the `BOT_API_TOKEN` Workers secret. Timing-safe,
 * same discipline as `requireBotAuth` in routes.ts (that one predates the
 * expansion and stays local — this is the shared export for new modules).
 */
export function botTokenMatches(c: Context): boolean {
  const token = c.req.header('X-Bot-Token');
  if (!env.botApiToken || !token) return false;
  try {
    const a = Buffer.from(env.botApiToken);
    const b = Buffer.from(token);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Re-exported so routes can clear the cookie on logout. */
export { AUTH_COOKIE_NAME, clearAuthCookieOptions };
