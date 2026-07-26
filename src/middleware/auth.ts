import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import {
  AUTH_COOKIE_NAME,
  clearAuthCookieOptions,
  verifyJwt,
} from '../auth/jwt.js';
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
  const user = verifyJwt(token);
  c.set('user', user);

  if (user) {
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

/** Re-exported so routes can clear the cookie on logout. */
export { AUTH_COOKIE_NAME, clearAuthCookieOptions };
