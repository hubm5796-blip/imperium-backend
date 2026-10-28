import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono, type Context, type MiddlewareHandler, type Next } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { gameQuery, getGamePlayerBalances, getGamePlayerProfile, getGamePlayerFirstSeen, getGamePlayerStats, getGamePlayerAchievements, getGamePlayerSkills, getGamePlayerRankAndPrestige, getGamePlayerFactions, getGameParkourRecords, getGamePlayerLegionId, getGameLegionInfo, getGameLegionMembers, getGameLegionProjects, getGamePlayerCosmetics, getGamePlayerDailyQuests, getGameCrateKeys, getGameCrateOpenings, getGamePlayerRewards, getGamePrivacyExport, probeTcpPort } from '../db/gameMysql.js';
import {
  AUTH_COOKIE_NAME,
  authCookieOptions,
  clearAuthCookieOptions,
  signJwt,
} from '../auth/jwt.js';
import { env } from '../env.js';
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchDiscordUser,
} from '../auth/discord.js';
import { attachUser, botTokenMatches, requireAuth, requireLinked } from '../middleware/auth.js';
import {
  attachPrincipal,
  clientTokenAllowlist,
  parseMcUuid,
  requireMcIdentity,
  requireStaffRole,
  resolveStaffActor,
  staffActorHasRole,
} from '../middleware/gates.js';
import { recordAction } from '../db/actionLog.js';
import { resolveAuditActor } from '../utils/auditActor.js';
import { authRateLimit, globalRateLimit, rateLimit, readRateLimit, writeRateLimit } from '../middleware/rateLimit.js';
import {
  deleteDiscordLinkByDiscordId,
  deleteDiscordLinkByUuid,
  getCachedSubscription,
  getDiscordIdByUuid,
  getEloLeaderboard,
  getLeaderboard,
  getParkourLeaderboard,
  getPaynowCustomerId,
  getPlayerAchievements,
  getPlayerBalances,
  getPlayerCosmetics,
  getPlayerDailyQuests,
  getPlayerFactions,
  getPlayerLegion,
  getPlayerParkour,
  getPlayerProfile,
  getPlayerSkills,
  getPlayerStats,
  getPlayerTransactions,
  getUuidByDiscordId,
  getUuidByUsername,
  getNameByUuid,
  getWaveLeaderboard,
  isAlreadyLinked,
  isFloodgateUuid,
  isSubscriptionCacheStale,
  playerQuery,
  query,
  setPaynowCustomerId,
  upsertCachedSubscription,
  upsertDiscordLink,
} from '../db/pool.js';
import {
  consumeLinkCode,
  consumeLoginCode,
  consumeSessionCode,
  createLinkCode,
  createSessionCode,
  getCachedJson,
  getOnlinePlayerCount,
  sendCommandWithResponse,
  setCachedJson,
} from '../db/redis.js';
import {
  applyTierChange,
  cancelSubscription,
  createCheckoutSession,
  type CheckoutLine,
  createCustomerToken,
  findOrCreatePaynowCustomer,
  getCustomerSubscriptions,
  getSubscriptionById,
  PaynowApiError,
  previewTierChange,
} from '../paynow/client.js';
import { DONOR_TIERS, isDonorSubscriptionProduct, isGiftableProduct, isOneTimeStoreProduct } from '../paynow/constants.js';
import { verifyPaynowWebhook } from '../paynow/webhookVerify.js';
import { fulfillPaynowOrder, normalizePaynowEventType, refundPaynowOrder, resolveCustomerUuid } from '../paynow/fulfillment.js';
import type { AppContextVariables } from '../types/index.js';
import { CURRENCY_ALIASES } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { alertError } from '../utils/errorAlerts.js';
import { expansionApi } from './expansion/index.js';
import { licenseStatusApi } from './license.js';
import { microsoftAuthApi } from './microsoftAuth.js';
import { fetchExpansionBoard, isExpansionBoard } from './expansion/leaderboards.js';
import { swrJson } from './expansion/cache.js';
import { emit } from '../webhooks/deliver.js';
import { intParam, limitParam, pageParam } from '../utils/paging.js';

type ApiEnv = { Variables: AppContextVariables };

/**
 * Shared single-token schemas (B-27/B-28): values interpolated into in-game
 * command strings (/legion/*) or used as registry lookup keys (/player/lookup)
 * are validated against strict charsets — legion names match the plugin's own
 * LegionManager.createLegion gate ([A-Za-z0-9_]{3,16}); usernames are the
 * Mojang/Floodgate shape, Bedrock dot-prefix included.
 */
const LEGION_NAME_SCHEMA = /^[A-Za-z0-9_]{3,16}$/;
const MC_USERNAME_SCHEMA = /^\.?[A-Za-z0-9_]{3,16}$/;

/** Full API surface mounted at /api by the main app. */
export const api = new Hono<ApiEnv>();

// Attach the current user (if any) to every request.
api.use('*', attachUser);
// Issue #2: client tokens (bearer, authMethod 'mc_client') are confined to
// their route allowlist — directly after attachUser and before any principal
// resolution or route gate, so every non-allowlisted route 403s
// CLIENT_TOKEN_NOT_ALLOWED before its own gates even run.
api.use('*', clientTokenAllowlist);
// Resolve the principal ONCE per request (B-05) — gates read the cached value.
api.use('*', attachPrincipal);
// Apply a default sliding-window limit to everything.
api.use('*', globalRateLimit);

/**
 * AUDIT ATTRIBUTION (#12): map the X-Bot-Token to a named actor identity.
 * The shared BOT_API_TOKEN maps to "panel-service" (the generic service identity).
 * Per-actor tokens map to individual staff names via the ACTOR_TOKEN_MAP env var:
 * "token1:staffname1,token2:staffname2". The caller-supplied `actor` body field
 * is NEVER trusted for audit — it can only be resolved from the token.
 */
/**
 * BOT-AUTH MIDDLEWARE (2026-08-25 fix): routes passed the boolean bot-auth guard
 * as Hono middleware — a false return is not a Response, so every UNAUTHENTICATED call
 * to those routes crashed into a generic 500 instead of a clean 401.
 *
 * B-04: the token predicate itself is middleware/auth's botTokenMatches — the
 * ONE implementation (this file's private timing-safe copy was deleted).
 */
