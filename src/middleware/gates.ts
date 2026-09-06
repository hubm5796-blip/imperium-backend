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
 * IDENTITY PRECEDENCE (X-02, explicit — not an accident of check order):
 *   session cookie > X-Staff-Role claim > bot token.
 * A request may carry several credentials at once (the frontend's proxies
 * send a session cookie AND X-Bot-Token); each gate asks about the
 * credential it names, so nothing shadows anything else:
 *   - requireBot reads the token header DIRECTLY — a session on the same
 *     request never hides a valid bot token;
 *   - the staff gate never derives a staff role from the bot token alone
 *     (service scope only) once the transitional exemption is deleted.
 *
 * Routes stop hand-rolling requireBotAuth copies; the gates below are the only
 * sanctioned entry points. The inline call sites in routes.ts keep working
 * (same underlying check) and migrate to these incrementally.
 */
import { timingSafeEqual } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { env } from '../env.js';
import { authenticateApiKey, type Scope } from '../auth/apiKeys.js';
import { botTokenMatches } from './auth.js';
import { query } from '../db/pool.js';
import type { AppContextVariables, JwtPayload } from '../types/index.js';

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

/* ── Minecraft UUID shape (B-06/B-54): normalize, don't reject ──────────────
 * Dashed, undashed and any-case forms are all legal caller inputs; the
 * canonical store form is dashed lowercase (VARCHAR(36) in every game
 * table). Bedrock `.name` identities are USERNAMES and never valid here. */
const MC_UUID_RE = /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/;

/** Validate and normalize a Minecraft UUID to dashed-lowercase; null on garbage. */
export function parseMcUuid(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!MC_UUID_RE.test(trimmed)) return null;
  const hex = trimmed.replace(/-/g, '').toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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

  // 3. Bot / delegated — SPLIT TOKENS, two-tier (B-02 fix): the outer check
  // accepts EITHER secret; a DELEGATED (X-Mc-Uuid) call requires the SERVICE
  // token specifically. The previous code required the token to equal
  // BOT_API_TOKEN (outer) AND INTERNAL_SERVICE_TOKEN (inner) — reachable
  // only when the two secrets were identical, i.e. the split was inert and
  // activating it (the documented goal) broke every delegated call.
  const botToken = c.req.header('x-bot-token') ?? '';
  if (botToken) {
    const isBot = botTokenMatches(c);
    const isService = Boolean(env.internalServiceToken) && safeEqual(botToken, env.internalServiceToken);
    if (isBot || isService) {
      const asserted = c.req.header('x-mc-uuid');
      if (asserted && isService) {
        // Identity assertion — shape-validated by the gates that consume it
        // (requireSelfOrDelegated / requireMcIdentity 400 on garbage, B-06).
        return { kind: 'delegated', mcUuid: asserted };
      }
      // Bot token attempting (or lacking) identity assertion: service scope
      // only — the shared bot token never confers a player identity.
      return { kind: 'bot' };
    }
  }

  return { kind: 'anonymous' };
}

/* ── Resolve-once (B-05) ────────────────────────────────────────────────────
 * resolvePrincipal re-ran on every gate in a chain — for a Bearer imp_ key
 * each resolution hits D1, and two resolutions could even disagree if D1
 * flapped mid-request. The principal is resolved ONCE per request (either
 * by the attachPrincipal middleware or lazily by the first gate) and cached
 * on the context. */
export const attachPrincipal: MiddlewareHandler<AuthEnv> = async (c, next) => {
  c.set('principal', await getPrincipal(c));
  await next();
};

/** The request's principal, resolved at most once (see attachPrincipal). */
export async function getPrincipal(c: Context): Promise<Principal> {
  const cached = c.get('principal');
  if (cached) return cached;
  const resolved = await resolvePrincipal(c);
  c.set('principal', resolved);
  return resolved;
}

/**
 * Internal machine endpoints: the shared bot token ONLY (no asserted uuid).
 * X-02: reads the token header directly — a session cookie on the same
 * request (the frontend sends both credentials) must never shadow a valid
 * bot token, which the kind-based resolution would have done.
 */
export const requireBot: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const presented = c.req.header('x-bot-token') ?? '';
  const isBot = botTokenMatches(c);
  const isService =
    Boolean(env.internalServiceToken) && safeEqual(presented, env.internalServiceToken);
  if (!isBot && !isService) return c.json({ error: 'Unauthorized' }, 401);
  await next();
};

