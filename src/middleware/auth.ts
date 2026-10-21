import { timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import {
  AUTH_COOKIE_NAME,
  clearAuthCookieOptions,
  verifyClientJwt,
  verifyJwt,
} from '../auth/jwt.js';
import { env } from '../env.js';
import { getUuidByDiscordId } from '../db/pool.js';
import type { AppContextVariables } from '../types/index.js';

type AuthEnv = { Variables: AppContextVariables };

/**
 * Read the client bearer token from `Authorization: Bearer …`, if any.
 * `Bearer imp_…` is the v2 API-key shape — resolvePrincipal owns that
 * credential, so it is explicitly NOT treated as a JWT here.
 */
function clientBearerToken(c: Parameters<MiddlewareHandler<AuthEnv>>[0]): string | null {
  const authz = c.req.header('authorization') ?? '';
  if (!authz.toLowerCase().startsWith('bearer ')) return null;
  const bearer = authz.slice(7).trim();
  if (!bearer || bearer.startsWith('imp_')) return null;
  return bearer;
}

/**
 * Read the JWT from the auth cookie, verify it, and attach the decoded user
 * (plus the linked MC UUID, if any) to the context. Never blocks the request —
 * if there's no valid token, `c.var.user` is simply null. Use `requireAuth`
 * to actually enforce authentication.
 *
 * Issue #2: when there is no valid session cookie, an `Authorization: Bearer`
 * client token (authMethod 'mc_client', aud imperium-client) ALSO establishes
 * the user — with a SEPARATE verifier so the two families can never be
 * replayed cross-context (a client token in the cookie, or a session token in
 * the bearer header, both verify to null). Client tokens are then confined to
 * their route allowlist by gates.clientTokenAllowlist.
 */
export const attachUser: MiddlewareHandler<AuthEnv> = async (c, next) => {
  // Idempotent (B-49): the v2 sub-app gets attachUser at the root level now,
  // and expansion residents under /api/v2 also run it via the `api` mount —
  // a second pass on the same request must not re-verify or re-query.
  if (c.get('user') !== undefined) {
    await next();
    return;
  }
  const token = getCookie(c, AUTH_COOKIE_NAME);
  let user = await verifyJwt(token);
  if (!user) {
    const bearer = clientBearerToken(c);
    if (bearer) {
      user = await verifyClientJwt(bearer);
    }
  }
  c.set('user', user);

  if (user?.authMethod === 'mc_code' || user?.authMethod === 'mc_client') {
    // The UUID was baked into the token at login (the player proved it
    // in-game, or at the Mojang hasJoined check for client tokens); no DB
    // lookup needed.
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
