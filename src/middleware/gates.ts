/**
 * V6 05-04 AUTH V2 — the principal model + named gates.
 *
 * Every trust decision becomes a named middleware with ONE implementation.
 * Principals (resolved once per request by [resolvePrincipal]):
 *   - session   : cookie JWT (attachUser already resolves the user; this wraps it)
 *   - bot       : X-Bot-Token matching BOT_API_TOKEN (the shared internal token)
 *   - delegated : bot/service token + X-Mc-Uuid (the frontend proxy's asserted identity)
 *   - api_key   : Authorization: Bearer imp_... (hash-verified against D1, scopes enforced)
 *
 * Routes stop hand-rolling requireBotAuth copies; the gates below are the only
 * sanctioned entry points. The inline call sites in routes.ts keep working
 * (same underlying check) and migrate to these incrementally.
 */
import { timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { env } from '../env.js';
import { authenticateApiKey, type Scope } from '../auth/apiKeys.js';
import type { AppContextVariables } from '../types/index.js';

type AuthEnv = { Variables: AppContextVariables };

export type Principal =
  | { kind: 'session'; mcUuid: string | null; discordId: string | null; authMethod: 'discord' | 'mc_code' }
  | { kind: 'bot' }
  | { kind: 'delegated'; mcUuid: string }
  | { kind: 'api_key'; keyId: string; scopes: Scope[]; ownerUuid: string | null }
  | { kind: 'anonymous' };

/** Constant-time string equality (same discipline as botTokenMatches). */
function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  if (x.length !== y.length || x.length === 0) return false;
  return timingSafeEqual(x, y);
}

/**
 * Resolve the request's principal. ORDER MATTERS only between the bearer and
 * the bot-token shapes (they use different headers, so there is no ambiguity):
 * cookie session > bearer api key > bot/delegated (headers) > anonymous.
 * Never throws — resolution failures degrade to anonymous (gates then 401).
 */
export async function resolvePrincipal(c: Context): Promise<Principal> {
  // 1. Bearer API key (before the session so key use is visible in the principal)
  const authz = c.req.header('authorization') ?? '';
  if (authz.toLowerCase().startsWith('bearer imp_')) {
    try {
      const key = await authenticateApiKey(authz.slice(7).trim());
      if (key) return { kind: 'api_key', keyId: key.id, scopes: key.scopes, ownerUuid: key.ownerUuid };
    } catch {
      // D1 unavailable — key auth degrades to anonymous, never to open access.
    }
  }

  // 2. Session cookie (attachUser already ran; its verdict is authoritative)
  const user = c.get('user');
  if (user) {
    return {
      kind: 'session',
      mcUuid: c.get('mcUuid') ?? null,
      discordId: user.discordId ?? null,
      authMethod: user.authMethod,
    };
  }

  // 3. Bot / delegated (the shared internal token)
  const botToken = c.req.header('x-bot-token') ?? '';
  if (botToken && env.botApiToken && safeEqual(botToken, env.botApiToken)) {
    const asserted = c.req.header('x-mc-uuid');
    if (asserted) return { kind: 'delegated', mcUuid: asserted };
    return { kind: 'bot' };
  }

  return { kind: 'anonymous' };
}

/** Internal machine endpoints: the shared bot token ONLY (no asserted uuid). */
export const requireBot: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const p = await resolvePrincipal(c);
  if (p.kind !== 'bot') return c.json({ error: 'Unauthorized' }, 401);
  await next();
};

/**
 * Reads/writes a player's own data: a session (linked), a delegated proxy
 * call, or an API key owned by that player. The uuid is NOT a header for
 * sessions/keys — only the delegated shape may assert it.
 */
export const requireSelfOrDelegated: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const p = await resolvePrincipal(c);
  if (p.kind === 'delegated') {
    c.set('mcUuid', p.mcUuid);
  } else if (p.kind === 'session' && p.mcUuid) {
    c.set('mcUuid', p.mcUuid);
  } else if (p.kind === 'api_key' && p.ownerUuid) {
    c.set('mcUuid', p.ownerUuid);
  } else {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
};

/** API-key scope enforcement (see apiKeys.ts for the closed enum). */
export const requireScope = (scope: Scope): MiddlewareHandler<AuthEnv> => async (c, next) => {
  const p = await resolvePrincipal(c);
  if (p.kind === 'api_key') {
    if (!p.scopes.includes(scope)) {
      return c.json({ error: 'Insufficient scope', code: 'INSUFFICIENT_SCOPE' }, 403);
    }
  } else if (p.kind !== 'session' && p.kind !== 'bot' && p.kind !== 'delegated') {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  // Non-key principals are internal trust (session/bot/delegated) — scope
  // limits apply to third-party keys only in v1, per the blueprint doctrine.
  await next();
};