/**
 * Reads/writes a player's own data: a session (linked), a delegated proxy
 * call, or an API key owned by that player. The uuid is NOT a header for
 * sessions/keys — only the delegated shape may assert it, and the asserted
 * shape is validated + normalized here (B-06: garbage 400s instead of
 * silently missing rows).
 */
export const requireSelfOrDelegated: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const p = await getPrincipal(c);
  if (p.kind === 'delegated') {
    const normalized = parseMcUuid(p.mcUuid);
    if (!normalized) return c.json({ error: 'Invalid X-Mc-Uuid' }, 400);
    c.set('mcUuid', normalized);
  } else if (p.kind === 'session' && p.mcUuid) {
    c.set('mcUuid', p.mcUuid);
  } else if (p.kind === 'api_key' && p.ownerUuid) {
    c.set('mcUuid', p.ownerUuid);
  } else {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
};

/**
 * Player-identity gate for the v1 X-Mc-Uuid routes (B-13): a session may
 * act as its own linked account (self-scope stays session-allowed); acting
 * as ANY other player requires the delegated SERVICE token — the shared
 * bot token alone never again confers an arbitrary identity. The asserted
 * uuid is shape-validated and normalized (B-06).
 */
export const requireMcIdentity: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const p = await getPrincipal(c);
  if (p.kind === 'session') {
    if (!p.mcUuid) {
      return c.json({ error: 'Minecraft account not linked', linkRequired: true }, 403);
    }
    c.set('mcUuid', p.mcUuid);
  } else if (p.kind === 'delegated') {
    const normalized = parseMcUuid(p.mcUuid);
    if (!normalized) return c.json({ error: 'Invalid X-Mc-Uuid' }, 400);
    c.set('mcUuid', normalized);
  } else if (p.kind === 'bot') {
    // A valid shared bot token WITH an X-Mc-Uuid header: identity assertion
    // under the wrong credential once the split is active. Name the fix.
    if (c.req.header('x-mc-uuid')) {
      return c.json({ error: 'X-Mc-Uuid requires the internal service token', code: 'IDENTITY_NEEDS_SERVICE_TOKEN' }, 403);
    }
    return c.json({ error: 'Unauthorized' }, 401);
  } else {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
};

/** API-key scope enforcement (see apiKeys.ts for the closed enum). */
export const requireScope = (scope: Scope): MiddlewareHandler<AuthEnv> => async (c, next) => {
  const p = await getPrincipal(c);
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

/* ───────────────── Staff principal (B-01 + X-04, Phase 1 trust boundary) ── */

export type StaffRole = 'helper' | 'mod' | 'admin';
export const STAFF_ROLE_RANK: Record<StaffRole, number> = { helper: 1, mod: 2, admin: 3 };

export interface StaffActor {
  /** Audit-attribution name (rides the dispatch payload). */
  name: string;
  role: StaffRole | 'none';
  rank: number;
  /** Which trust source produced this actor — audit + tests assert on it. */
  source: 'staff-token' | 'header-claim' | 'session-claim' | 'service-transition' | 'anonymous';
}

/**
 * STAFF TRUST PROTOCOL (agreed with the frontend half — Phase 1):
 *
 *   1. X-Staff-Token + X-Staff-Actor verified against STAFF_ACTOR_TOKEN_MAP
 *      (per-staff personal tokens, name-bound; mismatched pair = rejected).
 *   2. X-Staff-Role header — honored ONLY on requests already authenticated
 *      by a valid session JWT or the bot/service token. A bare header from
 *      an unauthenticated caller means nothing (it is never even read).
 *   3. No header + valid session → the session's own staff role: the JWT's
 *      `staffRole` claim, else the linked account's LuckPerms group. This is
 *      the "sessions keep working" fallback.
 *   4. Verified shared bot/service token with no identity attached → the
 *      TRANSITIONAL panel-service exemption (B-01's fix lands as a separate
 *      deletion once the frontend ships the header — see audit FINDINGS B-01
 *      and CROSS-REPO X-04 for why it must be sequenced frontend-first).
 *   5. Anything else → 'anonymous', rank 0, deny by default.
 *
 * Precedence for identity (X-02): session cookie > X-Staff-Role claim >
 * bot token. The bot token alone NEVER confers a staff role once (4) is
 * deleted — it confers service scope only.
 */

/** Parse "token:name:role,..." with first-colon token splitting (B-03: a
 * token containing ':' must not silently shift the name/role fields). */
function parseStaffTokenMap(raw: string): Array<{ token: string; name: string; role: string }> {
  const out: Array<{ token: string; name: string; role: string }> = [];
  if (!raw) return out;
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const firstColon = trimmed.indexOf(':');
    if (firstColon <= 0) continue;
    const token = trimmed.slice(0, firstColon).trim();
    const rest = trimmed.slice(firstColon + 1);
    const secondColon = rest.indexOf(':');
    const name = (secondColon >= 0 ? rest.slice(0, secondColon) : rest).trim();
    const role = secondColon >= 0 ? rest.slice(secondColon + 1).trim() : '';
    if (token && name) out.push({ token, name, role });
  }
  return out;
}