const botAuthMiddleware = async (c: Context, next: Next) => {
  if (!botTokenMatches(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
};

/**
 * AUDIT ATTRIBUTION + STAFF ROLE GATES (2026-08-31; Phase 1 rewrite B-01/X-04).
 *
 * The implementation lives in middleware/gates.ts (the ONE sanctioned copy —
 * B-04) and resolves the staff actor from, in order:
 *   1. per-staff tokens (X-Staff-Token + X-Staff-Actor, name-bound),
 *   2. X-Staff-Role — honored ONLY on requests already authenticated by a
 *      valid session JWT or the bot/service token (the frontend forwards it
 *      after its own LuckPerms verification; a bare header means nothing),
 *   3. the session's own staff role (JWT staffRole claim, else the linked
 *      account's LuckPerms group) when the header is absent,
 *   4. anonymous (deny) otherwise — the bare shared token confers no
 *      staff role (the transitional panel-service exemption is deleted).
 *
 *
 * Route role gates (S2-D01: declared ON the route, deny by default):
 * /admin/punish requires mod+; /admin/broadcast requires helper+;
 * /admin/reload requires admin. Every dispatch writes an attributed
 * action_log audit row. Admin routes accept a valid session, the
 * bot/service token, or a verified per-staff token pair as the AUTHENTICATING
 * credential — the staff gate then decides what that identity may do (a
 * logged-in non-staff player resolves to anonymous and is refused).
 */

/** Admin-route authentication: valid bot/service token OR valid session. */
function adminAuthOk(c: Context): boolean {
  return botTokenMatches(c) || c.var.user !== null;
}/**
 * Rate limiter for /auth/webcode/verify (B-26). The bucket key is NEVER a
 * caller-supplied header: X-Original-Client-IP was trivially rotatable by
 * anyone holding the shared bot token (fresh bucket per request = unbounded
 * guesses against a 6-digit code). Bucketing order: the VERIFIED session
 * identity (cookie verified by attachUser) > Cloudflare's unspoofable
 * cf-connecting-ip > a hash of the presented token (dev/no-CF callers).
 */
const webcodeRateLimit = rateLimit(8, 5 * 60_000, 'webcode', (c) => {
  const user = c.get('user');
  if (user) {
    const stable = user.discordId ?? user.mcUuid;
    if (stable) return `session:${stable}`;
  }
  const cf = c.req.header('cf-connecting-ip');
  if (cf) return cf;
  const token = c.req.header('x-bot-token') ?? '';
  if (token) return `tok:${createHash('sha256').update(token).digest('hex').slice(0, 16)}`;
  return 'unknown';
});

/**
 * B-51: /auth/exchange gets its OWN limiter namespace. It previously shared
 * the webcode instance ('webcode' prefix + resolver), so 8 fat-fingered
 * webcode guesses exhausted the same D1 bucket the OAuth callback handoff
 * needs — a backend-completed login became unredeemable for 5 minutes
 * (self-DoS conflating a brute-force bound with an unauthenticated handoff).
 * The exchange code is a 24-char single-use capability with a 60s TTL — the
 * tighter keyspace concern does not apply.
 */
const exchangeRateLimit = rateLimit(10, 60_000, 'exchange');

/* ------------------------------------------------------------------ Auth */

/** GET /api/auth/discord — redirect to Discord OAuth2 authorize URL. */
api.get('/auth/discord', (c) => {
  // Cryptographically random state to mitigate CSRF on the callback.
  const state = crypto.randomUUID();
  // Echo the state back via an httpOnly cookie so the callback can verify it.
  setCookie(c, 'oauth_state', state, {
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: 600,
    path: '/',
    secure: env.isProduction,
  });
  const url = buildAuthorizeUrl(state);
  return c.redirect(url, 302);
});

/** GET /api/auth/discord/callback — handle the OAuth2 callback. */
api.get('/auth/discord/callback', authRateLimit, async (c) => {
  const code = c.req.query('code');
  const error = c.req.query('error');
  const state = c.req.query('state');
  const cookieState = getCookie(c, 'oauth_state');

  // CSRF protection: the state echoed in the cookie must match the query param.
  if (!state || !cookieState || state !== cookieState) {
    // L2: clear the single-use state cookie even on the error path.
    setCookie(c, 'oauth_state', '', { maxAge: 0, path: '/' });
    // B-C21: this is a browser flow — the user came from the frontend, so send
    // them back there with a machine-readable error instead of raw JSON they'd
    // stare at on a bare api.romanica.net page (same shape as the sibling
    // oauth_denied / missing_code branches below).
    return c.redirect(`${frontendUrl()}/login?error=state_mismatch`, 302);
  }

  if (error) {
    logger.warn({ error }, 'Discord OAuth2 returned an error');
    setCookie(c, 'oauth_state', '', { maxAge: 0, path: '/' });
    return c.redirect(`${frontendUrl()}/login?error=oauth_denied`, 302);
  }
  if (!code) {
    setCookie(c, 'oauth_state', '', { maxAge: 0, path: '/' });
    return c.redirect(`${frontendUrl()}/login?error=missing_code`, 302);
  }

  try {
    const token = await exchangeCodeForToken(code);
    const discordUser = await fetchDiscordUser(token.access_token);

    // Code-exchange handoff: store the resolved Discord identity under a one-time
    // code in Redis, then redirect to the FRONTEND's callback with that code. The
    // frontend exchanges it (POST /api/auth/exchange) and signs its own session
    // cookie on romanica.net. The backend owns the OAuth + Discord secret; the
    // frontend owns the browser session — neither cookie domain nor secret leaks.
    const sessionCode = await createSessionCode({
      discordId: discordUser.id,
      discordUsername: discordUser.global_name ?? discordUser.username,
      // Store the avatar HASH (not a CDN URL) — the frontend's discordAvatarUrl()
      // builds the URL itself from (id, hash). Storing buildAvatarUrl()'s full URL
      // here produced a broken double-URL on the dashboard.
      discordAvatar: discordUser.avatar ?? null,
    });
    setCookie(c, 'oauth_state', '', { maxAge: 0, path: '/' });
    return c.redirect(`${frontendUrl()}/api/auth/callback?session=${sessionCode}`, 302);
  } catch (err) {
    logger.error({ err }, 'Discord OAuth2 callback failed');
    setCookie(c, 'oauth_state', '', { maxAge: 0, path: '/' });
    return c.redirect(`${frontendUrl()}/login?error=callback_failed`, 302);
  }
});

/**
 * GET /api/auth/me — the current session, however it was established.
 * A successful (2xx) response always means "logged in" — callers should
 * branch on HTTP status, not on the presence of any particular field, since
 * `discord` is legitimately null for an mc_code session with no linked
 * Discord account.
 */
api.get('/auth/me', requireAuth, async (c) => {
  const user = c.var.user!;
  return c.json({
    authMethod: user.authMethod,
    discord: user.discordId
      ? {
          id: user.discordId,
          username: user.discordUsername ?? null,
          avatar: user.discordAvatar ?? null,
        }
      : null,
    mcLinked: c.var.mcUuid !== null,
    mcUuid: c.var.mcUuid,
    mcUsername: c.var.mcUuid ? await getNameByUuid(c.var.mcUuid).catch(() => null) : null,
  });
});

/**
 * POST /api/auth/webcode/verify — exchange an in-game 6-digit login code for
 * a session. The code is generated and stored directly in Redis by the
 * plugin's `/webcode` command (15min TTL, single-use); this endpoint just
 * consumes it. If the underlying Minecraft account happens to already be
 * linked to Discord, the resulting session carries that Discord identity too
 * — otherwise it's a plain mc_code session (still usable everywhere except
 * Discord-specific features, since `requireLinked` only cares about mcUuid).
 *
 * Bot-token gated: only imperium-frontend's own edge proxy
 * (src/app/api/auth/webcode/verify) calls this directly. It doesn't set a
 * browser cookie of its own consequence — the frontend signs the session
 * that actually matters, on the domain that actually matters, from this
 * response. Gating it this way also means the strict rate limit above can
 * trust the caller-forwarded real client IP instead of just seeing "the
 * frontend" for every request.
 */
api.post('/auth/webcode/verify', webcodeRateLimit, async (c) => {
  if (!botTokenMatches(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  let body: { code?: string };
  try {
    body = (await c.req.json()) as { code?: string };
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const code = (body.code ?? '').trim();
  if (!/^\d{6}$/.test(code)) {
    return c.json({ error: 'Code must be 6 digits' }, 400);
  }

  const record = await consumeLoginCode(code);
  if (!record) {
    return c.json({ error: 'Invalid or expired code' }, 404);
  }

  let discordId: string | null = null;
  try {
    discordId = await getDiscordIdByUuid(record.uuid);
  } catch {
    // Database hiccup — proceed as an unlinked mc_code session rather than
    // failing the login outright; the player already proved MC ownership.
    discordId = null;
  }

  const jwt = await signJwt({
    authMethod: 'mc_code',
    mcUuid: record.uuid,
    ...(discordId ? { discordId } : {}),
  });
  setCookie(c, AUTH_COOKIE_NAME, jwt, authCookieOptions());

  return c.json({
    ok: true,
    uuid: record.uuid,
    username: record.username ?? null,
    // The real id, not just a boolean — the frontend's edge auth route builds
    // its own session from this response (see imperium-frontend's
    // src/app/api/auth/webcode/verify/route.ts), so it needs the value, not
    // just whether one exists.
    discordId,
  });
});

/**
 * POST /api/auth/exchange — redeem a one-time OAuth session handoff code (written
 * by /auth/discord/callback) for the Discord identity it carries. Rate-limited.
 * No bot-token gate: the session code is itself a single-use capability token
 * (60s TTL, consumed on read), so possession of it IS the authorization. Only
 * imperium-frontend's edge callback calls this to sign its own session cookie on
 * romanica.net after the backend completed the Discord OAuth. Single-use.
 */
api.post('/auth/exchange', exchangeRateLimit, async (c) => {
  let body: { code?: string };
  try {
    body = (await c.req.json()) as { code?: string };
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const code = (body.code ?? '').trim();
  if (!code) {
    return c.json({ error: 'Missing code' }, 400);
  }

  const session = await consumeSessionCode(code);
  if (!session) {
    // Missing/expired/already-consumed — the 60s handoff window elapsed or this
    // is a replay. Either way the frontend should send the user back to login.
    return c.json({ error: 'Invalid or expired session code' }, 404);
  }

  return c.json({
    ok: true,
    discordId: session.discordId ?? null,
    discordUsername: session.discordUsername,
    discordAvatar: session.discordAvatar,
    // Microsoft (Minecraft) sign-in handoffs carry the proven account instead
    // of a Discord identity (absent fields are omitted by JSON serialization).
    ...(session.mcUuid ? { mcUuid: session.mcUuid, mcUsername: session.mcUsername ?? null } : {}),
  });
});

/** POST /api/auth/logout — clear the auth cookie. */
api.post('/auth/logout', (c) => {
  // Only clear if a cookie actually exists.
  if (getCookie(c, AUTH_COOKIE_NAME)) {
    setCookie(c, AUTH_COOKIE_NAME, '', clearAuthCookieOptions());
  }
  return c.json({ ok: true });
});

/* --------------------------------------------------------------- Player */

/**
 * GET /api/player/profile — rank, prestige, stats.
 *
 * Authenticated browsers hit this with no params (the linked UUID is resolved
 * from the cookie). The bot/apiClient calls it with ?discord_id= or ?uuid= for
 * a specific target, in which case auth is optional. The response includes
 * both the structured spec shape and a flat set of fields the bot's embeds
 * expect (denarius/auctoritas/civitas/aureus/blocksMined/playtimeSeconds/...).
 */
api.get('/player/profile', async (c) => {
  const queryDiscordId = c.req.query('discord_id');
  const queryUuid = c.req.query('uuid');
  const queryUsername = c.req.query('username');

  // Targeted lookups (?uuid= / ?discord_id= / ?username=) are bot-only. Without a valid
  // bot token, anyone could read any player's data, so fall through to the
  // cookie-based "self" path (which is the only thing a browser may do).
  if ((queryUuid || queryDiscordId || queryUsername) && !botTokenMatches(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  let uuid: string | null;
  if (queryUuid) {
    // B-06: validate + normalize (dashed/undashed/any-case are all legal —
    // garbage 400s instead of silently reading as "no data").
    uuid = parseMcUuid(queryUuid);
    if (!uuid) {
      return c.json({ error: 'Invalid uuid parameter' }, 400);
    }
  } else if (queryUsername) {
    // 2026-09-13: username lookups — the bot commands accept Minecraft names.
    // getUuidByUsername reads the plugin-maintained player_names registry.
    if (!/^[A-Za-z0-9_.]{3,16}$/.test(queryUsername)) {
      return c.json({ error: 'Invalid username' }, 400);
    }
    try {
      uuid = await getUuidByUsername(queryUsername);
    } catch {
      uuid = null;
    }
    if (!uuid) {
      return c.json({ error: 'Player not found' }, 404);
    }
  } else if (queryDiscordId) {
    // Try PostgreSQL first, then SQLite fallback
    try {
      uuid = await getUuidByDiscordId(queryDiscordId);
    } catch {
      uuid = null;
    }
    if (!uuid) {
      try {
        const { getUuidByDiscordId: sqliteLookup } = await import('../db/sqlite.js');
        uuid = sqliteLookup(queryDiscordId);
      } catch {
        uuid = null;
      }
    }
  } else if (c.var.user) {
    uuid = c.var.mcUuid;
    if (!uuid) {
      return c.json({ error: 'Minecraft account not linked', linkRequired: true }, 403);
    }
  } else {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  if (!uuid) {
    return c.json({ error: 'Player not linked' }, 404);
  }

  const discordId = queryDiscordId ?? c.var.user?.discordId ?? null;

  // Short-TTL cache of everything that's purely a function of uuid (NOT
  // discordId — that varies by caller context, so it's always computed fresh
  // below and never cached). The frontend dashboard calls this same backend
  // route 3x per page load (profile/stats/balances each re-fetch the whole
  // thing to pull out different fields) — this collapses that back down to
  // one real Postgres round trip. Cache-read/write failures are fail-open
  // (see getCachedJson/setCachedJson) — a Redis outage just means no caching,
  // never a broken response.
  type CachedProfileFields = Omit<Record<string, unknown>, 'discordId'>;
  const cacheKey = `player_profile:${uuid}`;
  const cachedFields = await getCachedJson<CachedProfileFields>(cacheKey);
  if (cachedFields) {
    return c.json({ ...cachedFields, discordId });
  }

  // GAME MYSQL FIRST (hybrid, 2026-08-22): real-time from the live game DB —
  // no 5-minute staleness. Falls back to Postgres, then SQLite.
  let profile: any = null;
  try {
    const game = await getGamePlayerProfile(uuid);
    if (game) {
      // Nested shape must match the PostgreSQL profile exactly (stats.playTime,
      // stats.pvpKills, ...) — the field extraction below reads those names, and
      // the old playTimeSeconds/kills/deaths/trophies aliases silently zeroed out
      // playtime and every PVP stat on the dashboard.
      profile = {
        uuid,
        username: game.username,
        rank: {
          level: Number(game.rank_level ?? 0),
          name: game.rank_name ?? 'Unranked',
          progress: Number(game.rank_progress ?? 0),
        },
        prestige: { level: Number(game.prestige_level ?? 0) },
        first_seen: (await getGamePlayerFirstSeen(uuid).catch(() => null)) ?? undefined,
        stats: {
          blocksMined: Number(game.blocks_mined ?? 0),
          playTime: Number(game.play_time ?? 0),
          pvpKills: Number(game.pvp_kills ?? 0),
          pvpDeaths: Number(game.pvp_deaths ?? 0),
          pvpTrophies: Number(game.pvp_trophies ?? 0),
        },
      };
    }
  } catch {
    profile = null;
  }

  if (!profile) {
    try {
      profile = await getPlayerProfile(uuid);
    } catch {
      profile = null;
    }
  }

  if (!profile) {
    try {
      const { getPlayerProfile: sqliteProfile } = await import('../db/sqlite.js');
      profile = sqliteProfile(uuid);
    } catch {
      profile = null;
    }
  }

  if (!profile) {
    return c.json({ uuid, error: 'Profile data not available yet' }, 200);
  }

  // GAME MYSQL FIRST for balances too: currency_balances in the live game DB is
  // the source of truth (stored in CENTS). The Postgres copy can lag or sit at
  // zero, which players read as "my money vanished on the dashboard".
  let balances: any = { denarius: 0, tokens: 0, beacons: 0, goldenCoins: 0 };
  let balancesDegraded = false;
  let gameBalances: Record<string, string> | null = null;
  try {
    const rows = await getGamePlayerBalances(uuid);
    if (rows.length > 0) {
      gameBalances = Object.fromEntries(rows.map((r) => [r.currency, r.balance]));
    }
  } catch {
    // game MySQL unavailable — fall through to Postgres below.
  }
  if (gameBalances) {
    const g = gameBalances;
    const units = (key: string) => Math.round(Number(g[key] ?? 0)) / 100;
    balances = {
      denarius: units('denarius'),
      tokens: units('auctoritas'),
      beacons: units('civitas'),
      goldenCoins: units('aureus'),
    };
  } else {
    try {
      balances = await getPlayerBalances(uuid);
    } catch (err) {
      // PG not available. WITHOUT the flag every consumer of this profile
      // (dashboard, bot /balance) reports a rich player as flat broke with
      // HTTP 200 and no trace of the outage.
      balancesDegraded = true;
      logger.warn({ uuid, err: String(err) }, 'balances degraded to zero — PG read failed');
    }
  }

  // Two profile shapes flow through here:
  //  - PostgreSQL (getPlayerProfile): nested object
  //      { rank: {level,name,progress}, prestige: {level,points}|null,
  //        stats: {blocksMined,playTime,pvpKills,pvpDeaths,pvpTrophies,kdRatio}|null }
  //  - SQLite fallback: flat fields
  //      { rank, prestige, blocks_mined, play_time, pvp_kills, pvp_deaths, denarius, ... }
  // Each accessor below prefers the nested PG path, then falls back to the flat
  // SQLite field, then 0. Currency always comes from getPlayerBalances (above).
  const p = profile as any;

  // Resolve the Minecraft username from the player_names registry (the PG
  // getPlayerProfile doesn't include it). Falls back to the SQLite profile's
  // username, then to the UUID if neither is available.
  let resolvedUsername = p.username ?? null;
  if (!resolvedUsername) {
    try {
      resolvedUsername = await getNameByUuid(uuid);
    } catch {
      // player_names table not available — fall through to UUID
    }
  }

  const fields = {
    uuid,
    username: resolvedUsername ?? `Player`,
    rank: p.rank?.level ?? p.rank_level ?? p.rank ?? 0,
    prestigeLevel: p.prestige?.level ?? p.prestige_level ?? p.prestige ?? 0,
    prestige: p.prestige?.level ?? p.prestige_level ?? p.prestige ?? 0,
    denarius: balances.denarius ?? 0,
    auctoritas: balances.tokens ?? 0,
    civitas: balances.beacons ?? 0,
    aureus: balances.goldenCoins ?? 0,
    blocksMined: p.stats?.blocksMined ?? p.blocksMined ?? p.blocks_mined ?? 0,
    playtimeSeconds: Number(p.stats?.playTime ?? p.playTime ?? p.play_time ?? 0),
    pvpKills: p.stats?.pvpKills ?? p.pvpKills ?? p.pvp_kills ?? 0,
    pvpDeaths: p.stats?.pvpDeaths ?? p.pvpDeaths ?? p.pvp_deaths ?? 0,
    trophies: p.stats?.pvpTrophies ?? p.pvpTrophies ?? p.pvp_trophies ?? 0,
  };

  // Legion membership + KOTH record for the Discord /profile card (12c) and
  // the web profile page (12b). Both are best-effort lookups — a missing
  // table or no row simply leaves the null default rather than failing.
  const extras: { legion: string | null; kothRecord: string | null } = { legion: null, kothRecord: null };
  try {
    const rows = await gameQuery<{ legion_name: string }>(
      'SELECT legion_name FROM legion_members WHERE player_uuid = ? LIMIT 1',
      [uuid],
    );
    extras.legion = rows[0]?.legion_name ?? null;
  } catch {
    // game MySQL unavailable — fall through to the Postgres copy below.
  }
  if (!extras.legion) {
    try {
      const legion = await query<{ name: string }>(
        `SELECT l.name
           FROM legion_members m
           JOIN legions l ON l.name = m.legion_name
          WHERE m.player_uuid = $1
          LIMIT 1`,
        [uuid],
      );
      extras.legion = legion.rows[0]?.name ?? null;
    } catch {
      // Legion tables unavailable — omit.
    }
  }
  try {
    const koth = await query<{ total: string | null }>(
      `SELECT SUM(value)::text AS total
         FROM leaderboard_stats
        WHERE uuid = $1 AND category = 'KOTH_WINS' AND period = 'ALL_TIME'`,
      [uuid],
    );
    const kothWins = Number(koth.rows[0]?.total ?? 0);
    extras.kothRecord = kothWins > 0 ? `${kothWins} win${kothWins === 1 ? '' : 's'}` : null;
  } catch {
    // leaderboard_stats unavailable — omit.
  }

  // 15s TTL: long enough to collapse the dashboard's own 3 redundant calls
  // into one real read, short enough that a fresh purchase/rank-up/balance
  // change shows up on the next page load rather than feeling stale.
  // setCachedJson already fails open internally (logs, never throws) — fire
  // without awaiting so a slow/unreachable Redis never delays the response.
  // The legion/KOTH extras ride inside the same cached envelope.
  void setCachedJson(cacheKey, { ...fields, ...extras }, 15);

  return c.json({ ...fields, ...extras, discordId, ...(balancesDegraded ? { degraded: true } : {}) });
});

/** GET /api/player/balances — real-time from game MySQL; Postgres fallback. */
api.get('/player/balances', requireMcIdentity, async (c) => {
  const uuid = c.var.mcUuid!;
  // GAME MYSQL FIRST (2026-08-30): the Postgres copy is stale since WebSync went no-op.
  // Same shape as getPlayerBalances — the frontend just reads the `balances` map.
  try {
    const rows = await getGamePlayerBalances(uuid);
    const balances: Record<string, number> = { denarius: 0, tokens: 0, beacons: 0, goldenCoins: 0 };
    for (const row of rows) {
      const key = CURRENCY_ALIASES[row.currency.toLowerCase()];
      if (key) balances[key] = Number(row.balance);
    }
    return c.json({ uuid, balances });
  } catch (err) {
    logger.warn({ err: String(err) }, '[player/balances] game MySQL failed — Postgres fallback');
  }
  const balances = await getPlayerBalances(uuid);
  return c.json({ uuid, balances });
});

/** GET /api/player/stats — real-time from game MySQL; Postgres fallback. */
api.get('/player/stats', requireMcIdentity, async (c) => {
  const uuid = c.var.mcUuid!;
  try {
    const rows = await gameQuery<{ blocks_mined: number; play_time: number; pvp_kills: number; pvp_deaths: number; pvp_trophies: number }>(
      `SELECT ps.blocks_mined,
              COALESCE(pl.total_secs, 0) AS play_time,
              ps.pvp_kills, ps.pvp_deaths, ps.pvp_trophies
         FROM player_stats ps
         LEFT JOIN player_playtime pl ON pl.uuid = ps.uuid
        WHERE ps.uuid = ?
        LIMIT 1`,
      [uuid],
    );
    if (rows.length) return c.json(rows[0]);
  } catch (err) {
    logger.warn({ err: String(err) }, '[player/stats] game MySQL failed — Postgres fallback');
  }
  const stats = await getPlayerStats(uuid);
  if (!stats) {
    return c.json({ error: 'Player stats not found' }, 404);
  }
  return c.json(stats);
});

/** GET /api/player/transactions?page=1 — real-time from game MySQL; Postgres fallback. */
api.get('/player/transactions', requireMcIdentity, async (c) => {
  const uuid = c.var.mcUuid!;
  const pageSize = 25;
  const page = pageParam(c.req.query('page'));

  // GAME MYSQL FIRST (2026-08-30): live economy_transactions (real-time, no WebSync delay).
  try {
    const offset = (page - 1) * pageSize;
    const rows = await gameQuery<{ id: number; type: string; currency: string; amount: number; description: string | null; created_at: string }>(
      `SELECT id, type, currency, amount, description, created_at
         FROM economy_transactions
        WHERE uuid = ?
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?`,
      [uuid, pageSize, offset],
    );
    const [countRow] = await gameQuery<{ n: number }>(
      'SELECT COUNT(*) AS n FROM economy_transactions WHERE uuid = ?',
      [uuid],
    );
    const total = countRow ? Number(countRow.n) : 0;
    return c.json({
      page,
      pageSize,
      total,
      totalPages: Math.max(Math.ceil(total / pageSize), 1),
      transactions: rows.map(r => ({ ...r, displayAmount: Number(r.amount), createdAt: r.created_at })),
    });
  } catch (err) {
    logger.warn({ err: String(err) }, '[player/transactions] game MySQL failed — Postgres fallback');
  }

  const { rows, total } = await getPlayerTransactions(uuid, page, pageSize);
  return c.json({
    page,
    pageSize,
    total,
    totalPages: Math.max(Math.ceil(total / pageSize), 1),
    transactions: rows,
  });
});

/** GET /api/player/skills — game MySQL first; Postgres fallback. */
api.get('/player/skills', requireMcIdentity, async (c) => {
  const uuid = c.var.mcUuid!;
  try {
    const nodes = await getGamePlayerSkills(uuid);
    const byBranch = new Map<string, string[]>();
    for (const n of nodes) {
      const list = byBranch.get(n.branch) ?? [];
      list.push(n.node_id);
      byBranch.set(n.branch, list);
    }
    const rp = await getGamePlayerRankAndPrestige(uuid);
    const earned = rp.rank_level + rp.prestige_level * 5;
    return c.json({
      branches: Array.from(byBranch.entries()).map(([name, ns]) => ({ name, nodes: ns })),
      available_points: Math.max(0, earned - nodes.length),
      spent_points: nodes.length,
    });
  } catch (err) {
    logger.warn({ err: String(err) }, '[player/skills] game MySQL failed');
  }
  const skills = await getPlayerSkills(uuid);
  return c.json(skills);
});

/** GET /api/player/factions — game MySQL first; Postgres fallback. */
api.get('/player/factions', requireMcIdentity, async (c) => {
  const uuid = c.var.mcUuid!;
  try {
    const rows = await getGamePlayerFactions(uuid);
    return c.json({ factions: rows.map((r: { faction_id: string; reputation: number }) => ({ id: r.faction_id, name: r.faction_id, rep: Number(r.reputation), tier: (Number(r.reputation) >= 500 ? 'exalted' : Number(r.reputation) >= 250 ? 'honored' : Number(r.reputation) >= 100 ? 'friendly' : Number(r.reputation) >= 0 ? 'neutral' : 'hostile') })) });
  } catch (err) {
    logger.warn({ err: String(err) }, '[player/factions] game MySQL failed');
  }
  const factions = await getPlayerFactions(uuid);
  return c.json(factions);
});

/** GET /api/player/parkour — game MySQL first; Postgres fallback. */
api.get('/player/parkour', requireMcIdentity, async (c) => {
  const uuid = c.var.mcUuid!;
  try {
    const rows = await getGameParkourRecords(uuid);
    return c.json({ records: rows.map(r => ({ course: r.course_id, best_time_ms: Number(r.best_time_ms), completions: Number(r.completions) })) });
  } catch (err) {
    logger.warn({ err: String(err) }, '[player/parkour] game MySQL failed');
  }
  const parkour = await getPlayerParkour(uuid);
  return c.json(parkour);
});

/** GET /api/player/achievements — game MySQL first; Postgres fallback. */
api.get('/player/achievements', requireMcIdentity, async (c) => {
  const uuid = c.var.mcUuid!;
  try {
    const data = await getGamePlayerAchievements(uuid);
    return c.json({ achievements: data });
  } catch (err) {
    logger.warn({ err: String(err) }, '[player/achievements] game MySQL failed');
  }
  const data = await getPlayerAchievements(uuid);
  return c.json(data);
});

/** GET /api/player/cosmetics — game MySQL first; Postgres fallback. */
/** Shape contract: { unlocked, activeTrail, activeHat, activeKillEffect,
 *  activeMineEffect } — the dashboard reads exactly these names. */
function cosmeticsPayload(row: Record<string, unknown> | undefined) {
  let unlocked: string[] = [];
  const raw = row?.unlocked_cosmetics;
  if (typeof raw === 'string' && raw.trim().startsWith('[')) {
    try { unlocked = JSON.parse(raw); } catch { /* keep [] */ }
  }
  return {
    unlocked,
    activeTrail: (row?.active_trail as string) ?? null,
    activeHat: (row?.active_hat as string) ?? null,
    activeKillEffect: (row?.active_kill_effect as string) ?? null,
    activeMineEffect: (row?.active_mine_effect as string) ?? null,
  };
}

api.get('/player/cosmetics', requireMcIdentity, async (c) => {
  const mcUuid = c.var.mcUuid!;
  try {
    const rows = await getGamePlayerCosmetics(mcUuid);
    return c.json(cosmeticsPayload(rows[0]));
  } catch (err) {
    logger.warn({ err: String(err) }, '[player/cosmetics] game MySQL failed');
  }
  const data = await getPlayerCosmetics(mcUuid);
  return c.json(data);
});

/** POST /api/player/cosmetics/equip — { action: 'equip', cosmetic } or
 *  { action: 'unequip', type }. Applies on the live player via the bus, so
 *  the player must be online (the UI says so). */
api.post('/player/cosmetics/equip', writeRateLimit, requireMcIdentity, async (c) => {
  const mcUuid = c.var.mcUuid!;
  let body: { action?: string; cosmetic?: string; type?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
  const action = body.action === 'unequip' ? 'unequip' : 'equip';
  try {
    const response = await sendCommandWithResponse(
      'COSMETIC_SET',
      { uuid: mcUuid, action, cosmetic: (body.cosmetic ?? '').slice(0, 64), type: (body.type ?? '').slice(0, 32) },
      8_000,
    );
    if (response.status === 'OK') {
      return c.json((response.data ?? {}) as Record<string, unknown>);
    }
    return c.json({ error: response.error ?? 'Equip refused' }, 409);
  } catch (err) {
    logger.warn({ err: String(err) }, '[player/cosmetics/equip] dispatch failed');
    return c.json({ error: 'Game server did not respond' }, 501);
  }
});

/** GET /api/player/quests — game MySQL first; Postgres fallback. */
api.get('/player/quests', requireMcIdentity, async (c) => {
  const uuid = c.var.mcUuid!;
  try {
    const data = await getGamePlayerDailyQuests(uuid);
    return c.json({ quests: data });
  } catch (err) {
    logger.warn({ err: String(err) }, '[player/quests] game MySQL failed');
  }
  const data = await getPlayerDailyQuests(uuid);
  return c.json(data);
});

/** GET /api/player/legion — game MySQL first; Postgres fallback. Both paths
 * return the SAME shape ({legion: LegionInfo, members: LegionMemberInfo[]}):
 * the game helpers (B-11) map the plugin's legion_members/legions columns
 * (player_uuid, role — LegionRank enum names) into the LegionInfo form. */
api.get('/player/legion', requireMcIdentity, async (c) => {
  const uuid = c.var.mcUuid!;
  try {
    const legionId = await getGamePlayerLegionId(uuid);
    if (legionId) {
      const info = await getGameLegionInfo(legionId);
      const members = await getGameLegionMembers(legionId);
      // Projects: completed + in-flight contributions (progress card data).
      // Best-effort — a missing table degrades to empty lists, not a failed page.
      let projects: Awaited<ReturnType<typeof getGameLegionProjects>> = { completed: [], contributions: [] };
      try {
        projects = await getGameLegionProjects(legionId);
      } catch (perr) {
        logger.warn({ err: String(perr) }, '[player/legion] projects read failed — serving without');
      }
      return c.json({ legion: info, members, projects });
    }
  } catch (err) {
    // B-11: GameMySqlUnavailableError lands here — degrade explicitly to the
    // Postgres copy below (previously the outage was swallowed inside
    // gameQuery as [] and this fallback answered alone, invisibly).
    logger.warn({ err: String(err) }, '[player/legion] game MySQL failed — Postgres fallback');
  }
  const data = await getPlayerLegion(uuid);
  return c.json(data);
});

/* ---------------------------------------------------------------- Admin */

/**
 * GET /api/admin/server/status — enriched status for staff (TPS, memory, online
 * player list). The frontend proxy route (src/app/api/admin/status/route.ts)
 * forwards here with the X-Bot-Token + X-Admin-Discord-Id headers.
 */
api.get('/admin/server/status', requireStaffRole('helper'), async (c) => {
  if (!adminAuthOk(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  // Get the online count from Redis (fast, reliable)
  let count: number | null = null;
  try {
    count = await getOnlinePlayerCount();
  } catch {
    // Redis down — count stays null
  }

  // Fetch online player names from Postgres (best-effort — may fail on cold
  // start or if the table doesn't exist yet). Wrapped tightly so a Postgres
  // timeout never causes a 500 for this route.
  let onlinePlayers: { uuid: string; username: string }[] = [];
  try {
    const result = await query<{ uuid: string; username: string }>(
      `SELECT op.uuid, pn.username FROM online_players op LEFT JOIN player_names pn ON op.uuid = pn.uuid LIMIT 100`,
      [],
    );
    onlinePlayers = result.rows;
  } catch {
    // Table may not exist or pool not ready — degrade to just the count
  }

  return c.json({
    online: count !== null,
    playerCount: count ?? 0,
    maxPlayers: 200,
    onlinePlayers,
    source: count !== null ? 'redis' : 'unknown',
  });
});

/**
 * GET /api/admin/player?query=... — staff player lookup by username or UUID.
 * Returns the full profile (rank, prestige, stats, balances, username).
 */
api.get('/admin/player', requireStaffRole('helper'), async (c) => {
  if (!adminAuthOk(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const query_param = c.req.query('query') ?? '';
  if (!query_param) {
    return c.json({ error: 'Missing query parameter' }, 400);
  }

  // Try to resolve as UUID first, then as username
  let uuid: string | null = null;
  if (/^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/.test(query_param)) {
    uuid = query_param;
  } else {
    uuid = await getUuidByUsername(query_param);
  }

  if (!uuid) {
    return c.json({ error: 'Player not found' }, 404);
  }

  try {
    const profile = await getPlayerProfile(uuid);
    if (!profile) {
      return c.json({ uuid, error: 'Profile data not available yet' }, 200);
    }

    const balances = await getPlayerBalances(uuid);
    let username: string | null = null;
    try {
      username = await getNameByUuid(uuid);
    } catch {
      // Best effort
    }

    const p = profile as any;
    return c.json({
      uuid,
      username: username ?? 'Player',
      rank: p.rank?.level ?? 0,
      prestige: p.prestige?.level ?? 0,
      denarius: balances.denarius,
      auctoritas: balances.tokens,
      civitas: balances.beacons,
      aureus: balances.goldenCoins,
      blocksMined: p.stats?.blocksMined ?? 0,
      playtimeSeconds: Number(p.stats?.playTime ?? 0),
      pvpKills: p.stats?.pvpKills ?? 0,
      pvpDeaths: p.stats?.pvpDeaths ?? 0,
    });
  } catch (err) {
    logger.error({ err, uuid }, 'Admin player lookup failed');
    return c.json({ error: 'Failed to load player data' }, 500);
  }
});

/**
 * POST /api/admin/punish — forward a punishment to the plugin via Redis.
 * Body: { target, action, reason, duration, actor }
 *
 * S2-D01: the required role is DECLARED on the route (mod+) — 401 with no
 * valid credential, 403 authenticated-but-below-role, deny by default.
 * Attribution (X-03): the actor comes ONLY from the authenticated principal
 * (resolveStaffActor via the gate); a body `actor` value is never trusted and
 * never merged in. Every successful dispatch writes an attributed action_log
 * audit row.
 */
api.post('/admin/punish', requireStaffRole('mod'), async (c) => {
  let body: { target?: string; action?: string; reason?: string; duration?: string; actor?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const target = body.target ?? '';
  const action = body.action ?? '';
  const reason = body.reason ?? '';

  if (!target || !action) {
    return c.json({ error: 'Missing target or action' }, 400);
  }

  const staffActor = c.get('staffActor') ?? (await resolveStaffActor(c));

  // Try to forward via the Redis command bus
  try {
    const response = await sendCommandWithResponse(
      'PUNISH_PLAYER',
      { target, action, reason, duration: body.duration, actor: staffActor.name },
      5_000,
    );
    if (response.status === 'OK') {
      // S2-D01: attributed audit row AFTER the action succeeded (never blocks
      // the response — recordAction swallows its own failures).
      await recordAction({
        actor: await resolveAuditActor(c),
        action: 'admin.punish',
        target: target.slice(0, 120),
        detail: `action=${action}${reason ? '; reason=' + reason.slice(0, 200) : ''}`,
      });
      return c.json({ ok: true, result: response.data ?? null });
    }
    return c.json({ error: response.error ?? 'Plugin rejected the action' }, 502);
  } catch (err) {
    logger.error({ err: String(err), target, action }, 'admin punish: plugin dispatch threw');
    return c.json({ error: 'Plugin did not respond — punishment may not be wired yet' }, 501);
  }
});

/**
 * POST /api/admin/broadcast — forward a broadcast to the plugin.
 * S2-D01: role DECLARED on the route (helper+); attributed audit row on success.
 */
api.post('/admin/broadcast', requireStaffRole('helper'), async (c) => {
  let body: { message?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const message = body.message ?? '';
  if (!message || message.length < 1 || message.length > 256) {
    return c.json({ error: 'Message must be 1-256 characters' }, 400);
  }

  // ATTRIBUTION (B-01/X-04): broadcasts carry the resolved staff actor so the
  // plugin-side audit trail names who sent it.
  const staffActor = c.get('staffActor') ?? (await resolveStaffActor(c));

  try {
    const response = await sendCommandWithResponse('BROADCAST', { message, actor: staffActor.name }, 5_000);
    if (response.status === 'OK') {
      await recordAction({
        actor: await resolveAuditActor(c),
        action: 'admin.broadcast',
        detail: message.slice(0, 500),
      });
      return c.json({ ok: true });
    }
    return c.json({ error: response.error ?? 'Plugin rejected the broadcast' }, 502);
  } catch (err) {
    logger.error({ err: String(err) }, 'admin broadcast: plugin dispatch threw');
    return c.json({ error: 'Plugin did not respond — broadcast may not be wired yet' }, 501);
  }
});

/**
 * POST /api/admin/reload — trigger a config reload on the plugin.
 * S2-D01: role DECLARED on the route (admin — reloads change live economy and
 * anticheat behavior); attributed audit row on success.
 */
api.post('/admin/reload', requireStaffRole('admin'), async (c) => {
  const staffActor = c.get('staffActor') ?? (await resolveStaffActor(c));
  try {
    const response = await sendCommandWithResponse('RELOAD_CONFIG', { actor: staffActor.name }, 10_000);
    if (response.status === 'OK') {
      await recordAction({
        actor: await resolveAuditActor(c),
        action: 'admin.reload',
        detail: 'config reload dispatched',
      });
      return c.json({ ok: true });
    }
    return c.json({ error: response.error ?? 'Plugin rejected the reload' }, 502);
  } catch (err) {
    logger.error({ err: String(err) }, 'admin reload: plugin dispatch threw');
    return c.json({ error: 'Plugin did not respond — reload may not be wired yet' }, 501);
  }
});

/**
 * GET /api/player/permissions?uuid=...|discord_id=... — resolve LuckPerms
 * groups for a player. LuckPerms itself is UUID-keyed (it's a Minecraft
 * plugin — it has no concept of Discord identity), so `uuid` is the direct
 * lookup; `discord_id` is only a convenience for callers that only have a
 * Discord-session identity, resolved to a UUID the same way before querying.
 * Used by the frontend admin gate + AdminContext.
 */
api.get('/player/permissions', async (c) => {
  if (!botTokenMatches(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const uuidParam = c.req.query('uuid');
  const discordId = c.req.query('discord_id');
  if (!uuidParam && !discordId) {
    return c.json({ error: 'Missing uuid or discord_id' }, 400);
  }

  let uuid: string | null = uuidParam ?? null;
  if (!uuid && discordId) {
    try {
      uuid = await getUuidByDiscordId(discordId);
    } catch (err) {
      logger.warn({ err: String(err), discordId }, 'permissions: discord-id lookup failed — answering unprivileged');
      uuid = null;
    }
  }

  if (!uuid) {
    return c.json({ isAdmin: false, isMod: false, isHelper: false, groups: [] });
  }

  // Query LuckPerms groups from the database (the plugin writes them)
  let groups: string[] = [];
  try {
    const result = await query<{ primary_group: string }>(
      `SELECT primary_group FROM luckperms_players WHERE uuid = $1`,
      [uuid],
    );
    groups = result.rows.map((r: { primary_group: string }) => r.primary_group.toLowerCase());
  } catch (err) {
    // LuckPerms table may not exist or have a different name — fail closed
    // (all flags false), but log: this gates the website's admin panel, so an
    // outage silently locking every staff member out must be traceable.
    logger.warn({ err: String(err), uuid }, 'permissions: LuckPerms group query failed — all staff flags false');
  }

  // Derive admin flags from group names
  // These match the LuckPerms groups created by RankGroupBootstrapService.kt.
  // Group names use underscores (sr_mod, head_admin, jr_mod) not camelCase.
  const adminGroups = ['admin', 'sr_admin', 'head_admin', 'developer', 'manager', 'owner'];
  const modGroups = ['mod', 'sr_mod', 'jr_mod', ...adminGroups];
  const helperGroups = ['trainee', 'tester', 'builder', ...modGroups];

  return c.json({
    isAdmin: groups.some((g) => adminGroups.includes(g)),
    isMod: groups.some((g) => modGroups.includes(g)),
    isHelper: groups.some((g) => helperGroups.includes(g)),
    groups,
  });
});

/* ---------------------------------------------------------------- Public */

/**
 * GET /api/leaderboards/parkour/:course — fastest completions for a course.
 * Public (no auth). The plugin stores records in `parkour_records`; names aren't
 * persisted, so each entry carries the uuid and a best-effort display name.
 */
api.get('/leaderboards/parkour/:course', async (c) => {
  const course = c.req.param('course') ?? '';
  if (!course) {
    return c.json({ error: 'Missing course parameter' }, 400);
  }
  const limit = intParam(c.req.query('limit'), 20);

  let rows;
  try {
    rows = await getParkourLeaderboard(course, limit);
  } catch {
    return c.json({ course, entries: [], error: 'Database unavailable' }, 503);
  }
  const entries = rows.map((row, i) => ({
    rank: i + 1,
    uuid: row.uuid,
    username: row.uuid,
    best_time_ms: row.best_time_ms,
    completions: row.completions,
  }));
  return c.json({ course, entries });
});

/**
 * GET /api/leaderboards/elo — Arena Ranking (ELO) leaderboard.
 * Public. Ordered by ELO desc, ties broken by peak ELO.
 */
api.get('/leaderboards/elo', async (c) => {
  const limit = intParam(c.req.query('limit'), 20);

  let rows;
  try {
    rows = await getEloLeaderboard(limit);
  } catch {
    return c.json({ entries: [], error: 'Database unavailable' }, 503);
  }
  const entries = rows.map((row, i) => ({
    rank: i + 1,
    uuid: row.uuid,
    username: row.uuid,
    elo: row.elo,
    wins: row.wins,
    losses: row.losses,
    peak_elo: row.peak_elo,
  }));
  return c.json({ entries });
});

/**
 * GET /api/leaderboards/waves — endless-wave survival leaderboard.
 * Public. Ordered by highest wave reached desc.
 */
api.get('/leaderboards/waves', async (c) => {
  const limit = intParam(c.req.query('limit'), 20);

  let rows;
  try {
    rows = await getWaveLeaderboard(limit);
  } catch {
    return c.json({ entries: [], error: 'Database unavailable' }, 503);
  }
  const entries = rows.map((row, i) => ({
    rank: i + 1,
    uuid: row.uuid,
    username: row.uuid,
    highest_wave: row.highestWave,
    total_sessions: row.totalSessions,
  }));
  return c.json({ entries });
});

/**
 * GET /api/leaderboards/:type — top N by board.
 *
 * Registered AFTER the specific /leaderboards/{parkour/:course,elo,waves}
 * routes so those static paths win over this parameter route (registration
 * order decides in Hono — registered first, this route used to shadow
 * /leaderboards/elo and /leaderboards/waves into its own 400).
 *
 * Legacy boards (denarius | blocks | prestige | playtime) keep their original
 * response shape. The 12a expansion adds rank | legion | koth | colosseum
 * (see src/api/expansion/leaderboards.ts for their entry shapes). All boards
 * are public (anonymous-OK) and served through the SWR cache: 60s fresh,
 * 5min stale-while-revalidate, plus Cache-Control so any CDN honors the same.
 */
api.get('/leaderboards/:type', async (c) => {
  const type: string = c.req.param("type") ?? "";
  const legacyTypes = ['denarius', 'blocks', 'prestige', 'playtime'];
  if (!legacyTypes.includes(type) && !isExpansionBoard(type)) {
    return c.json(
      { error: "Invalid leaderboard type; must be 'denarius', 'blocks', 'prestige', 'playtime', 'rank', 'legion', 'koth', or 'colosseum'" },
      400,
    );
  }
  const limit = limitParam(c.req.query('limit'), 20, 100);

  try {
    return await swrJson(c, `leaderboard:${type}:${limit}:v1`, async () => {
      if (isExpansionBoard(type)) {
        // Expansion boards build their own entry shapes.
        return { type, entries: (await fetchExpansionBoard(type, limit)).entries };
      }
      // Type validated above against the legacy allowlist; the cast only satisfies getLeaderboard's union parameter.
      const rows = await getLeaderboard(type as 'denarius' | 'blocks' | 'prestige' | 'playtime', limit);
      // Add 1-based rank and a display username for the bot's embeds.
      const entries = rows.map((row, i) => ({
        rank: i + 1,
        uuid: row.uuid,
        username: row.name ?? row.uuid,
        value: row.value,
        secondary: row.secondary,
      }));
      return { type, entries };
    });
  } catch {
    return c.json({ type, entries: [], error: 'Database unavailable' }, 503);
  }
});

/**
 * LATENCY FIX (2026-08-25): Layerbase Redis degraded to multi-second round trips —
 * the retry that fixed correctness pushed status responses to 5-6.5s, which the
 * frontend's own 5s abort turned back into "offline". Three layers now:
 *   1. a 10s memo (the plugin only rewrites the key every 20s anyway)
 *   2. Redis attempts individually bounded at 700ms (fast-fail, never hang)
 *   3. on Redis failure, the Postgres online_players snapshot as the fallback signal
 *      — the plugin maintains that table too, so "is the server up" survives a
 *      Redis outage entirely.
 */
const statusCountMemo: { at: number; value: number | null } = { at: 0, value: null };
const joinableMemo: { at: number; value: boolean } = { at: 0, value: true };
const STATUS_MEMO_TTL_MS = 10_000;
const REDIS_ATTEMPT_TIMEOUT_MS = 700;

function withAttemptTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise.then(
      (v) => v,
      () => null,
    ),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

/** GET /api/server/status — online player count from Redis (live) or DB. */
api.get('/server/status', async (c) => {
  try {
    let count: number | null;
    let source: string;
    if (Date.now() - statusCountMemo.at < STATUS_MEMO_TTL_MS) {
      count = statusCountMemo.value;
      source = 'memo';
    } else {
      const redisCount = await withAttemptTimeout(getOnlinePlayerCount(), REDIS_ATTEMPT_TIMEOUT_MS * 2);
      if (redisCount !== null) {
        count = redisCount;
        source = 'redis';
      } else {
        // Redis slow/down: the online_players snapshot is the plugin's other
        // heartbeat surface — mirrored in BOTH databases. Postgres first (the
        // canonical web copy), then the game MySQL (healthy while Hyperdrive
        // is sick). COUNT>0 = server up AND players logged in; an empty table
        // reads as up-with-0 (the plugin clears it on graceful disable).
        let snap: { n: number }[] | null = null;
        try {
          const pg = await withAttemptTimeout(
            query<{ n: number }>('SELECT COUNT(*)::int AS n FROM online_players', []),
            1_200,
          );
          if (pg) snap = pg.rows;
        } catch {
          snap = null;
        }
        if (!snap) {
          snap = await withAttemptTimeout(
            gameQuery<{ n: number }>('SELECT COUNT(*) AS n FROM online_players', []),
            1_200,
          );
        }
        count = snap && snap.length > 0 ? Number(snap[0].n ?? 0) : null;
        source = 'db-fallback';
      }
      statusCountMemo.at = Date.now();
      statusCountMemo.value = count;
    }
    // The plugin writes ImperiumMC:online_count every 20s with a 60s TTL. A present
    // key (even value 0) means the server process is alive and heartbeating — that's
    // "online", regardless of whether anyone is logged in. Only a missing key (null,
    // expired/never-written) means the server is actually down. Conflating "0 players"
    // with "offline" made an empty-but-live server read as Offline in Discord/the site.
    const isUp = count !== null;

    // JOINABILITY (2026-09-13 incident): the heartbeat says the process is
    // alive; this TCP probe says whether players can actually CONNECT. During
    // the birdflop port-forwarding outage the site showed a green Online pill
    // while every connection was refused — 'joinable' lets the UI say
    // "degraded" honestly. Memoized briefly; the probe is cheap but pointless
    // to repeat per request.
    let joinable: boolean | null = null;
    if (isUp) {
      if (Date.now() - joinableMemo.at > 15_000) {
        joinableMemo.at = Date.now();
        joinableMemo.value = await probeTcpPort(25565, 3_000);
      }
      joinable = joinableMemo.value;
    }

    // Online names for the Discord /online embed (12c: "player list + current
    // festival"). Names are public in-game (tab list), so this stays public;
    // best-effort from the online_players snapshot — a missing/empty table
    // degrades to just the count, never an error.
    let players: string[] = [];
    try {
      // HYPERDRIVE OUTAGE (2026-08-25): web Postgres via Hyperdrive is sick
      // (db:down ~84% on /health) while the game MySQL wire path is fully
      // healthy. Names are public in-game data the game DB also holds — try
      // Postgres first (bounded), fall back to the game MySQL so the players
      // list survives a Hyperdrive outage.
      let names: Array<{ username: string | null }> = [];
      try {
        const pgNames = await withAttemptTimeout(
          query<{ username: string | null }>(
            `SELECT pn.username FROM online_players op
              LEFT JOIN player_names pn ON pn.uuid = op.uuid
             ORDER BY op.uuid
             LIMIT 100`,
            [],
          ),
          1_200,
        );
        if (pgNames) names = pgNames.rows;
      } catch {
        names = [];
      }
      if (names.length === 0) {
        const mysqlNames = await withAttemptTimeout(
          gameQuery<{ username: string | null }>(
            `SELECT pn.username FROM online_players op
              LEFT JOIN player_names pn ON pn.uuid = op.uuid
             ORDER BY op.uuid
             LIMIT 100`,
            [],
          ),
          1_200,
        );
        if (mysqlNames) names = mysqlNames;
      }
      players = names.map((row) => row.username).filter((name): name is string => Boolean(name));
    } catch (err) {
      logger.warn({ err: String(err) }, 'server/status: online_players query failed — returning count only');
    }

    return c.json({
      online: isUp,
      joinable,
      playerCount: count ?? 0,
      maxPlayers: 200,
      players,
      timestamp: Date.now(),
      source,
    });
  } catch {
    return c.json({
      online: false,
      joinable: false,
      playerCount: 0,
      maxPlayers: 200,
      players: [],
      timestamp: Date.now(),
      source: 'unavailable',
    });
  }
});

/**
 * GET /api/server/features — static feature catalog shown on the website's
 * landing/marketing pages. These are curated counts (not live DB figures) that
 * describe the breadth of the server's content; they only change at release
 * boundaries, so they're served as a constant rather than queried per-request.
 */
api.get('/server/features', (c) => {
  return c.json({
    enchants: 201,
    pets: 52,
    crystals: 38,
    crates: 30,
    mines: 100,
    dungeons: 12,
    bosses: 8,
    story_chapters: 50,
    challenges: 102,
    achievements: 194,
    languages: 45,
    festivals: 10,
    ranks: 100,
    prestiges: 25,
  });
});

/* -------------------------------------------------------------- Linking */

/** B-C31: bounded wait for the plugin's CONFIRM_DISCORD_LINK ack — a dead
 * plugin must not hang the bot's /link confirm (the link still succeeds). */
const DISCORD_LINK_REWARD_TIMEOUT_MS = 5_000;

/** POST /api/link/initiate — generate a 6-char code stored in Redis (10 min TTL). */
api.post('/link/initiate', requireAuth, async (c) => {
  const user = c.var.user!;
  if (!user.discordId) {
    return c.json({ error: 'This account has no Discord identity to link. Sign in with Discord first.' }, 400);
  }
  const code = await createLinkCode({ discordId: user.discordId }, 600);
  return c.json({
    code,
    expiresIn: 600,
    instructions:
      'Run `/link <code>` in-game on the Minecraft server to link your account.',
  });
});

/**
 * POST /api/link/confirm — validate a code and persist the link. Called by the bot.
 *
 * Security model (do NOT trust caller-supplied identity):
 *  - The `code` is the only thing the caller must supply truthfully. It is a
 *    single-use, time-limited secret minted by either the web flow (Redis,
 *    carries the authenticated user's discordId) or the in-game flow (SQLite,
 *    carries only the Minecraft UUID).
 *  - For the Redis/web flow, the `discordId` comes from the stored code record
 *    (set at `/link/initiate` by the authenticated user), NOT from the request
 *    body. A body-supplied discordId that disagrees with the stored one is a
 *    403. This prevents an attacker with the bot token from linking an
 *    arbitrary Discord to an arbitrary Minecraft account.
 *  - For the SQLite/in-game flow, the plugin's `link_codes` table has no
 *    discord_id column, so the bot legitimately supplies discordId. The code is
 *    consumed atomically (DELETE...RETURNING) so it can't be replayed.
 *  - Either way, a hijack guard (409) prevents a UUID already linked to a
 *    DIFFERENT Discord account from being silently rebound.
 */
api.post('/link/confirm', async (c) => {
  // Bot-only: persisting arbitrary account links must be authenticated.
  if (!botTokenMatches(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  let body: { code?: string; uuid?: string; discordId?: string };
  try {
    body = (await c.req.json()) as { code?: string; uuid?: string; discordId?: string };
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const code = (body.code ?? '').toUpperCase();
  if (!code) {
    return c.json({ error: 'Missing code' }, 400);
  }

  // The code was written to Redis by the plugin's `/discord link` command
  // (ImperiumMC:link_code:<CODE> -> {uuid, discordId?}, 10min TTL) — consumed
  // single-use via GET+DEL. Both the in-game and website linking flows go
  // through Redis now (the SQLite link_codes path was removed during the
  // Workers migration — Workers has no local filesystem).
  const record = await consumeLinkCode(code);
  if (!record?.uuid) {
    return c.json({ error: 'Invalid or expired code. Run /discord link in-game for a fresh one.' }, 404);
  }

  // Discord id: prefer the value bound to the code at /link/initiate (web flow,
  // where the authenticated user is known); otherwise take the bot-supplied
  // body value (in-game flow, where only the UUID is known at code-creation).
  const discordId = record.discordId ?? body.discordId ?? '';
  if (!discordId) {
    return c.json({ error: 'Missing discordId' }, 400);
  }
  // If the caller sent a discordId, it MUST match the code's bound holder —
  // never let a mismatched caller claim someone else's pending link.
  if (body.discordId && record.discordId && body.discordId !== record.discordId) {
    return c.json({ error: 'discordId does not match the code holder' }, 403);
  }

  // Hijack guard (security): refuse to silently rebind an already-linked UUID
  // to a different Discord account. When the guard's DB read itself fails we
  // FAIL CLOSED: the upsert below is ON CONFLICT DO UPDATE, so it would never
  // "fail loudly" on a real conflict — the old fall-through let a transient
  // read error during a working write window silently complete a hijack.
  try {
    const existing = await isAlreadyLinked(record.uuid);
    if (existing && existing !== discordId) {
      return c.json(
        { error: 'Minecraft account already linked to a different Discord' },
        409,
      );
    }
  } catch (err) {
    logger.error({
      uuid: record.uuid,
      discordId,
      err: String(err),
    }, 'link hijack-guard unavailable — refusing link (fail closed)');
    return c.json({ error: 'Link check unavailable — try again shortly.' }, 503);
  }

  try {
    // B-C31: the upsert's inserted-vs-updated signal (RETURNING xmax = 0) is
    // the FIRST-link test. Only a fresh row dispatches CONFIRM_DISCORD_LINK —
    // the plugin's handler grants the first-link reward (25,000 Denarius +
    // 1 Crate Key) and is expected to keep its own once-per-player grant
    // ledger. Re-links (same Discord re-confirmed, or a re-link after unlink)
    // never re-trigger the reward from this route.
    const firstLink = await upsertDiscordLink(record.uuid, discordId);
    let rewardDispatched = false;
    if (firstLink) {
      try {
        const response = await sendCommandWithResponse(
          'CONFIRM_DISCORD_LINK',
          { player_uuid: record.uuid, discord_id: discordId },
          DISCORD_LINK_REWARD_TIMEOUT_MS,
        );
        rewardDispatched = response.ok;
        if (!response.ok) {
          logger.warn(
            { uuid: record.uuid, status: response.status, error: response.error },
            'CONFIRM_DISCORD_LINK rejected by plugin — link persisted, first-link reward NOT granted',
          );
        }
      } catch (err) {
        // The link itself is already persisted — a dispatch failure (plugin
        // down / handler not yet deployed) must NOT fail the confirm: the code
        // was single-use-consumed, so a bot retry would 404 and the player
        // would be told an error for a link that actually succeeded.
        logger.warn(
          { uuid: record.uuid, err: String(err) },
          'CONFIRM_DISCORD_LINK dispatch failed — link persisted, first-link reward NOT granted',
        );
      }
    }
    // Resolve the Minecraft username so the bot can show "linked to <name>"
    // instead of "linked to undefined". Falls back to the UUID if the player
    // hasn't joined since the player_names registry was introduced.
    let username: string | null = null;
    try {
      username = await getNameByUuid(record.uuid);
    } catch {
      // player_names table missing or PG hiccup — degrade to the uuid.
    }
    return c.json({
      ok: true,
      linked: true,
      discordId,
      uuid: record.uuid,
      username: username ?? record.uuid,
      rewardDispatched,
    });
  } catch (err) {
    logger.error({ uuid: record.uuid, discordId, err: String(err) }, 'failed to persist Discord link');
    return c.json({ error: 'Failed to persist link' }, 500);
  }
});

/**
 * DELETE /api/link?discord_id=...|uuid=... — remove a Discord↔Minecraft link.
 * `discord_id` is used by the bot's /unlink command (that's the only identity
 * it has in a Discord DM). `uuid` is used by the website — its sessions are
 * uuid-first regardless of how the player logged in, so "unlink my Discord"
 * is naturally keyed on the account being unlinked, not on the Discord ID
 * that happens to have been resolved from the session. Returns 404 if no
 * link existed.
 */
api.delete('/link', async (c) => {
  // Bot-only: unlinking arbitrary accounts must be authenticated.
  if (!botTokenMatches(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const discordId = c.req.query('discord_id');
  const uuid = c.req.query('uuid');
  if (!discordId && !uuid) {
    return c.json({ error: 'Missing discord_id or uuid query parameter' }, 400);
  }
  const removed = uuid ? await deleteDiscordLinkByUuid(uuid) : await deleteDiscordLinkByDiscordId(discordId!);
  if (!removed) {
    return c.json({ error: 'No link found for this account' }, 404);
  }
  return c.json({ unlinked: true });
});

/* ------------------------------------------------------------------ Store */

// Function, not a module-scope constant: `env` isn't populated until
// initEnvFromProcess()/initEnvFromBindings() runs, which happens after this
// module's own top-level code has already been evaluated.
function frontendUrl(): string {
  return env.isProduction ? 'https://romanica.net' : 'http://localhost:3000';
}

/**
 * B-C25 — guest checkout identity resolution.
 *
 * The frontend's guest flow (CartDrawer) calls cart-checkout with the bot
 * token and a `guestUsername` in the JSON body instead of a verified
 * `X-Mc-Uuid`. Resolution mirrors the repo's existing identity stack:
 *
 *   1. getUuidByUsername — the plugin-maintained player_names registry
 *      (covers Java + Bedrock players who have joined), falling back to
 *      Mojang/PlayerDB for Java names never seen on the server.
 *   2. Bedrock dot-names never resolve externally (no Mojang equivalent), so
 *      a player_names miss derives the offline UUID exactly the way the
 *      plugin's UuidMigrationService.offlineUuid does — UUID v3 (MD5) of
 *      "OfflinePlayer:<name>" (name including the dot). Verified against a
 *      real offline-mode server log: name "Notch" →
 *      b50ad385-829d-3141-a216-7e7d7539ba7f.
 *
 * Anything else (bad charset, too long, unknown Java name) is unresolvable —
 * the caller must 400, never guess.
 */
function bedrockOfflineUuid(username: string): string {
  // Java: UUID.nameUUIDFromBytes → MD5, version nibble forced to 3 (v3),
  // IETF variant bits — byte-identical to the JDK (and thus the plugin).
  const h = createHash('md5').update(`OfflinePlayer:${username}`, 'utf8').digest();
  h[6] = (h[6]! & 0x0f) | 0x30;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const hex = h.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function resolveGuestBuyerUuid(username: string): Promise<string | null> {
  const name = username.trim();
  const isBedrock = /^\.[a-zA-Z0-9_]{3,16}$/.test(name);
  if (!isBedrock && !/^[a-zA-Z0-9_]{3,16}$/.test(name)) return null; // reject anything name-shaped wrong
  const known = await getUuidByUsername(name, { strictPlatform: true }).catch(() => null);
  if (known) return known;
  if (isBedrock) return bedrockOfflineUuid(name);
  return null; // Java name unknown to player_names AND Mojang/PlayerDB
}

/**
 * Auth gate for /store/* routes. Real browser traffic never carries this
 * backend's own session cookie — the live session lives on imperium-frontend's
 * edge-native cookie (a different domain, a different JWT implementation
 * entirely). imperium-frontend verifies that session and the caller's linked
 * status itself, then calls in here with the bot token plus the
 * already-verified `X-Mc-Uuid` header. Session-cookie auth is kept only as a
 * fallback so these routes remain directly testable against the backend.
 */
const storeAuth: MiddlewareHandler<ApiEnv> = async (c, next) => {
  // B-13 two-tier: X-Mc-Uuid is an identity ASSERTION, so once the split is
  // active it requires the internal SERVICE token specifically — the shared
  // bot token alone may no longer name any player. While
  // INTERNAL_SERVICE_TOKEN is unset it falls back to BOT_API_TOKEN (env.ts
  // compat), so nothing breaks until the owner deliberately activates the
  // split. The outer gate accepts either secret.
  const presented = c.req.header('x-bot-token') ?? '';
  const isService =
    Boolean(env.internalServiceToken) &&
    presented.length === env.internalServiceToken.length &&
    timingSafeEqual(Buffer.from(presented), Buffer.from(env.internalServiceToken));
  if (botTokenMatches(c) || isService) {
    const uuid = c.req.header('x-mc-uuid');
    if (uuid && !isService) {
      return c.json({ error: 'X-Mc-Uuid requires the internal service token', code: 'IDENTITY_NEEDS_SERVICE_TOKEN' }, 403);
    }
    if (!uuid) {
      // B-C25: guest checkout. The frontend's guest flow sends the bot token
      // plus `guestUsername` in the JSON body instead of X-Mc-Uuid; before
      // this branch every such request died here with 400 'Missing X-Mc-Uuid'.
      // Only fires when the header is absent AND the body carries a guest
      // name — normal bot traffic (which always sends the header) is unchanged,
      // and body-less GETs parse no body at all.
      let guestUsername: string | undefined;
      try {
        const body = (await c.req.json()) as { guestUsername?: unknown } | null;
        const raw = body?.guestUsername;
        if (typeof raw === 'string' && raw.trim().length > 0) guestUsername = raw.trim();
      } catch {
        // No body / not JSON — not a guest request; fall through to the 400.
      }
      if (guestUsername !== undefined) {
        const guestUuid = await resolveGuestBuyerUuid(guestUsername);
        if (!guestUuid) {
          return c.json(
            { error: `unknown minecraft username "${guestUsername}" — check the spelling (Bedrock names start with a ".")` },
            400,
          );
        }
        c.set('mcUuid', guestUuid);
        await next();
        return;
      }
      return c.json({ error: 'Missing X-Mc-Uuid header' }, 400);
    }
    // Validate UUID format — accepts Minecraft UUIDs and Bedrock .prefix names
    // only. Minecraft is the sole identity for store routes; a Discord ID
    // (linked or not) is never a valid substitute, so this doesn't accept
    // Discord snowflakes even as a fallback — the frontend must resolve (or
    // reject) the linked MC account before ever calling in here.
    if (!/^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/.test(uuid)
        && !/^\.[a-zA-Z0-9_]{3,16}$/.test(uuid)) {
      return c.json({ error: 'Invalid UUID format' }, 400);
    }
    c.set('mcUuid', uuid);
    await next();
    return;
  }
  if (!c.var.user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  if (!c.var.mcUuid) {
    return c.json({ error: 'Minecraft account not linked', linkRequired: true }, 403);
  }
  await next();
};

/**
 * Postgres here is a performance cache, never a hard dependency — PayNow's
 * own customer-lookup-by-minecraft_uuid is the actual source of truth.
 * A DB outage should make the store slower (an extra PayNow round trip per
 * request instead of a cached row), never take checkout/subscriptions/
 * cancellation down entirely. Every DB call on this path goes through one of
 * these two wrappers so that failure mode is enforced in one place.
 */
async function dbReadOrNull<T>(label: string, fn: () => Promise<T | null>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    logger.warn({ err, label }, 'DB read failed on store path — degrading to a live PayNow call');
    return null;
  }
}

function dbWriteBestEffort(label: string, fn: () => Promise<void>): void {
  fn().catch((err: unknown) => {
    logger.warn({ err, label }, 'DB cache write failed on store path — non-fatal, continuing');
  });
}

/** Resolve (and lazily create) the PayNow customer id for the calling player. */
async function resolvePaynowCustomerId(uuid: string): Promise<string> {
  const existing = await dbReadOrNull('getPaynowCustomerId', () => getPaynowCustomerId(uuid));
  if (existing) return existing;
  // Source of truth regardless of cache state: PayNow's own lookup-by-uuid
  // (inside findOrCreatePaynowCustomer) finds an existing customer even if
  // our cache never had it or just failed to read.
  const bedrockName = isFloodgateUuid(uuid)
    ? await dbReadOrNull('getNameByUuid', () => getNameByUuid(uuid))
    : null;
  const customerId = await findOrCreatePaynowCustomer(uuid, bedrockName);
  dbWriteBestEffort('setPaynowCustomerId', () => setPaynowCustomerId(uuid, customerId));
  return customerId;
}

/**
 * B-21 status-code mapping: upstream PayNow failures answer 502 with PayNow's
 * own message, but the client's own 8s deadline surfaces as status 504 — the
 * honest "gateway timed out, safe to retry" answer, not a generic 500/502.
 * Returns [body, status].
 */
function paynowErrorReply(err: PaynowApiError): [{ error: string }, 400 | 502 | 504] {
  if (err.status === 504) {
    return [{ error: 'PayNow did not respond in time. Please try again shortly.' }, 504];
  }
  // PayNow refusing the request itself (limits, unknown player, gifting rules)
  // is the buyer's to fix; a 401 means our own API key is broken.
  if (err.status >= 400 && err.status < 500 && err.status !== 401) {
    return [{ error: err.message }, 400];
  }
  return [{ error: err.message }, 502];
}

/**
 * GET /api/store/subscription — the caller's current donor subscription, if any.
 * Reads from our webhook-fed cache first (fast, no PayNow round trip); falls
 * back to a live Storefront API call if we've never seen a webhook for this
 * player yet (e.g. their very first purchase, before the webhook lands), if the
 * cache itself is unreachable, or if the cached row is STALE (B-09: a dropped
 * cancel webhook would otherwise show a canceled subscriber as active forever).
 */
api.get('/store/subscription', storeAuth, async (c) => {
  const uuid = c.var.mcUuid!;

  const cached = await dbReadOrNull('getCachedSubscription', () => getCachedSubscription(uuid));
  // B-21: allowlist on the CACHED READ too — the webhook previously cached
  // any product_id verbatim, so a foreign/test product could be served here
  // as the player's active tier while the live path (isDonorSubscriptionProduct
  // filter below) said the opposite. An off-catalog cached row is treated as
  // stale: fall through to PayNow, which both filters and knows the truth.
  if (cached && isDonorSubscriptionProduct(cached.product_id) && !isSubscriptionCacheStale(cached.updated_at)) {
    return c.json({
      subscriptionId: cached.subscription_id,
      productId: cached.product_id,
      status: cached.status,
    });
  }

  try {
    const customerId = await resolvePaynowCustomerId(uuid);
    const token = await createCustomerToken(customerId);
    const subs = await getCustomerSubscriptions(token);
    const active = subs.find((s) => isDonorSubscriptionProduct(String(s.product_id ?? '')));
    if (!active) {
      return c.json({ subscription: null });
    }
    return c.json({
      subscriptionId: active.id,
      productId: active.product_id,
      status: active.status,
    });
  } catch (err) {
    logger.error({ err, uuid }, 'Failed to fetch live PayNow subscription');
    // `available:false` lets the caller tell "genuinely not subscribed" from
    // "PayNow is down" — the pre-fix body was indistinguishable from a real
    // null, so active subscribers saw "no subscription" during outages.
    return c.json({ subscription: null, available: false });
  }
});

/**
 * POST /api/store/subscription/cancel — cancel the caller's active donor
 * subscription. Always verifies live against PayNow (never trusts the cache
 * for an authorization decision) that the subscription actually belongs to
 * the calling player before canceling — the DB cache is only ever used to
 * find a *candidate* subscription id, and even that step degrades to asking
 * PayNow directly if the cache is unreachable.
 */
api.post('/store/subscription/cancel', storeAuth, async (c) => {
  const uuid = c.var.mcUuid!;

  let subscriptionId: string | null = null;
  const cached = await dbReadOrNull('getCachedSubscription', () => getCachedSubscription(uuid));
  if (cached) {
    subscriptionId = cached.subscription_id;
  } else {
    try {
      const customerId = await resolvePaynowCustomerId(uuid);
      const token = await createCustomerToken(customerId);
      const subs = await getCustomerSubscriptions(token);
      const active = subs.find((s) => isDonorSubscriptionProduct(String(s.product_id ?? '')));
      subscriptionId = active?.id ?? null;
    } catch (err) {
      logger.error({ err, uuid }, 'Failed to resolve subscription to cancel');
      return c.json({ error: 'Could not reach PayNow to look up your subscription. Please try again shortly.' }, 502);
    }
  }

  if (!subscriptionId) {
    return c.json({ error: 'No active subscription found' }, 404);
  }

  // Authorization check: always confirm live against PayNow that this
  // subscription's customer resolves back to the calling player, even if the
  // id came from our own cache — a stale/tampered cache row must never be
  // enough on its own to cancel someone's subscription.
  try {
    const [sub, customerId] = await Promise.all([
      getSubscriptionById(subscriptionId),
      resolvePaynowCustomerId(uuid),
    ]);
    if (sub.customer_id !== customerId) {
      logger.warn({ uuid, subscriptionId }, 'Subscription cancel attempted against a mismatched customer');
      return c.json({ error: 'No active subscription found' }, 404);
    }
  } catch (err) {
    if (err instanceof PaynowApiError && err.status === 404) {
      return c.json({ error: 'No active subscription found' }, 404);
    }
    if (err instanceof PaynowApiError && err.status === 504) {
      return c.json({ error: 'Could not verify your subscription with PayNow. Please try again shortly.' }, 504);
    }
    logger.error({ err, uuid, subscriptionId }, 'Failed to verify subscription ownership before cancel');
    return c.json({ error: 'Could not verify your subscription with PayNow. Please try again shortly.' }, 502);
  }

  try {
    await cancelSubscription(subscriptionId);
  } catch (err) {
    if (err instanceof PaynowApiError) {
      logger.warn({ err: err.body, status: err.status, uuid, subscriptionId }, 'PayNow subscription cancel failed');
      const [body, status] = paynowErrorReply(err);
      return c.json(body, status);
    }
    logger.error({ err, uuid, subscriptionId }, 'Subscription cancel failed');
    return c.json({ error: 'Cancellation service unavailable. Please try again.' }, 500);
  }

  // B-11: AWAIT the cancel-path cache write. Fire-and-forget work is torn
  // down the moment the response returns in Workers — a killed write left
  // status:'active' cached forever (B-09's exact shape). Awaiting it here
  // guarantees the write completes before the caller sees success; a write
  // FAILURE is logged but still returns ok (the cancel DID happen at PayNow,
  // which is the source of truth — and the B-09 staleness fall-through
  // self-heals a stale row on the next read).
  try {
    const productId = cached?.product_id ?? '';
    await upsertCachedSubscription(uuid, subscriptionId, productId, 'canceled');
  } catch (err) {
    logger.error({ err: String(err), uuid, subscriptionId }, 'cancel-path subscription cache write FAILED — row may stay stale until the staleness fall-through heals it');
  }

  return c.json({ ok: true, subscriptionId, status: 'canceled' });
});

/**
 * GET /api/store/products — the in-game storefront catalog (public read).
 */
api.get('/store/products', async (c) => {
  return c.json({
    tiers: DONOR_TIERS.map((t) => ({
      id: t.id,
      monthly: { productId: t.subscriptionProductId, subscription: true },
      lifetime: { productId: t.lifetimeProductId, subscription: false },
    })),
  });
});

/**
 * GET /api/assets/texture?tag=<assets-tag>&folder=<item|block>&path=<texture-name>
 * — read-only proxy for the ImperiumMC AIDEV vision toolkit (2026-08-25). The game
 * host's route to raw.githubusercontent.com is dead, but Cloudflare reaches the
 * community minecraft-assets mirror fine. Inputs strictly validated ([a-z0-9_] for
 * folder/path — no dots or slashes, so no traversal); the .png suffix is appended
 * server-side. Responses are edge-cached for a day.
 */
api.get('/assets/texture', async (c) => {
  const tag = c.req.query('tag') ?? '';
  const folder = c.req.query('folder') ?? '';
  const path = c.req.query('path') ?? '';
  if (!/^[A-Za-z0-9_.-]+$/.test(tag) || !/^[a-z0-9_]+$/.test(folder) || !/^[a-z0-9_]+$/.test(path)) {
    return c.json({ error: 'Bad tag/folder/path' }, 400);
  }
  const upstream = `https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/${encodeURIComponent(tag)}/assets/minecraft/textures/${folder}/${path}.png`;
  const resp = await fetch(upstream, { cf: { cacheTtl: 86_400, cacheEverything: true } });
  if (!resp.ok) {
    return c.json({ error: `Upstream ${resp.status}` }, 502);
  }
  const bytes = await resp.arrayBuffer();
  return new Response(bytes, {
    headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' },
  });
});
/**
 * POST /api/store/checkout — create a checkout session for one product and
 * return the URL to redirect the browser to. `subscription` must match how
 * the target product is configured in PayNow (subscription vs one-time).
 */
api.post('/store/checkout', storeAuth, async (c) => {
  const uuid = c.var.mcUuid!;
  let body: { productId?: string; subscription?: boolean };
  try {
    body = (await c.req.json()) as { productId?: string; subscription?: boolean };
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  if (!body.productId) {
    return c.json({ error: 'Missing productId' }, 400);
  }
  // B-14 remainder: the cart route validates every line against the product
  // allowlist; this single-item path used to check presence only, so any
  // hidden/test/foreign product_id reached PayNow verbatim (paid-but-
  // undelivered orders). Same rule as the cart: the subscription flag must
  // match the product's kind.
  const isSub = body.subscription === true;
  if (isSub && !isDonorSubscriptionProduct(body.productId)) {
    return c.json({ error: 'Product is not a valid subscription' }, 400);
  }
  if (!isSub && !isOneTimeStoreProduct(body.productId)) {
    return c.json({ error: 'Product is not a valid one-time purchase' }, 400);
  }

  try {
    const customerId = await resolvePaynowCustomerId(uuid);
    const session = await createCheckoutSession({
      customerId,
      productId: body.productId,
      subscription: isSub,
      returnUrl: `${frontendUrl()}/dashboard/subscription?checkout=success`,
      cancelUrl: `${frontendUrl()}/store?checkout=canceled`,
    });
    return c.json({ url: session.url });
  } catch (err) {
    if (err instanceof PaynowApiError) {
      logger.warn({ err: err.body, status: err.status, uuid }, 'PayNow checkout creation failed');
      const [body, status] = paynowErrorReply(err);
      return c.json(body, status);
    }
    logger.error({ err: err instanceof Error ? err.message : String(err), uuid }, 'Checkout creation failed');
    return c.json({ error: 'Checkout service unavailable. Please try again.' }, 500);
  }
});

/**
 * POST /api/store/subscription/preview-change — proration preview for
 * switching the caller's active donor subscription to a different tier.
 * No charge, no side effects.
 */
api.post('/store/subscription/preview-change', storeAuth, async (c) => {
  const uuid = c.var.mcUuid!;
  let body: { targetProductId?: string };
  try {
    body = (await c.req.json()) as { targetProductId?: string };
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  if (!body.targetProductId || !isDonorSubscriptionProduct(body.targetProductId)) {
    return c.json({ error: 'Invalid or unknown targetProductId' }, 400);
  }

  try {
    const customerId = await resolvePaynowCustomerId(uuid);
    const token = await createCustomerToken(customerId);
    const result = await previewTierChange(token, body.targetProductId);
    return c.json(result);
  } catch (err) {
    if (err instanceof PaynowApiError) {
      const [body, status] = paynowErrorReply(err);
      return c.json(body, status);
    }
    logger.error({ err, uuid }, 'Tier change preview failed');
    return c.json({ error: 'Failed to preview tier change' }, 500);
  }
});

/**
 * POST /api/store/subscription/change — apply a tier change (upgrade or
 * downgrade) to the caller's active donor subscription, with proration.
 * Pass `verificationCode` when a prior call returned `pending_verification`.
 */
api.post('/store/subscription/change', storeAuth, async (c) => {
  const uuid = c.var.mcUuid!;
  let body: { targetProductId?: string; verificationCode?: string };
  try {
    body = (await c.req.json()) as { targetProductId?: string; verificationCode?: string };
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  if (!body.targetProductId || !isDonorSubscriptionProduct(body.targetProductId)) {
    return c.json({ error: 'Invalid or unknown targetProductId' }, 400);
  }

  try {
    const customerId = await resolvePaynowCustomerId(uuid);
    const token = await createCustomerToken(customerId);
    const result = await applyTierChange(token, body.targetProductId, body.verificationCode);
    return c.json(result);
  } catch (err) {
    if (err instanceof PaynowApiError) {
      const [body, status] = paynowErrorReply(err);
      return c.json(body, status);
    }
    logger.error({ err, uuid }, 'Tier change failed');
    return c.json({ error: 'Failed to change tier' }, 500);
  }
});

/**
 * GET /api/player/lookup?username=... — resolve a username to a UUID (and
 * display name). Used by the gifting flow AND by the auth/me endpoint to
 * auto-resolve a Discord user's MC account when they share the same username.
 *
 * B-28: two tiers, because this used to be a username→UUID oracle open to ANY
 * login (link not required) that also fetched Mojang/PlayerDB for arbitrary
 * names and wrote the results into the shared player_names registry:
 *   - bot/service token: full resolution (registry + Mojang/PlayerDB fallback
 *     + registry cache write) — the trusted server path (auth/me, bot panel).
 *   - session: LINKED sessions only, strict username schema, REGISTRY-ONLY
 *     resolution (no outbound fetch, no registry write), and no-store so the
 *     per-player answer never sits in a shared edge cache. A miss simply 404s
 *     — the enumeration oracle over all of Mojang is gone; what remains is
 *     "has this player joined", the same fact public profiles already expose.
 * The route also has its own 30/min bucket (tighter than the 60/min global —
 * B-28's "tighter per-route limiter").
 */
const lookupRateLimit = rateLimit(30, 60_000, 'player-lookup');
api.get('/player/lookup', lookupRateLimit, async (c) => {
  const isBot = botTokenMatches(c);
  if (!isBot && !c.var.user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  if (!isBot && !c.var.mcUuid) {
    return c.json({ error: 'Minecraft account not linked', linkRequired: true }, 403);
  }
  const username = (c.req.query('username') ?? '').trim();
  if (!username) {
    return c.json({ error: 'Missing username query parameter' }, 400);
  }
  if (!MC_USERNAME_SCHEMA.test(username)) {
    return c.json({ error: 'Invalid username — expected a 3-16 character Minecraft name (Bedrock names may start with a ".")' }, 400);
  }
  const uuid = await getUuidByUsername(username, { external: isBot });
  if (!uuid) {
    return c.json({ error: 'No player found with that username' }, 404, { 'Cache-Control': 'no-store' });
  }
  return c.json({ uuid, username }, 200, { 'Cache-Control': 'no-store' });
});

/**
 * POST /api/store/gift-checkout — create a checkout session for a giftable
 * one-time product, delivered to a *different* player's Minecraft account.
 * The caller pays (redirected to the returned checkout URL); the PayNow
 * customer — and therefore the delivery target — is resolved from the
 * recipient's username, not the caller's own account. See isGiftableProduct()
 * for which products qualify.
 */
api.post('/store/gift-checkout', storeAuth, async (c) => {
  const buyerUuid = c.var.mcUuid!;
  let body: { productId?: string; recipientUsername?: string };
  try {
    body = (await c.req.json()) as { productId?: string; recipientUsername?: string };
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  if (!body.productId || !isGiftableProduct(body.productId)) {
    return c.json({ error: 'Invalid or unknown productId — that product cannot be gifted' }, 400);
  }
  const recipientUsername = (body.recipientUsername ?? '').trim();
  if (!recipientUsername) {
    return c.json({ error: 'Missing recipientUsername' }, 400);
  }
  if (!MC_USERNAME_SCHEMA.test(recipientUsername)) {
    return c.json({ error: 'Invalid recipient username' }, 400);
  }

  const recipientUuid = await getUuidByUsername(recipientUsername, { strictPlatform: true });
  if (!recipientUuid) {
    return c.json({ error: `No player found with username "${recipientUsername}" — they must have joined the server at least once, or be a valid Java Edition account.` }, 404);
  }
  if (recipientUuid === buyerUuid) {
    return c.json({ error: 'Use the normal checkout to buy for yourself' }, 400);
  }

  try {
    const customerId = await resolvePaynowCustomerId(recipientUuid);
    const session = await createCheckoutSession({
      customerId,
      productId: body.productId,
      subscription: false,
      returnUrl: `${frontendUrl()}/dashboard/subscription?gift=success`,
      cancelUrl: `${frontendUrl()}/store?checkout=canceled`,
    });
    return c.json({ url: session.url, recipientUsername });
  } catch (err) {
    if (err instanceof PaynowApiError) {
      logger.warn({ err: err.body, status: err.status, buyerUuid, recipientUuid, recipientUsername, productId: body.productId }, 'PayNow gift checkout creation failed');
      const userFriendly = err.status === 504
        ? 'PayNow did not respond in time. Please try again shortly.'
        : err.status === 400
        ? 'PayNow rejected the checkout request. The product ID may be invalid.'
        : err.status === 401
        ? 'PayNow authentication failed. Please contact an administrator.'
        : err.status === 403
        ? `PayNow refused the gift: ${err.message}`
        : err.status === 404
        ? 'Product or customer not found in PayNow.'
        : `PayNow error (${err.status}). Please try again or contact support.`;
      return c.json({ error: userFriendly }, err.status === 504 ? 504 : 502);
    }
    logger.error({ err: err instanceof Error ? { message: err.message, stack: err.stack } : err, buyerUuid, recipientUuid, recipientUsername, productId: body.productId }, 'Gift checkout creation failed (unexpected)');
    return c.json({ error: 'Failed to create gift checkout session. Please try again or contact support with this info.' }, 500);
  }
});

/**
 * POST /api/store/cart-checkout — create a single PayNow checkout session for
 * multiple line items. Each item can be a subscription, a lifetime purchase, or
 * a gift. Gifts resolve the recipient's UUID (via player_names or Mojang/PlayerDB
 * fallback) and their PayNow customer ID inline so the `gift_to_customer_id`
 * field is set per-line. The buyer (caller) pays for the whole cart in one
 * PayNow transaction.
 */
api.post('/store/cart-checkout', storeAuth, async (c) => {
  const buyerUuid = c.var.mcUuid!;
  let body: { items?: Array<{ productId?: string; quantity?: number; subscription?: boolean; giftRecipient?: string }> };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const items = body.items;
  if (!Array.isArray(items) || items.length === 0) {
    return c.json({ error: 'Cart is empty — add at least one item' }, 400);
  }
  if (items.length > 20) {
    return c.json({ error: 'Cart is limited to 20 items per checkout' }, 400);
  }

  // Validate every line item and build the PayNow lines array.
  const lines: CheckoutLine[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item.productId || typeof item.productId !== 'string') {
      return c.json({ error: `Item ${i + 1}: missing or invalid productId` }, 400);
    }
    const qty = Math.max(1, Math.min(99, Math.floor(item.quantity ?? 1)));
    const isSub = item.subscription === true;

    // Gifts resolve the recipient's PayNow customer; validate before any lookup.
    if (item.giftRecipient) {
      if (!isGiftableProduct(item.productId)) {
        return c.json({ error: `Item ${i + 1}: that product cannot be gifted` }, 400);
      }
      if (!MC_USERNAME_SCHEMA.test(item.giftRecipient.trim())) {
        return c.json({ error: `Item ${i + 1}: invalid gift recipient username` }, 400);
      }
      const recipientUuid = await getUuidByUsername(item.giftRecipient.trim(), { strictPlatform: true });
      if (!recipientUuid) {
        return c.json(
          { error: `Item ${i + 1}: could not find a Minecraft account named "${item.giftRecipient}". Have they joined the server, or is the username spelled correctly?` },
          404,
        );
      }
      if (recipientUuid === buyerUuid) {
        return c.json({ error: `Item ${i + 1}: can't gift to yourself — use the normal checkout` }, 400);
      }
      const giftCustomerId = await resolvePaynowCustomerId(recipientUuid);
      lines.push({ productId: item.productId, quantity: qty, subscription: false, giftToCustomerId: giftCustomerId });
    } else {
      // Self-purchase: validate product type matches the subscription flag.
      if (isSub && !isDonorSubscriptionProduct(item.productId)) {
        return c.json({ error: `Item ${i + 1}: product is not a valid subscription` }, 400);
      }
      // B-C17: one-time lines cover MORE than lifetime donor ranks — the 10
      // Aureus packs and 6 rank upgrades are one-time products too and were
      // previously rejected here with a 400, breaking every currency-pack
      // purchase. Gifts (above) intentionally stay lifetime-rank-only.
      if (!isSub && !isOneTimeStoreProduct(item.productId)) {
        return c.json({ error: `Item ${i + 1}: product is not a valid one-time purchase` }, 400);
      }
      lines.push({ productId: item.productId, quantity: qty, subscription: isSub });
    }
  }

  try {
    const customerId = await resolvePaynowCustomerId(buyerUuid);
    const session = await createCheckoutSession({
      customerId,
      lines,
      returnUrl: `${frontendUrl()}/dashboard?checkout=success`,
      cancelUrl: `${frontendUrl()}/store?checkout=canceled`,
    });
    return c.json({ url: session.url });
  } catch (err) {
    if (err instanceof PaynowApiError) {
      logger.warn({ err: err.body, status: err.status, buyerUuid, lineCount: lines.length }, 'PayNow cart checkout creation failed');
      const [body, status] = paynowErrorReply(err);
      return c.json(body, status);
    }
    logger.error({ err, buyerUuid, lineCount: lines.length }, 'Cart checkout creation failed');
    return c.json({ error: 'Failed to create cart checkout session' }, 500);
  }
});

/* ---------------------------------------------------------- PayNow webhook */

/**
 * POST /api/webhooks/paynow — receives order/subscription/delivery events
 * from PayNow. Signature-verified (HMAC-SHA256 over `timestamp.body`), not
 * cookie/bot-token authenticated. Keeps `paynow_subscriptions` in sync so
 * the dashboard can read current-tier state without calling PayNow live.
 */
api.post('/webhooks/paynow', async (c) => {
  const rawBody = await c.req.text();
  const verification = verifyPaynowWebhook({
    rawBody,
    signatureHeader: c.req.header('PayNow-Signature'),
    timestampHeader: c.req.header('PayNow-Timestamp'),
  });
  if (!verification.valid) {
    logger.warn({ reason: verification.reason }, 'Rejected PayNow webhook');
    return c.json({ error: 'Invalid signature' }, 401);
  }

  let event: { event_type?: string; data?: Record<string, unknown>; body?: Record<string, unknown> };
  try {
    event = JSON.parse(rawBody) as { event_type?: string; data?: Record<string, unknown> };
  } catch {
    return c.json({ error: 'Invalid JSON payload' }, 400);
  }

  const eventType = event.event_type ?? '';
  // PayNow's docs spell the enums ON_ORDER_COMPLETED while earlier deliveries
  // used CamelCase (OnSubscriptionActivated) — normalize once, switch on the
  // canonical token, and stop betting on a single spelling.
  const canonicalEvent = normalizePaynowEventType(eventType);
  // Order payloads arrive under `body` (OrderDTO), subscription deliveries under
  // `data` — accept either so both generations of PayNow webhooks parse.
  const data = ((event.body ?? event.data) ?? {}) as Record<string, unknown>;

  // B-09: cancel-path failures MUST return non-2xx so PayNow retries. A canceled
  // subscription emits no further events — "the next renewal will self-heal it"
  // is false for cancels, and one swallowed failure strands status:'active' in
  // the cache forever. Activation/renewal failures stay 200: those events recur,
  // and a retry storm over a cache write buys nothing.
  let cancelPath = false;
  try {
    switch (canonicalEvent) {
      case 'order_completed': {
        // B-C16/B-C19: deliver the paid order in-game (Aureus packs, ranks,
        // upgrades). Any delivery failure returns 500 so PayNow retries —
        // each line is idempotent, so retries are always safe.
        const result = await fulfillPaynowOrder(data);
        if (result.status === 'error') {
          return c.json({ error: 'Order fulfillment failed', detail: result.error }, 500);
        }
        if (result.status === 'empty_order') {
          // B-59: an order with no lines is a test ping or a malformed
          // OrderDTO. Still 200 — a genuinely-empty test ping must not start
          // a PayNow retry storm over a payload that will never change — but
          // the body is explicitly NOT dispatched-ok and staff are alerted,
          // so a real order whose lines we failed to parse surfaces instead
          // of silently passing as delivered.
          alertError('paynow-empty-order', result.error ?? 'PayNow order with no lines');
          return c.json({ ok: false, flagged: 'empty_order', detail: result.error }, 200);
        }
        break;
      }
      case 'subscription_activated':
      case 'subscription_renewed': {
        const customerId = String(data['customer_id'] ?? (data['customer'] as { id?: string })?.id ?? '');
        const subscriptionId = String(data['id'] ?? '');
        const productId = String(data['product_id'] ?? (data['product'] as { id?: string })?.id ?? '');
        const status = String(data['status'] ?? 'active');
        // B-21: allowlist at INGEST — the cache previously stored any
        // product_id verbatim, so a foreign/test product could later be
        // served as the player's active donor tier. Unknown products are
        // logged (they indicate a PayNow dashboard drift) and not cached.
        if (productId && !isDonorSubscriptionProduct(productId)) {
          logger.warn({ customerId, subscriptionId, productId, eventType }, 'PayNow webhook: product_id outside the donor catalog — subscription NOT cached');
          break;
        }
        // B-C28: resolve through fulfillment's helper so a cache miss falls
        // back to PayNow's Management API and caches the link — a raw
        // paynow_customers lookup strands every customer our cache never had.
        const uuid = customerId ? await resolveCustomerUuid(customerId, null) : null;
        if (uuid && subscriptionId && productId) {
          await upsertCachedSubscription(uuid, subscriptionId, productId, status);
        } else {
          // An unresolvable customer is a PERMANENT gap (not a transient cache
          // miss): the subscription cache silently desyncs from PayNow forever.
          logger.error({ customerId, subscriptionId, eventType }, 'PayNow webhook: customer could not be resolved to a uuid — subscription cache NOT updated');
        }
        break;
      }
      case 'subscription_canceled': {
        cancelPath = true;
        const customerId = String(data['customer_id'] ?? (data['customer'] as { id?: string })?.id ?? '');
        const subscriptionId = String(data['id'] ?? '');
        const productId = String(data['product_id'] ?? (data['product'] as { id?: string })?.id ?? '');
        // B-C28: same fallback as activation/renewal — see that case. Without
        // it a cancel for an uncached customer 500s on every retry forever
        // (PayNow re-delivers, we re-miss, nothing ever converges).
        const uuid = customerId ? await resolveCustomerUuid(customerId, null) : null;
        if (uuid && subscriptionId && productId) {
          await upsertCachedSubscription(uuid, subscriptionId, productId, 'canceled');
        } else {
          logger.error({ customerId, subscriptionId, eventType }, 'PayNow webhook cancel: customer could not be resolved to a uuid — subscription cache NOT updated');
          // 500, not 200: a retry is the only way this cache row ever gets
          // written (B-09).
          return c.json({ error: 'cancel: customer could not be resolved to a uuid' }, 500);
        }
        cancelPath = false;
        break;
      }
      case 'refund':
      case 'chargeback': {
        // Revoke what we delivered (plugin PurchaseRefundService). Failures
        // 500 so PayNow retries; the plugin's refund claim makes that safe.
        const result = await refundPaynowOrder(data, canonicalEvent);
        if (result.status === 'error') {
          alertError('paynow-refund-failed', result.error ?? 'PayNow refund revocation failed');
          return c.json({ error: 'Refund revocation failed', detail: result.error }, 500);
        }
        if (result.status === 'not_delivered') {
          alertError('paynow-refund-not-delivered', result.error ?? 'PayNow refund for an undelivered order');
          return c.json({ ok: false, flagged: 'refund_not_delivered', detail: result.error }, 200);
        }
        break;
      }
      case 'unknown':
      default:
        break;
    }
  } catch (err) {
    if (cancelPath) {
      // B-09: the canceled write never landed and no future event will fix it.
      // The upsert is idempotent, so PayNow's retries are safe.
      logger.error({ err, eventType }, 'PayNow webhook CANCEL processing failed — returning 500 so PayNow retries');
      return c.json({ error: 'cancel processing failed' }, 500);
    }
    // Log but still 200 — PayNow retries on non-2xx, and a cache-write failure
    // isn't worth a retry storm; the next renewal event will self-heal it.
    logger.error({ err, eventType }, 'Failed to process PayNow webhook');
  }

  return c.json({ ok: true });
});

/* --------------------------------------------------------------- Actions */

/** POST /api/action/sellall — dispatch a sellall command via the Redis bus. */
api.post(
  '/action/sellall',
  requireAuth,
  requireLinked,
  async (c) => {
    const user = c.var.user!;
    const uuid = c.var.mcUuid!;

    try {
      const response = await sendCommandWithResponse(
        'DISPATCH_ACTION',
        {
          action: 'sellall',
          uuid,
          discordId: user.discordId,
        },
        5_000,
      );

      if (!response.ok) {
        return c.json(
          { error: response.error ?? 'Plugin rejected the action' },
          502,
        );
      }
      return c.json({ ok: true, result: response.data ?? null });
    } catch (err) {
      logger.error({ err }, 'sellall dispatch failed');
      return c.json({ error: 'Plugin did not respond in time' }, 504);
    }
  },
);

/* ---------------------------------------------------------- Support tickets */

/**
 * POST /api/tickets — submit a support ticket. Requires a linked session.
 */
api.post('/tickets', requireMcIdentity, async (c) => {
  const mcUuid = c.var.mcUuid!;

  let body: { category?: string; subject?: string; body?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }

  const category = (body.category ?? '').trim().slice(0, 50);
  const subject = (body.subject ?? '').trim().slice(0, 200);
  const text = (body.body ?? '').trim().slice(0, 5000);
  if (!subject || !text) return c.json({ error: 'Subject and body are required' }, 400);

  // Resolve username
  const nameRow = await query<{ username: string }>('SELECT username FROM player_names WHERE uuid = $1', [mcUuid]);
  const username = nameRow.rows[0]?.username ?? 'Unknown';

  const result = await query<{ id: string }>(
    `INSERT INTO support_tickets (uuid, username, category, subject, body) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [mcUuid, username, category || 'general', subject, text],
  );
  return c.json({ ok: true, id: result.rows[0].id });
});

/**
 * GET /api/tickets — list tickets. Staff (helper+, via the staff gate —
 * X-Staff-Role on an authenticated request, a staff session, or per-staff
 * tokens) see ALL tickets with pagination; non-staff callers see only their
 * own (B-12: the old code presence-checked X-Mc-Uuid and then selected
 * unfiltered, leaking every ticket to any player).
 */
const TICKET_STATUSES = new Set(['open', 'responded', 'pending', 'closed', 'stale']);

api.get('/tickets', async (c) => {
  if (!adminAuthOk(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const staffActor = await resolveStaffActor(c);
  const isStaff = staffActorHasRole(staffActor, 'helper');
  let scopeUuid: string | null = null;
  if (!isStaff) {
    // Non-staff self-scope: the session's linked uuid, else the delegated
    // proxy's asserted uuid (shape-validated — B-06). No identity at all →
    // refuse (never dump all).
    scopeUuid = c.var.mcUuid ?? parseMcUuid(c.req.header('x-mc-uuid'));
    if (!scopeUuid) {
      return c.json({ error: 'Staff role helper or above required to list all tickets' }, 403);
    }
  }

  const page = pageParam(c.req.query('page'));
  const limit = limitParam(c.req.query('limit'), 20, 50);
  const offset = (page - 1) * limit;
  const statusFilter = c.req.query('status');
  if (statusFilter && !TICKET_STATUSES.has(statusFilter)) {
    return c.json({ error: 'Invalid status', allowed: [...TICKET_STATUSES] }, 400);
  }

  const conds: string[] = [];
  const params: unknown[] = [];
  if (statusFilter) {
    params.push(statusFilter);
    conds.push(`status = $${params.length}`);
  }
  if (scopeUuid) {
    params.push(scopeUuid);
    conds.push(`uuid = $${params.length}`);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ``;

  const result = await query(
    `SELECT id, uuid, username, category, subject, status, priority, staff_response, responded_at, created_at
     FROM support_tickets ${where}
     ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END, created_at DESC
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  );
  const totalRow = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM support_tickets ${where}`,
    params,
  );
  return c.json({ tickets: result.rows, total: parseInt(totalRow.rows[0].count, 10), page, limit });
});

/**
 * GET /api/tickets/mine — list only the calling player's own tickets.
 */
api.get('/tickets/mine', requireMcIdentity, async (c) => {
  const mcUuid = c.var.mcUuid!;
  const result = await query(
    `SELECT id, category, subject, status, staff_response, responded_at, created_at
     FROM support_tickets WHERE uuid = $1 ORDER BY created_at DESC LIMIT 50`,
    [mcUuid],
  );
  return c.json({ tickets: result.rows });
});

/**
 * POST /api/tickets/:id/respond — staff responds to a ticket.
 * B-12: staff-only (mod+ via the real staff gate — the old code let ANY
 * caller write staff_response/responded_by/status with a free-form status
 * value). responded_by carries the attributed staff actor (X-03: the
 * LuckPerms-verified human when the panel forwards it), and the status is
 * allowlisted so the 48h auto-close sweep only ever sees real states.
 */
api.post('/tickets/:id/respond', async (c) => {
  if (!adminAuthOk(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const staffActor = await resolveStaffActor(c);
  if (!staffActorHasRole(staffActor, 'mod')) {
    logger.warn({ actor: staffActor.name, role: staffActor.role }, 'AUDIT: ticket respond refused — role below mod');
    return c.json({ error: 'Staff role mod or above required to respond to tickets' }, 403);
  }
  const ticketId = c.req.param('id');
  let body: { response?: string; status?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const response = (body.response ?? '').trim().slice(0, 5000);
  const newStatus = (body.status ?? 'responded').trim();
  if (!response) return c.json({ error: 'Response text is required' }, 400);
  if (!TICKET_STATUSES.has(newStatus)) {
    return c.json({ error: 'Invalid status', allowed: [...TICKET_STATUSES] }, 400);
  }

  const updated = await query<{ id: string }>(
    `UPDATE support_tickets SET staff_response = $1, responded_by = $2, responded_at = CURRENT_TIMESTAMP, status = $3 WHERE id = $4 RETURNING id`,
    [response, staffActor.name, newStatus, ticketId],
  );
  if (updated.rows.length === 0) {
    return c.json({ error: 'Ticket not found' }, 404);
  }
  return c.json({ ok: true });
});

/* ---------------------------------------------------------- Crate keys */

/**
 * GET /api/player/crates — the calling player's crate key counts per type
 * (classic crates + store product lines) and their recent real openings.
 */
api.get('/player/crates', readRateLimit, requireMcIdentity, async (c) => {
  const mcUuid = c.var.mcUuid!;
  // Game MySQL first — it holds BOTH key stores (player_crate_keys for the
  // classic crates, crate_line_keys for the store product lines) plus the
  // real opening history (crate_open_log). The Postgres mirror only carries
  // the classic table, so it stays as the fallback for key counts.
  try {
    const [keys, openings] = await Promise.all([
      getGameCrateKeys(mcUuid),
      getGameCrateOpenings(mcUuid, 25),
    ]);
    return c.json({
      keys,
      recentOpens: openings.map((r) => ({
        crate: String(r.crate_id ?? ''),
        reward: String(r.reward_display ?? ''),
        at: r.opened_at instanceof Date ? r.opened_at.toISOString() : String(r.opened_at ?? ''),
      })),
    });
  } catch (err) {
    logger.warn({ err: String(err) }, '[player/crates] game MySQL failed — falling back to Postgres');
  }
  const result = await query<{ crate_type: string; key_count: string }>(
    'SELECT crate_type, key_count FROM player_crate_keys WHERE uuid = $1 AND key_count > 0',
    [mcUuid],
  );
  const keys: Record<string, number> = {};
  for (const row of result.rows) {
    keys[row.crate_type] = parseInt(row.key_count, 10);
  }
  return c.json({ keys, recentOpens: [] });
});

/* ── Web crate opening (owner directive 2026-09-14): only crates with a
 * physical stand, only while the player is online — the plugin runs the SAME
 * single-open pipeline as /crate open (pity, rank scaling, daily limits). */
api.get('/player/crates/placed', readRateLimit, requireMcIdentity, async (c) => {
  try {
    const response = await sendCommandWithResponse('GET_PLACED_CRATES', {}, 8_000);
    if (response.status === 'OK') {
      return c.json((response.data ?? { placed: [] }) as Record<string, unknown>, 200, { 'Cache-Control': 'no-store' });
    }
    return c.json({ placed: [], error: response.error ?? 'Plugin refused' }, 502);
  } catch (err) {
    logger.warn({ err: String(err) }, '[player/crates/placed] dispatch failed');
    return c.json({ placed: [], error: 'Game server did not respond' }, 501);
  }
});

/** POST /api/player/crates/open — { crate }: one real open. Returns the actual
 *  reward won. Refusals (offline, no key, not placed) are explicit strings the
 *  UI shows verbatim. */
api.post('/player/crates/open', rateLimit(10, 60_000, 'crate-open'), requireMcIdentity, async (c) => {
  const mcUuid = c.var.mcUuid!;
  let body: { crate?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
  const crate = (body.crate ?? '').slice(0, 64);
  if (!crate) return c.json({ error: 'Missing crate' }, 400);
  // Preferred display name for offline opens (the plugin prefers this over a potentially
  // blocking Bukkit profile lookup). Best-effort: omitting it just falls back plugin-side.
  let playerName = '';
  try {
    const nameRow = await query<{ username: string }>(
      'SELECT username FROM player_names WHERE uuid = $1 ORDER BY updated_at DESC LIMIT 1',
      [mcUuid],
    );
    playerName = nameRow.rows[0]?.username ?? '';
  } catch {
    // Names table unavailable — the plugin falls back to its own caches.
  }
  try {
    const response = await sendCommandWithResponse(
      'CRATE_OPEN_WEB',
      { uuid: mcUuid, crate, ...(playerName ? { name: playerName.slice(0, 64) } : {}) },
      15_000,
    );
    if (response.status === 'OK') {
      return c.json((response.data ?? {}) as Record<string, unknown>);
    }
    const reason = (response.data as { reason?: string } | undefined)?.reason ?? response.error ?? 'open refused';
    return c.json({ error: reason }, 409);
  } catch (err) {
    logger.warn({ err: String(err) }, '[player/crates/open] dispatch failed');
    return c.json({ error: 'Game server did not respond' }, 501);
  }
});

/* ── Tags (dashboard wardrobe) — owned/active ids come from the game's
 * TagsService over the bus (tags live in a flat YAML, not SQL). */
api.get('/player/tags', readRateLimit, requireMcIdentity, async (c) => {
  const mcUuid = c.var.mcUuid!;
  try {
    const response = await sendCommandWithResponse('GET_TAGS_STATUS', { uuid: mcUuid }, 8_000);
    if (response.status === 'OK') {
      return c.json((response.data ?? {}) as Record<string, unknown>, 200, { 'Cache-Control': 'no-store' });
    }
    return c.json({ error: response.error ?? 'Plugin refused the tags read' }, 502);
  } catch (err) {
    logger.warn({ err: String(err) }, '[player/tags] dispatch failed');
    return c.json({ error: 'Game server did not respond' }, 501);
  }
});

/** POST /api/player/tags/equip — { tag: id } ("" to unequip). Works OFFLINE as well
 *  (forward-plan 2026-09-18 #2): the plugin's active-tag slot is UUID-keyed persisted
 *  state, so it equips by UUID and reports honesty flags — data: { applied, pending,
 *  active }. applied=true means the live player re-equips now; applied=false +
 *  pending=true means the choice is persisted and renders in chat from the player's
 *  next line after joining. The plugin refuses tags the player does not own. */
api.post('/player/tags/equip', writeRateLimit, requireMcIdentity, async (c) => {
  const mcUuid = c.var.mcUuid!;
  let body: { tag?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
  const tag = (body.tag ?? '').slice(0, 64);
  try {
    const response = await sendCommandWithResponse('TAG_SET_ACTIVE', { uuid: mcUuid, tag }, 8_000);
    if (response.status === 'OK') {
      return c.json((response.data ?? {}) as Record<string, unknown>);
    }
    return c.json({ error: response.error ?? 'Equip refused' }, 409);
  } catch (err) {
    logger.warn({ err: String(err) }, '[player/tags/equip] dispatch failed');
    return c.json({ error: 'Game server did not respond' }, 501);
  }
});

/* ── Data rights (privacy) — the dashboard drives the plugin's /privacy pipeline
 * over the Redis bus. Identity always comes from the resolved principal
 * (c.var.mcUuid): a session reads its own account, the site proxy asserts the
 * linked uuid under the service token. The full-record export and the staged
 * download file live in the game MySQL privacy_export_files table. */

api.get('/player/privacy', readRateLimit, requireMcIdentity, async (c) => {
  const mcUuid = c.var.mcUuid!;
  try {
    const response = await sendCommandWithResponse('PRIVACY_STATUS', { uuid: mcUuid }, 8_000);
    if (response.status === 'OK') {
      return c.json((response.data ?? {}) as Record<string, unknown>, 200, { 'Cache-Control': 'no-store' });
    }
    return c.json({ error: response.error ?? 'Plugin refused the status request' }, 502);
  } catch (err) {
    logger.warn({ err: String(err) }, '[player/privacy] status dispatch failed');
    return c.json({ error: 'Game server did not respond' }, 501);
  }
});

/** POST /api/player/privacy/export — run the full-record export (rate-limited
 *  in-game to one per exportRateDays). Stages a downloadable JSON. */
api.post('/player/privacy/export', rateLimit(3, 60_000, 'privacy-export'), requireMcIdentity, async (c) => {
  const mcUuid = c.var.mcUuid!;
  const username = c.req.query('username') ?? c.req.header('X-Mc-Name') ?? mcUuid;
  try {
    // The export reads every player table — allow it time.
    const response = await sendCommandWithResponse('PRIVACY_EXPORT', { uuid: mcUuid, name: username }, 90_000);
    if (response.status === 'OK') {
      return c.json((response.data ?? {}) as Record<string, unknown>);
    }
    return c.json({ error: response.error ?? 'Export refused' }, 409);
  } catch (err) {
    logger.warn({ err: String(err) }, '[player/privacy/export] dispatch failed');
    return c.json({ error: 'Game server did not respond — try again shortly' }, 501);
  }
});

/** GET /api/player/privacy/export/download — serve the latest unexpired staged
 *  export as a file download. 404 until one exists. */
api.get('/player/privacy/export/download', readRateLimit, requireMcIdentity, async (c) => {
  const mcUuid = c.var.mcUuid!;
  try {
    const staged = await getGamePrivacyExport(mcUuid);
    if (!staged) return c.json({ error: 'No export available — request one first' }, 404);
    let body = staged.data;
    // COMPLETENESS LAYER: the plugin's export covers the game MySQL only. The
    // backend's own Postgres records for this player are merged into the
    // download so the file truly holds every record we keep (blueprint 07-01
    // "all records" + GDPR portability). Failures degrade to a note, never a
    // broken download.
    try {
      const pg = {} as Record<string, unknown>;
      pg.discord_link = (
        await playerQuery<Record<string, unknown>>(mcUuid, 'SELECT discord_id, created_at FROM discord_links WHERE uuid = $1', [mcUuid])
      ).rows[0] ?? null;
      pg.dashboard_preferences = (
        await playerQuery<Record<string, unknown>>(mcUuid, 'SELECT preferences, updated_at FROM web_dashboard_prefs WHERE uuid = $1', [mcUuid])
      ).rows[0] ?? null;
      pg.support_tickets = (
        await playerQuery<Record<string, unknown>>(mcUuid, 'SELECT id, subject, status, created_at FROM support_tickets WHERE uuid = $1 ORDER BY id DESC LIMIT 100', [mcUuid])
      ).rows;
      pg.web_events = (
        await playerQuery<Record<string, unknown>>(mcUuid, 'SELECT * FROM web_events WHERE uuid = $1 ORDER BY id DESC LIMIT 500', [mcUuid])
      ).rows;
      const parsed = JSON.parse(body) as Record<string, unknown>;
      parsed._postgres_layer = { note: 'records held by the web backend (Supabase Postgres), merged at download time', ...pg };
      body = JSON.stringify(parsed);
    } catch (err) {
      logger.warn({ err: String(err) }, '[privacy/download] Postgres merge degraded — serving game-DB export as-is');
    }
    return c.body(body, 200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="romanica-data-export-${mcUuid.slice(0, 8)}-${staged.date}.json"`,
      'Cache-Control': 'no-store',
    });
  } catch (err) {
    logger.warn({ err: String(err) }, '[player/privacy/export/download] read failed');
    return c.json({ error: 'Export store unavailable' }, 503);
  }
});

/** POST /api/player/privacy/delete — schedule erasure after the cooling
 *  window. The UI runs a multi-step confirmation before this call; the body
 *  must still carry the literal typed confirmation to be accepted here. */
api.post('/player/privacy/delete', rateLimit(3, 60_000, 'privacy-delete'), requireMcIdentity, async (c) => {
  const mcUuid = c.var.mcUuid!;
  let body: { confirm?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
  if (body.confirm !== 'DELETE') {
    return c.json({ error: 'Typed confirmation required' }, 400);
  }
  try {
    const response = await sendCommandWithResponse('PRIVACY_ERASURE_REQUEST', { uuid: mcUuid }, 8_000);
    if (response.status === 'OK') {
      return c.json((response.data ?? {}) as Record<string, unknown>);
    }
    return c.json({ error: response.error ?? 'Erasure request refused' }, 502);
  } catch (err) {
    logger.warn({ err: String(err) }, '[player/privacy/delete] dispatch failed');
    return c.json({ error: 'Game server did not respond' }, 501);
  }
});

/** POST /api/player/privacy/delete/cancel — cancel a pending erasure inside
 *  the cooling window. */
api.post('/player/privacy/delete/cancel', rateLimit(5, 60_000, 'privacy-delete-cancel'), requireMcIdentity, async (c) => {
  const mcUuid = c.var.mcUuid!;
  try {
    const response = await sendCommandWithResponse('PRIVACY_ERASURE_CANCEL', { uuid: mcUuid }, 8_000);
    if (response.status === 'OK') {
      return c.json((response.data ?? {}) as Record<string, unknown>);
    }
    return c.json({ error: response.error ?? 'Cancel refused' }, 502);
  } catch (err) {
    logger.warn({ err: String(err) }, '[player/privacy/delete/cancel] dispatch failed');
    return c.json({ error: 'Game server did not respond' }, 501);
  }
});

/* ---------------------------------------------------------- Vote + daily reward streaks */

/**
 * GET /api/player/rewards — the caller's vote streak (player_votes) and
 * daily-reward streak (daily_rewards), straight from the game database.
 * Powers the dashboard home cards; read-only.
 */
api.get('/player/rewards', readRateLimit, requireMcIdentity, async (c) => {
  const mcUuid = c.var.mcUuid!;
  try {
    const rewards = await getGamePlayerRewards(mcUuid);
    return c.json(rewards);
  } catch (err) {
    logger.warn({ err: String(err) }, '[player/rewards] game MySQL failed');
    return c.json({ votes: null, daily: null });
  }
});

/* ---------------------------------------------------------- Dashboard preferences */

/**
 * Dashboard preferences (settings page): notification toggles, accessibility
 * flags, language. Persisted per MC account in Postgres — before this the
 * frontend proxy intentionally faked success (`persisted: false`) because no
 * backend surface existed, so every "Save" silently reverted on reload.
 *
 * Lazy CREATE TABLE IF NOT EXISTS matches the gallery/dms/apiKeys pattern
 * (idempotent, one-time) — no out-of-band migration needed.
 */
const PREFERENCES_MAX_JSON_BYTES = 8 * 1024;

let preferencesTableReady: Promise<void> | null = null;
function ensurePreferencesTable(): Promise<void> {
  preferencesTableReady ??= (async () => {
    await query(
      `CREATE TABLE IF NOT EXISTS web_dashboard_prefs (
         uuid TEXT PRIMARY KEY,
         preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
      [],
    );
  })().catch((err) => {
    preferencesTableReady = null; // retry on the next request
    throw err;
  });
  return preferencesTableReady;
}

/** POST /api/player/preferences — { uuid, preferences } from the site proxy. */
api.post('/player/preferences', async (c) => {
  if (!botTokenMatches(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  let body: { uuid?: unknown; preferences?: unknown };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const uuid = parseMcUuid(typeof body.uuid === 'string' ? body.uuid : '');
  if (!uuid) return c.json({ error: 'Invalid uuid' }, 400);

  // Shape guard: preferences must be a small flat-ish JSON object. The settings
  // page sends { notifications: {...}, accessibility: {...}, language: "en" } —
  // allow one nesting level of booleans/strings, cap the serialized size.
  const prefs = body.preferences;
  if (prefs === null || prefs === undefined) {
    return c.json({ success: true, persisted: false });
  }
  if (typeof prefs !== 'object' || Array.isArray(prefs)) {
    return c.json({ error: 'preferences must be an object' }, 400);
  }
  const serialized = JSON.stringify(prefs);
  if (serialized.length > PREFERENCES_MAX_JSON_BYTES) {
    return c.json({ error: 'preferences too large' }, 413);
  }
  for (const [k, v] of Object.entries(prefs as Record<string, unknown>)) {
    if (k.length > 64) return c.json({ error: 'Invalid preferences key' }, 400);
    if (v !== null && typeof v === 'object') {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        if (k2.length > 64 || !(typeof v2 === 'boolean' || typeof v2 === 'string' || typeof v2 === 'number')) {
          return c.json({ error: 'Invalid preferences value' }, 400);
        }
      }
    } else if (!(typeof v === 'boolean' || typeof v === 'string' || typeof v === 'number')) {
      return c.json({ error: 'Invalid preferences value' }, 400);
    }
  }

  await ensurePreferencesTable();
  await playerQuery(uuid,
    `INSERT INTO web_dashboard_prefs (uuid, preferences, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (uuid) DO UPDATE SET preferences = $2::jsonb, updated_at = now()`,
    [uuid, serialized],
  );
  return c.json({ success: true, persisted: true });
});

/** GET /api/player/preferences?uuid= — the stored preferences ({} when absent). */
api.get('/player/preferences', async (c) => {
  if (!botTokenMatches(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const uuid = parseMcUuid(c.req.query('uuid') ?? '');
  if (!uuid) return c.json({ error: 'Invalid uuid' }, 400);
  await ensurePreferencesTable();
  const result = await query<{ preferences: unknown }>(
    'SELECT preferences FROM web_dashboard_prefs WHERE uuid = $1',
    [uuid],
  );
  return c.json({ preferences: result.rows[0]?.preferences ?? {} });
});

/* ---------------------------------------------------------- Referrals */

/**
 * POST /api/referrals/create — referrer creates a referral for a referred player.
 * The referral is pending until the referred player reaches rank V (in-game).
 */
api.post('/referrals/create', requireMcIdentity, async (c) => {
  const referrerUuid = c.var.mcUuid!;

  let body: { referredUsername?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }

  const referredUsername = (body.referredUsername ?? '').trim();
  if (!referredUsername) return c.json({ error: 'Missing referredUsername' }, 400);
  if (!MC_USERNAME_SCHEMA.test(referredUsername)) {
    return c.json({ error: 'Invalid referredUsername — expected a 3-16 character Minecraft name' }, 400);
  }

  // B-28/B-30: registry-only — a referred player must have JOINED the server.
  // (The old external fallback let referrers register arbitrary Mojang names
  // that never played; the reward requires an in-game rank-up anyway.)
  const referredUuid = await getUuidByUsername(referredUsername, { external: false });
  if (!referredUuid) {
    return c.json({ error: 'Could not find a player with that username. They must have joined the server at least once.' }, 404);
  }
  if (referredUuid === referrerUuid) {
    return c.json({ error: 'You cannot refer yourself.' }, 400);
  }

  // B-30 ELIGIBILITY — the comment promised this check since the route was
  // written; the code went straight to INSERT. Source of truth is the
  // plugin's ReferralCompletionListener: a referral completes at exactly
  // rank_level 5 (Rank V, REQUIRED_RANK = 5) and pays both players 50K
  // Denarius + 5K Auctoritas. A referred player ALREADY at/above rank V can
  // never fire that RankUpEvent again — referring them is pure reward
  // farming. Game MySQL live first, Postgres mirror fallback; if neither DB
  // can answer we REFUSE (503) rather than guess the player past the gate.
  let rankLevel: number | null = null;
  let rankDegraded = false;
  try {
    const rp = await getGamePlayerRankAndPrestige(referredUuid);
    rankLevel = rp.rank_level;
  } catch (err) {
    logger.warn({ err: String(err) }, '[referrals] game MySQL failed — Postgres rank fallback');
    try {
      const r = await query<{ rank_level: string }>(
        'SELECT rank_level FROM player_ranks WHERE uuid = $1',
        [referredUuid],
      );
      rankLevel = r.rows.length > 0 ? Number(r.rows[0].rank_level) : 0;
    } catch (pgErr) {
      logger.error({ err: String(pgErr) }, '[referrals] Postgres rank read failed too — refusing creation');
      rankDegraded = true;
    }
  }
  if (rankDegraded) {
    return c.json({ error: 'Cannot verify the referred player\'s rank right now. Please try again shortly.' }, 503);
  }
  if ((rankLevel ?? 0) >= 5) {
    return c.json({ error: `${referredUsername} is already at or above Rank V — referrals are for new players.` }, 409);
  }

  // Check if this player was already referred by someone else (friendly
  // pre-check; the guarded INSERT below is the authoritative race guard).
  const existing = await query<{ referrer_uuid: string }>(
    'SELECT referrer_uuid FROM referrals WHERE referred_uuid = $1', [referredUuid]
  );
  if (existing.rows.length > 0) {
    return c.json({ error: `${referredUsername} has already been referred by another player.` }, 409);
  }

  // B-30 race guard: two referrers used to pass the SELECT above concurrently
  // and both INSERT (the schema only backed UNIQUE(referrer, referred)).
  // ON CONFLICT DO NOTHING + RETURNING makes the insert compare-and-insert;
  // the new partial UNIQUE index on referred_uuid (migrate-tables.cjs) makes
  // one-referral-per-referred-player structural. Zero returned rows → 409.
  try {
    const inserted = await query<{ id: string }>(
      `INSERT INTO referrals (referrer_uuid, referred_uuid, referred_username, status)
       VALUES ($1, $2, $3, 'pending')
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [referrerUuid, referredUuid, referredUsername],
    );
    if (inserted.rows.length === 0) {
      return c.json({ error: `${referredUsername} has already been referred by another player.` }, 409);
    }
    return c.json({ ok: true, message: `Referral created. When ${referredUsername} reaches Rank V, you both get a reward!` });
  } catch (err) {
    logger.error({ err: String(err), referrerUuid }, 'referral create failed');
    return c.json({ error: 'Failed to create referral.' }, 500);
  }
});

/**
 * GET /api/referrals/mine — the calling player's referrals (as referrer).
 */
api.get('/referrals/mine', requireMcIdentity, async (c) => {
  const mcUuid = c.var.mcUuid!;

  const result = await query(
    `SELECT id, referred_username, status, referrer_rewarded, referred_rewarded, created_at, completed_at
     FROM referrals WHERE referrer_uuid = $1 ORDER BY created_at DESC LIMIT 50`,
    [mcUuid],
  );
  const stats = await query<{ total: string; completed: string; pending: string }>(
    `SELECT COUNT(*) as total,
       COUNT(*) FILTER (WHERE status = 'completed') as completed,
       COUNT(*) FILTER (WHERE status = 'pending') as pending
     FROM referrals WHERE referrer_uuid = $1`,
    [mcUuid],
  );
  return c.json({
    referrals: result.rows,
    stats: {
      total: parseInt(stats.rows[0]?.total ?? '0', 10),
      completed: parseInt(stats.rows[0]?.completed ?? '0', 10),
      pending: parseInt(stats.rows[0]?.pending ?? '0', 10),
    },
  });
});

/* ---------------------------------------------------------- Marketplace */

/**
 * GET /api/marketplace/listings — browse active marketplace listings.
 * Supports category filter, sorting, and pagination.
 */
api.get('/marketplace/listings', botAuthMiddleware, async (c) => {
  const page = pageParam(c.req.query('page'));
  const limit = limitParam(c.req.query('limit'), 20, 50);
  const offset = (page - 1) * limit;
  const category = c.req.query('category');
  const sort = c.req.query('sort') ?? 'recent';

  const orderBy = sort === 'price_low' ? 'price_each ASC' :
    sort === 'price_high' ? 'price_each DESC' : 'created_at DESC';

  const where = category ? `WHERE expires_at > CURRENT_TIMESTAMP AND category = $3` : `WHERE expires_at > CURRENT_TIMESTAMP`;
  const params = category ? [limit, offset, category] : [limit, offset];

  const result = await query(
    `SELECT l.id, l.seller_uuid, l.item_nbt, l.quantity, l.price_each, l.category, l.created_at,
       p.username AS seller_name
     FROM marketplace_listings l
     LEFT JOIN player_names p ON l.seller_uuid = p.uuid
     ${where}
     ORDER BY ${orderBy}
     LIMIT $1 OFFSET $2`,
    params,
  );
  const totalRow = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM marketplace_listings ${category ? 'WHERE expires_at > CURRENT_TIMESTAMP AND category = $1' : 'WHERE expires_at > CURRENT_TIMESTAMP'}`,
    category ? [category] : [],
  );
  return c.json({ listings: result.rows, total: parseInt(totalRow.rows[0]?.count ?? '0', 10), page, limit });
});

/**
 * GET /api/marketplace/mine — the calling player's own listings.
 */
api.get('/marketplace/mine', requireMcIdentity, async (c) => {
  const mcUuid = c.var.mcUuid!;
  const result = await query(
    `SELECT id, item_nbt, quantity, price_each, category, expires_at, created_at
     FROM marketplace_listings WHERE seller_uuid = $1 ORDER BY created_at DESC LIMIT 50`,
    [mcUuid],
  );
  return c.json({ listings: result.rows });
});

/* ---------------------------------------------------------- Legion Management */

/**
 * POST /api/legion/create — create a new legion (in-game command dispatch).
 * B-27: the command verb is a fixed literal; the single argument must match
 * the shared LEGION_NAME_SCHEMA (the plugin's own gate) so no extra tokens
 * can ride the dispatch. Length-only checks let 'IX Legio leave' through.
 */
api.post('/legion/create', requireMcIdentity, async (c) => {
  const uuid = c.var.mcUuid!;
  let body: { name?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const name = (body.name ?? '').trim();
  if (!LEGION_NAME_SCHEMA.test(name)) {
    return c.json({ error: 'Legion name must be 3-16 characters: letters, numbers, and underscores only' }, 400);
  }
  try {
    const response = await sendCommandWithResponse('DISPATCH_COMMAND', {
      command: `legion create ${name}`,
      uuid,
    }, 5_000);
    return c.json({ ok: response.ok, error: response.error }, response.ok ? 200 : 502);
  } catch (err) {
    logger.error({ err: String(err) }, 'legion dispatch: plugin did not respond');
    return c.json({ error: 'Plugin did not respond' }, 504);
  }
});

/**
 * POST /api/legion/leave — leave current legion.
 */
api.post('/legion/leave', requireMcIdentity, async (c) => {
  const uuid = c.var.mcUuid!;
  try {
    const response = await sendCommandWithResponse('DISPATCH_COMMAND', {
      command: 'legion leave',
      uuid,
    }, 5_000);
    return c.json({ ok: response.ok, error: response.error }, response.ok ? 200 : 502);
  } catch { return c.json({ error: 'Plugin did not respond' }, 504); }
});

/**
 * POST /api/legion/invite — invite a player to your legion.
 */
api.post('/legion/invite', requireMcIdentity, async (c) => {
  const uuid = c.var.mcUuid!;
  let body: { username?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  const username = (body.username ?? '').trim();
  if (!MC_USERNAME_SCHEMA.test(username)) {
    return c.json({ error: 'Invalid username — expected a 3-16 character Minecraft name (Bedrock names may start with a ".")' }, 400);
  }
  try {
    const response = await sendCommandWithResponse('DISPATCH_COMMAND', {
      command: `legion invite ${username}`,
      uuid,
    }, 5_000);
    return c.json({ ok: response.ok, error: response.error }, response.ok ? 200 : 502);
  } catch { return c.json({ error: 'Plugin did not respond' }, 504); }
});

/* ---------------------------------------------------------- Referral Codes */

/**
 * GET /api/refcode/mine — get the caller's referral code (generates one if none exists).
 */
api.get('/refcode/mine', requireMcIdentity, async (c) => {
  const mcUuid = c.var.mcUuid!;

  // Check if player already has a code
  const existing = await query<{ code: string; is_custom: boolean; total_redemptions: string }>(
    'SELECT code, is_custom, total_redemptions FROM referral_codes WHERE uuid = $1', [mcUuid]
  );
  if (existing.rows.length > 0) {
    return c.json({ code: existing.rows[0].code, isCustom: existing.rows[0].is_custom, redemptions: parseInt(existing.rows[0].total_redemptions, 10) });
  }

  // B-31: codes come from crypto.randomBytes over the unambiguous alphabet
  // (Math.random is the predictable-PRNG class the repo already replaced in
  // generateLinkCode), and the insert is compare-and-insert: ON CONFLICT DO
  // NOTHING + RETURNING — a swallowed collision used to return the OTHER
  // player's code as the caller's own (two owners, redemptions attributed to
  // the wrong row). Zero returned rows = collision → regenerate and retry;
  // a genuinely thrown error is surfaced, not eaten by the loop.
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const generateCode = (): string => {
    const bytes = randomBytes(6);
    let code = '';
    for (let i = 0; i < 6; i++) code += chars[bytes[i]! % chars.length];
    return code;
  };
  const MAX_ATTEMPTS = 10;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = generateCode();
    const inserted = await query<{ code: string }>(
      'INSERT INTO referral_codes (uuid, code) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING code',
      [mcUuid, code]
    );
    if (inserted.rows.length > 0) {
      return c.json({ code: inserted.rows[0].code, isCustom: false, redemptions: 0 });
    }
    logger.warn({ attempt, code }, 'refcode collision — code already taken, regenerating');
  }
  logger.error({ mcUuid }, `refcode generation exhausted ${MAX_ATTEMPTS} attempts`);
  return c.json({ error: 'Failed to generate code' }, 500);
});

/**
 * POST /api/refcode/custom — Patrician+ sets a custom 6-char code.
 * 30-day cooldown between changes.
 */
api.post('/refcode/custom', requireMcIdentity, async (c) => {
  const mcUuid = c.var.mcUuid!;

  let body: { code?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }

  const code = (body.code ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) {
    return c.json({ error: 'Code must be exactly 6 alphanumeric characters.' }, 400);
  }

  // Check cooldown
  const existing = await query<{ code: string; last_changed_at: Date; is_custom: boolean }>(
    'SELECT code, last_changed_at, is_custom FROM referral_codes WHERE uuid = $1', [mcUuid]
  );
  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    if (row.is_custom) {
      const daysSince = (Date.now() - new Date(row.last_changed_at).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince < 30) {
        return c.json({ error: `You can change your custom code again in ${Math.ceil(30 - daysSince)} days.` }, 400);
      }
    }
  }

  // Check code isn't taken by someone else
  const taken = await query('SELECT uuid FROM referral_codes WHERE code = $1 AND uuid != $2', [code, mcUuid]);
  if (taken.rows.length > 0) {
    return c.json({ error: 'That code is already taken. Try another.' }, 409);
  }

  // Upsert with custom flag
  await query(
    `INSERT INTO referral_codes (uuid, code, is_custom, last_changed_at)
     VALUES ($1, $2, TRUE, CURRENT_TIMESTAMP)
     ON CONFLICT (uuid) DO UPDATE SET code = EXCLUDED.code, is_custom = TRUE, last_changed_at = CURRENT_TIMESTAMP`,
    [mcUuid, code]
  );
  return c.json({ ok: true, code });
});

/**
 * POST /api/refcode/redeem — redeem a referral code.
 * Both redeemer and code owner get a reward.
 */
/**
 * POST /api/errors/report — the PLUGIN's error-visibility pipeline feeds first-sighting
 * error alerts and hourly digests here (owner directive 2026-08-19). Auth is EITHER the
 * shared X-Bot-Token OR an HMAC-SHA256 signature over the raw body using the same
 * webpanel secret the plugin and backend already share — no new secret to provision.
 * Every accepted report fans out through alertError (staff webhook + owner DM).
 * B-38 route half (2026-09-06): writeRateLimit caps the fan-out trigger itself — the sink-side
 * sanitization/ceilings landed with the alertAlerts hardening; this stops a flood of accepted
 * reports before the staff-ping path is ever reached.
 */
api.post('/errors/report', writeRateLimit, async (c) => {
  const raw = await c.req.text();

  const token = c.req.header('X-Bot-Token');
  let authed = false;
  if (env.botApiToken && token) {
    const a = Buffer.from(env.botApiToken);
    const b = Buffer.from(token);
    if (a.length === b.length) {
      try {
        authed = timingSafeEqual(a, b);
      } catch {
        authed = false;
      }
    }
  }
  if (!authed) {
    // HMAC path: X-Imperium-Signature = hex(HMAC-SHA256(webpanelHmacSecret, rawBody))
    const sigHeader = c.req.header('X-Imperium-Signature');
    if (sigHeader && env.webpanelHmacSecret) {
      const expected = createHmac('sha256', env.webpanelHmacSecret).update(raw).digest('hex');
      const a = Buffer.from(expected);
      const b = Buffer.from(sigHeader);
      if (a.length === b.length) {
        try {
          authed = timingSafeEqual(a, b);
        } catch {
          authed = false;
        }
      }
    }
  }
  if (!authed) return c.json({ error: 'Unauthorized' }, 401);

  let body: { kind?: unknown; detail?: unknown };
  try {
    body = JSON.parse(raw) as typeof body;
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
  const kind = typeof body.kind === 'string' ? body.kind.slice(0, 60) : 'plugin-error';
  const detail = typeof body.detail === 'string' ? body.detail.slice(0, 1500) : '';
  if (!detail) return c.json({ error: 'Missing detail' }, 400);

  alertError(kind, detail);
  return c.json({ ok: true });
});

api.post('/refcode/redeem', requireMcIdentity, async (c) => {
  const mcUuid = c.var.mcUuid!;

  let body: { code?: string };
  try { body = (await c.req.json()) as typeof body; } catch { return c.json({ error: 'Invalid JSON' }, 400); }

  const code = (body.code ?? '').trim().toUpperCase();
  if (!code) return c.json({ error: 'Missing code' }, 400);

  // Find the code owner
  const owner = await query<{ uuid: string; username: string }>(
    'SELECT uuid, username FROM referral_codes WHERE code = $1', [code]
  );
  if (owner.rows.length === 0) {
    return c.json({ error: 'Invalid referral code.' }, 404);
  }
  const ownerUuid = owner.rows[0].uuid;
  if (ownerUuid === mcUuid) {
    return c.json({ error: 'You cannot redeem your own code.' }, 400);
  }

  // B-C18/B-58: ONE referral redemption per account, per LIFETIME — not one
  // per code. The old `AND code_used = $2` check let a single alt account
  // redeem every code on the server (one reward each), an unbounded Sybil
  // economy dupe. B-58 closes the race: the pre-fix SELECT-then-INSERT let two
  // concurrent redeems both observe zero rows and both insert, and the
  // UNIQUE(redeemer_uuid) backstop could not land on farmed legacy dupes. The
  // INSERT is now the guard itself — ON CONFLICT (redeemer_uuid) DO NOTHING
  // arbitrates in the database, the loser reads inserted=0 and gets the 400,
  // and the counter bump is gated on the insert (a losing racer cannot
  // inflate the owner's total_redemptions either).
  // (IP guard is meaningless here: the caller is the game server, not the
  // player. Account-age/playtime guards need the live game DB or an AltGraph
  // hook — noted as follow-up, not smuggled into this bot-auth route.)
  const redeemed = await query<{ inserted: string | number; bumped: string | number }>(
    `WITH ins AS (
       INSERT INTO referral_redemptions (redeemer_uuid, code_used, referrer_uuid, reward_paid)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (redeemer_uuid) DO NOTHING
       RETURNING 1
     ), bump AS (
       UPDATE referral_codes SET total_redemptions = total_redemptions + 1
        WHERE code = $2 AND EXISTS (SELECT 1 FROM ins)
       RETURNING 1
     )
     SELECT (SELECT COUNT(*) FROM ins) AS inserted, (SELECT COUNT(*) FROM bump) AS bumped`,
    [mcUuid, code, ownerUuid]
  );
  const inserted = Number(redeemed.rows[0]?.inserted ?? 0);
  if (inserted === 0) {
    return c.json({ error: 'You have already redeemed a referral code.' }, 400);
  }
  if (Number(redeemed.rows[0]?.bumped ?? 0) === 0) {
    logger.error({ code, mcUuid }, 'refcode redeem: counter update matched no rows — redemption recorded but owner count not incremented');
  }

  // Return the owner's identity so the plugin can pay them their referral reward in-game. The reward
  // itself is granted by the Minecraft plugin (EconomyService.depositOffline) — the backend never
  // touches in-game currency. ownerName is included only for a nicer chat message to the redeemer.
  return c.json({
    ok: true,
    message: `Redeemed code ${code}! You and the code owner both get a reward in-game.`,
    ownerUuid,
    ownerName: owner.rows[0].username,
  });
});

/* --------------------------------------------------- 12a API expansion */

// Player codex/fleet, dungeons, seasons, economy flow-summary, legion public
// cards, vote callbacks, and the web shop. Mounted at the root so these paths
// sit directly under /api and share attachUser + globalRateLimit above.
// See docs/api.md for the full route table and the web_queue contract.
api.route('/', expansionApi);
// LICENSE STATUS (anti-piracy 2026-09-26): public read the plugin polls on boot + every
// 4-8h. Revocation status is not secret — the Ed25519 token is the proof; this only says
// whether its id (or the global kill switch) has been revoked. See src/api/license.ts.
api.route('/', licenseStatusApi);
// MICROSOFT (MINECRAFT) WEBSITE SIGN-IN: the client's Azure app + MS->Xbox->XSTS->
// Minecraft chain run server-side; hands the resolved account to the frontend
// exactly like the Discord OAuth flow (one-time session code). Azure prerequisite:
// redirect URI https://api.romanica.net/api/auth/microsoft/callback on the app.
api.route('/', microsoftAuthApi);