/** Parse "token:name,..." (ACTOR_TOKEN_MAP) with first-colon splitting. */
function parseActorTokenMap(raw: string): Array<{ token: string; name: string }> {
  const out: Array<{ token: string; name: string }> = [];
  if (!raw) return out;
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(':');
    if (sep <= 0) continue;
    const token = trimmed.slice(0, sep).trim();
    const name = trimmed.slice(sep + 1).trim();
    if (token && name) out.push({ token, name });
  }
  return out;
}

/**
 * Map the presented X-Bot-Token to a named actor for AUDIT attribution.
 * B-01 (b): an UNKNOWN principal — no token, or a token absent from
 * ACTOR_TOKEN_MAP — resolves to the deny-by-default 'anonymous', never to
 * the privileged 'panel-service'. The transitional panel-service actor can
 * only be produced by [resolveStaffActor]'s explicit verified-token branch,
 * which the exemption-deletion commit removes.
 */
export function resolveActorFromToken(c: Context): string {
  const token = c.req.header('X-Bot-Token') ?? '';
  if (!token) return 'anonymous';
  for (const { token: mapped, name } of parseActorTokenMap(env.actorTokenMap ?? '')) {
    if (safeEqual(token, mapped)) return name;
  }
  return 'anonymous';
}

/** True when the presented X-Bot-Token is the shared bot OR service token. */
export function botOrServiceTokenValid(c: Context): boolean {
  const token = c.req.header('x-bot-token') ?? '';
  if (!token) return false;
  if (env.botApiToken && safeEqual(token, env.botApiToken)) return true;
  if (env.internalServiceToken && safeEqual(token, env.internalServiceToken)) return true;
  return false;
}

/**
 * Staff role for a linked Minecraft account, resolved from the same
 * LuckPerms table `/player/permissions` reads (the plugin writes
 * `luckperms_players.primary_group`). Fails closed: unknown group / DB
 * error / unlinked → null.
 */
export async function linkedStaffRole(uuid: string | null | undefined): Promise<StaffRole | null> {
  if (!uuid) return null;
  let groups: string[] = [];
  try {
    const result = await query<{ primary_group: string }>(
      `SELECT primary_group FROM luckperms_players WHERE uuid = $1`,
      [uuid],
    );
    groups = result.rows.map((r) => r.primary_group.toLowerCase());
  } catch {
    // LuckPerms table unavailable — fail closed (no staff role).
    return null;
  }
  return staffRoleFromGroups(groups);
}

/** Group-name tiering, identical to /player/permissions (RankGroupBootstrap). */
export function staffRoleFromGroups(groups: string[]): StaffRole | null {
  const adminGroups = ['admin', 'sr_admin', 'head_admin', 'developer', 'manager', 'owner'];
  const modGroups = ['mod', 'sr_mod', 'jr_mod', ...adminGroups];
  const helperGroups = ['trainee', 'tester', 'builder', ...modGroups];
  if (groups.some((g) => adminGroups.includes(g))) return 'admin';
  if (groups.some((g) => modGroups.includes(g))) return 'mod';
  if (groups.some((g) => helperGroups.includes(g))) return 'helper';
  return null;
}

function sessionStaffClaim(user: JwtPayload | null): StaffRole | null {
  const claimed = user?.staffRole;
  if (claimed === 'helper' || claimed === 'mod' || claimed === 'admin') return claimed;
  return null;
}

/**
 * THE staff gate implementation (B-04: one implementation, consumers call
 * this — routes.ts no longer keeps a private copy). Async because the
 * session fallback may read LuckPerms.
 */
export async function resolveStaffActor(c: Context): Promise<StaffActor> {
  // 1. Per-staff personal tokens (name-bound pair, timing-safe compare).
  const staffToken = c.req.header('X-Staff-Token') ?? '';
  const claimedName = c.req.header('X-Staff-Actor') ?? '';
  if (staffToken && claimedName) {
    for (const { token, name, role } of parseStaffTokenMap(env.staffActorTokenMap ?? '')) {
      if (safeEqual(staffToken, token) && name === claimedName) {
        const rank = STAFF_ROLE_RANK[role as StaffRole] ?? 0;
        if (rank > 0) return { name, role: role as StaffRole, rank, source: 'staff-token' };
      }
    }
    // A presented-but-unbound pair falls through to the other sources — the
    // caller may still be a legitimate session/staff-header caller.
  }

  const user = c.get('user') ?? null;
  const authenticated = user !== null || botOrServiceTokenValid(c);

  // 2. X-Staff-Role claim — authenticated requests only. THE PROTOCOL: a
  //    bare header from an unauthenticated caller means nothing.
  const headerRoleRaw = (c.req.header('X-Staff-Role') ?? '').trim().toLowerCase();
  if (authenticated && (headerRoleRaw === 'helper' || headerRoleRaw === 'mod' || headerRoleRaw === 'admin')) {
    // Attributed actor (X-03): X-Admin-Uuid is the LuckPerms-verified human
    // the frontend already resolved — use it as the audit name when present.
    const adminUuid = (c.req.header('X-Admin-Uuid') ?? '').trim();
    const name =
      (adminUuid.length > 0 && adminUuid.length <= 64 ? adminUuid : '') ||
      (user?.mcUuid ?? c.get('mcUuid') ?? '') ||
      (user?.discordId ? `discord:${user.discordId}` : '') ||
      (claimedName.length > 0 && claimedName.length <= 64 ? claimedName : '') ||
      'staff-claim';
    return { name, role: headerRoleRaw, rank: STAFF_ROLE_RANK[headerRoleRaw], source: 'header-claim' };
  }

  // 3. Session claim fallback — the session's own linkage keeps sessions
  //    working when the header is absent.
  if (user) {
    const claimed = sessionStaffClaim(user);
    const role = claimed ?? (await linkedStaffRole(c.get('mcUuid')));
    if (role) {
      const name = c.get('mcUuid') ?? (user.discordId ? `discord:${user.discordId}` : 'session');
      return { name, role, rank: STAFF_ROLE_RANK[role], source: 'session-claim' };
    }
    // A session with no staff role is a known-but-unprivileged principal —
    // deny (fall through to anonymous), never the service exemption.
    return { name: 'anonymous', role: 'none', rank: 0, source: 'anonymous' };
  }

  // 3b. ACTOR_TOKEN_MAP: a token explicitly mapped to a named service
  //     identity ("token:name"). Named identities carry the lowest staff
  //     role (helper) — presenting MORE identity than the bare shared token
  //     must never grant LESS access (B-01's inverted model, fixed).
  const mappedName = resolveActorFromToken(c);
  if (mappedName !== 'anonymous') {
    return { name: mappedName, role: 'helper', rank: STAFF_ROLE_RANK.helper, source: 'staff-token' };
  }

  // 4. Verified shared token, no identity — TRANSITIONAL panel-service
  //    exemption. Deleted in a standalone commit once the frontend ships
  //    X-Staff-Role forwarding (audit B-01/X-04 sequencing).
  if (botOrServiceTokenValid(c)) {
    return { name: 'panel-service', role: 'admin', rank: STAFF_ROLE_RANK.admin, source: 'service-transition' };
  }

  // 5. Unknown principal — deny by default.
  return { name: 'anonymous', role: 'none', rank: 0, source: 'anonymous' };
}

/** Role gate. One implementation; asserts on rank, with the transitional
 *  service exemption until the frontend half of X-04 deploys. */
export function staffActorHasRole(actor: StaffActor, minimum: StaffRole): boolean {
  // TRANSITIONAL (B-01 step (c) deletes this branch): the panel-service pipe
  // stays exempt while the frontend learns to forward X-Staff-Role.
  if (actor.source === 'service-transition') return true;
  return actor.rank >= (STAFF_ROLE_RANK[minimum] ?? 99);
}
