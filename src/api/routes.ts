import { timingSafeEqual } from 'node:crypto';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
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
import { attachUser, requireAuth, requireLinked } from '../middleware/auth.js';
import { authRateLimit, globalRateLimit, rateLimit } from '../middleware/rateLimit.js';
import {
  deleteDiscordLinkByDiscordId,
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
  getUuidByPaynowCustomerId,
  getUuidByUsername,
  getNameByUuid,
  getWaveLeaderboard,
  isAlreadyLinked,
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
  getOnlinePlayerCount,
  sendCommandWithResponse,
} from '../db/redis.js';
import {
  applyTierChange,
  createCheckoutSession,
  createCustomerToken,
  findOrCreatePaynowCustomer,
  getCustomerSubscriptions,
  PaynowApiError,
  previewTierChange,
} from '../paynow/client.js';
import { isDonorSubscriptionProduct, isLifetimeProduct } from '../paynow/constants.js';
import { verifyPaynowWebhook } from '../paynow/webhookVerify.js';
import type { AppContextVariables } from '../types/index.js';
import { logger } from '../utils/logger.js';

type ApiEnv = { Variables: AppContextVariables };

/** Full API surface mounted at /api by the main app. */
export const api = new Hono<ApiEnv>();

// Attach the current user (if any) to every request.
api.use('*', attachUser);
// Apply a default sliding-window limit to everything.
api.use('*', globalRateLimit);

/**
 * Shared-secret bot authentication. The Discord bot sends the
 * `X-Bot-Token` header (matching BOT_API_TOKEN) on bot-only requests.
 * Returns true when the token matches; false otherwise (including when the
 * token is unset in dev). Callers decide how to treat a failure: 401 for
 * bot-only endpoints, or fall through to cookie auth for mixed endpoints.
 *
 * Compared with `timingSafeEqual` to avoid leaking the secret via timing
 * side-channels (early-exit string comparison can be exploited to recover the
 * token byte-by-byte).
 */
function requireBotAuth(c: Context): boolean {
  const token = c.req.header('X-Bot-Token');
  if (!env.botApiToken || !token) return false;
  try {
    const a = Buffer.from(env.botApiToken);
    const b = Buffer.from(token);
    // Length must match before timingSafeEqual (it throws on mismatched
    // lengths); the length check itself is constant-time-safe because the
    // secret length is not sensitive.
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Rate limiter for /auth/webcode/verify. This route is bot-token-gated (only
 * imperium-frontend's own edge proxy can call it — see the route below), so
 * `X-Original-Client-IP` is trustworthy here specifically: an attacker can't
 * reach this route at all without the bot token, and the only party that
 * holds it (our own frontend) sets that header from the *real* incoming
 * request's Cloudflare-verified `CF-Connecting-IP`, not from anything an end
 * user controls directly. Falls back to the normal spoofable-header chain
 * for requests that (somehow) reach here without valid bot auth — they'll be
 * rejected by the route handler anyway, but still get bucketed sanely rather
 * than colliding into a single 'unknown' bucket.
 */
const webcodeRateLimit = rateLimit(8, 5 * 60_000, 'webcode', (c) => {
  if (requireBotAuth(c)) {
    const forwarded = c.req.header('x-original-client-ip');
    if (forwarded) return forwarded;
  }
  return (
    c.req.header('cf-connecting-ip') ??
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    'unknown'
  );
});

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
    return c.json({ error: 'Invalid state' }, 400);
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
    // cookie on imperiummc.net. The backend owns the OAuth + Discord secret; the
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
  if (!requireBotAuth(c)) {
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
 * imperiummc.net after the backend completed the Discord OAuth. Single-use.
 */
api.post('/auth/exchange', webcodeRateLimit, async (c) => {
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
    discordId: session.discordId,
    discordUsername: session.discordUsername,
    discordAvatar: session.discordAvatar,
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

  // Targeted lookups (?uuid= / ?discord_id=) are bot-only. Without a valid
  // bot token, anyone could read any player's data, so fall through to the
  // cookie-based "self" path (which is the only thing a browser may do).
  if ((queryUuid || queryDiscordId) && !requireBotAuth(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  let uuid: string | null;
  if (queryUuid) {
    uuid = queryUuid;
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

  // Try PostgreSQL first, fall back to SQLite
  let profile: any = null;
  try {
    profile = await getPlayerProfile(uuid);
  } catch {
    profile = null;
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

  // Get balances from PG, fall back to SQLite profile values
  let balances: any = { denarius: 0, tokens: 0, beacons: 0, goldenCoins: 0 };
  try {
    balances = await getPlayerBalances(uuid);
  } catch {
    // PG not available — balances come from SQLite profile
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

  return c.json({
    uuid,
    username: resolvedUsername ?? `Player`,
    discordId: queryDiscordId ?? c.var.user?.discordId ?? null,
    rank: p.rank?.level ?? p.rank_level ?? p.rank ?? 0,
    prestigeLevel: p.prestige?.level ?? p.prestige_level ?? p.prestige ?? 0,
    denarius: balances.denarius ?? 0,
    auctoritas: balances.tokens ?? 0,
    civitas: balances.beacons ?? 0,
    aureus: balances.goldenCoins ?? 0,
    blocksMined: p.stats?.blocksMined ?? p.blocksMined ?? p.blocks_mined ?? 0,
    playtimeSeconds: Number(p.stats?.playTime ?? p.playTime ?? p.play_time ?? 0),
    pvpKills: p.stats?.pvpKills ?? p.pvpKills ?? p.pvp_kills ?? 0,
    pvpDeaths: p.stats?.pvpDeaths ?? p.pvpDeaths ?? p.pvp_deaths ?? 0,
    trophies: p.stats?.pvpTrophies ?? p.pvpTrophies ?? p.pvp_trophies ?? 0,
  });
});

/** GET /api/player/balances — the four currencies, converted from minor units. */
api.get('/player/balances', requireAuth, requireLinked, async (c) => {
  const uuid = c.var.mcUuid!;
  const balances = await getPlayerBalances(uuid);
  return c.json({ uuid, balances });
});

/** GET /api/player/stats — blocks mined, pvp, playtime. */
api.get('/player/stats', requireAuth, requireLinked, async (c) => {
  const uuid = c.var.mcUuid!;
  const stats = await getPlayerStats(uuid);
  if (!stats) {
    return c.json({ error: 'Player stats not found' }, 404);
  }
  return c.json(stats);
});

/** GET /api/player/transactions?page=1 — paginated economy history. */
api.get('/player/transactions', requireAuth, requireLinked, async (c) => {
  const uuid = c.var.mcUuid!;
  const pageSize = 25;
  const rawPage = Number.parseInt(c.req.query('page') ?? '1', 10);
  const page = Number.isNaN(rawPage) || rawPage < 1 ? 1 : rawPage;

  const { rows, total } = await getPlayerTransactions(uuid, page, pageSize);
  return c.json({
    page,
    pageSize,
    total,
    totalPages: Math.max(Math.ceil(total / pageSize), 1),
    transactions: rows,
  });
});

/** GET /api/player/skills — Roman skill tree (Virtus/Mercatura/Divinitas). */
api.get('/player/skills', requireAuth, requireLinked, async (c) => {
  const uuid = c.var.mcUuid!;
  const skills = await getPlayerSkills(uuid);
  return c.json(skills);
});

/** GET /api/player/factions — faction reputation across the 8 Roman factions. */
api.get('/player/factions', requireAuth, requireLinked, async (c) => {
  const uuid = c.var.mcUuid!;
  const factions = await getPlayerFactions(uuid);
  return c.json(factions);
});

/** GET /api/player/parkour — best times per parkour course. */
api.get('/player/parkour', requireAuth, requireLinked, async (c) => {
  const uuid = c.var.mcUuid!;
  const parkour = await getPlayerParkour(uuid);
  return c.json(parkour);
});

/** GET /api/player/achievements — completed and in-progress achievements. */
api.get('/player/achievements', requireAuth, requireLinked, async (c) => {
  const uuid = c.var.mcUuid!;
  const data = await getPlayerAchievements(uuid);
  return c.json(data);
});

/** GET /api/player/cosmetics — owned cosmetics and active trail/hat/effects. */
api.get('/player/cosmetics', requireAuth, requireLinked, async (c) => {
  const uuid = c.var.mcUuid!;
  const data = await getPlayerCosmetics(uuid);
  return c.json(data);
});

/** GET /api/player/quests — today's daily quests and their progress. */
api.get('/player/quests', requireAuth, requireLinked, async (c) => {
  const uuid = c.var.mcUuid!;
  const data = await getPlayerDailyQuests(uuid);
  return c.json(data);
});

/** GET /api/player/legion — the player's legion (guild) + members. */
api.get('/player/legion', requireAuth, requireLinked, async (c) => {
  const uuid = c.var.mcUuid!;
  const data = await getPlayerLegion(uuid);
  return c.json(data);
});

/* ---------------------------------------------------------------- Admin */

/**
 * GET /api/admin/server/status — enriched status for staff (TPS, memory, online
 * player list). The frontend proxy route (src/app/api/admin/status/route.ts)
 * forwards here with the X-Bot-Token + X-Admin-Discord-Id headers.
 */
api.get('/admin/server/status', async (c) => {
  if (!requireBotAuth(c)) {
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
api.get('/admin/player', async (c) => {
  if (!requireBotAuth(c)) {
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
});

/**
 * POST /api/admin/punish — forward a punishment to the plugin via Redis.
 * Body: { target, action, reason, duration, actor }
 */
api.post('/admin/punish', async (c) => {
  if (!requireBotAuth(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
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

  // Try to forward via the Redis command bus
  try {
    const response = await sendCommandWithResponse(
      'PUNISH_PLAYER',
      { target, action, reason, duration: body.duration, actor: body.actor },
      5_000,
    );
    if (response.status === 'OK') {
      return c.json({ ok: true, result: response.data ?? null });
    }
    return c.json({ error: response.error ?? 'Plugin rejected the action' }, 502);
  } catch {
    return c.json({ error: 'Plugin did not respond — punishment may not be wired yet' }, 501);
  }
});

/**
 * POST /api/admin/broadcast — forward a broadcast to the plugin.
 */
api.post('/admin/broadcast', async (c) => {
  if (!requireBotAuth(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
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

  try {
    const response = await sendCommandWithResponse('BROADCAST', { message }, 5_000);
    if (response.status === 'OK') {
      return c.json({ ok: true });
    }
    return c.json({ error: response.error ?? 'Plugin rejected the broadcast' }, 502);
  } catch {
    return c.json({ error: 'Plugin did not respond — broadcast may not be wired yet' }, 501);
  }
});

/**
 * POST /api/admin/reload — trigger a config reload on the plugin.
 */
api.post('/admin/reload', async (c) => {
  if (!requireBotAuth(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  try {
    const response = await sendCommandWithResponse('RELOAD_CONFIG', {}, 10_000);
    if (response.status === 'OK') {
      return c.json({ ok: true });
    }
    return c.json({ error: response.error ?? 'Plugin rejected the reload' }, 502);
  } catch {
    return c.json({ error: 'Plugin did not respond — reload may not be wired yet' }, 501);
  }
});

/**
 * GET /api/player/permissions?discord_id=... — resolve LuckPerms groups for a
 * Discord-linked player. Used by the frontend admin gate + AdminContext.
 */
api.get('/player/permissions', async (c) => {
  if (!requireBotAuth(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const discordId = c.req.query('discord_id');
  if (!discordId) {
    return c.json({ error: 'Missing discord_id' }, 400);
  }

  // Resolve the MC UUID from the Discord link
  let uuid: string | null = null;
  try {
    uuid = await getUuidByDiscordId(discordId);
  } catch {
    uuid = null;
  }

  if (!uuid) {
    return c.json({ isAdmin: false, isMod: false, isHelper: false, groups: [] });
  }

  // Query LuckPerms groups from the database (the plugin writes them)
  let groups: string[] = [];
  try {
    const result = await query<{ group_name: string }>(
      `SELECT group_name FROM luckperms_players WHERE uuid = $1`,
      [uuid],
    );
    groups = result.rows.map((r: { group_name: string }) => r.group_name.toLowerCase());
  } catch {
    // LuckPerms table may not exist or have a different name
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

/** GET /api/leaderboards/:type — top 20 by denarius | blocks | prestige | playtime. */
api.get('/leaderboards/:type', async (c) => {
  const type: string = c.req.param("type") ?? "";
  if (type !== 'denarius' && type !== 'blocks' && type !== 'prestige' && type !== 'playtime') {
    return c.json(
      { error: "Invalid leaderboard type; must be 'denarius', 'blocks', 'prestige', or 'playtime'" },
      400,
    );
  }
  const limitRaw = Number.parseInt(c.req.query('limit') ?? '20', 10);
  const limit = Number.isNaN(limitRaw) ? 20 : limitRaw;
  let rows;
  try {
    rows = await getLeaderboard(type, limit);
  } catch {
    return c.json({ type, entries: [], error: 'Database unavailable' }, 503);
  }
  // Add 1-based rank and a display username for the bot's embeds.
  const entries = rows.map((row, i) => ({
    rank: i + 1,
    uuid: row.uuid,
    username: row.name ?? row.uuid,
    value: row.value,
    secondary: row.secondary,
  }));
  return c.json({ type, entries });
});

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
  const limitRaw = Number.parseInt(c.req.query('limit') ?? '20', 10);
  const limit = Number.isNaN(limitRaw) ? 20 : limitRaw;

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
  const limitRaw = Number.parseInt(c.req.query('limit') ?? '20', 10);
  const limit = Number.isNaN(limitRaw) ? 20 : limitRaw;

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
  const limitRaw = Number.parseInt(c.req.query('limit') ?? '20', 10);
  const limit = Number.isNaN(limitRaw) ? 20 : limitRaw;

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

/** GET /api/server/status — online player count from Redis (live) or DB. */
api.get('/server/status', async (c) => {
  try {
    const count = await getOnlinePlayerCount();
    // The plugin writes ImperiumMC:online_count every 20s with a 60s TTL. A present
    // key (even value 0) means the server process is alive and heartbeating — that's
    // "online", regardless of whether anyone is logged in. Only a missing key (null,
    // expired/never-written) means the server is actually down. Conflating "0 players"
    // with "offline" made an empty-but-live server read as Offline in Discord/the site.
    const isUp = count !== null;
    return c.json({
      online: isUp,
      playerCount: count ?? 0,
      maxPlayers: 200,
      timestamp: Date.now(),
      source: count === null ? 'unknown' : 'redis',
    });
  } catch {
    return c.json({
      online: false,
      playerCount: 0,
      maxPlayers: 200,
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
  if (!requireBotAuth(c)) {
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
  // to a different Discord account. Throws are swallowed — PG being down falls
  // through to the upsert, which will fail loudly if there's a real conflict.
  try {
    const existing = await isAlreadyLinked(record.uuid);
    if (existing && existing !== discordId) {
      return c.json(
        { error: 'Minecraft account already linked to a different Discord' },
        409,
      );
    }
  } catch {
    // PG guard unavailable — fall through to the write.
  }

  try {
    await upsertDiscordLink(record.uuid, discordId);
    // Resolve the Minecraft username so the bot can show "linked to <name>"
    // instead of "linked to undefined". Falls back to the UUID if the player
    // hasn't joined since the player_names registry was introduced.
    let username: string | null = null;
    try {
      username = await getNameByUuid(record.uuid);
    } catch {
      // player_names table missing or PG hiccup — degrade to the uuid.
    }
    return c.json({ ok: true, linked: true, discordId, uuid: record.uuid, username: username ?? record.uuid });
  } catch {
    return c.json({ error: 'Failed to persist link' }, 500);
  }
});

/**
 * DELETE /api/link?discord_id=... — remove a Discord↔Minecraft link.
 * Called by the bot's /unlink command. Returns 404 if no link existed.
 */
api.delete('/link', async (c) => {
  // Bot-only: unlinking arbitrary accounts must be authenticated.
  if (!requireBotAuth(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const discordId = c.req.query('discord_id');
  if (!discordId) {
    return c.json({ error: 'Missing discord_id query parameter' }, 400);
  }
  const removed = await deleteDiscordLinkByDiscordId(discordId);
  if (!removed) {
    return c.json({ error: 'No link found for this Discord account' }, 404);
  }
  return c.json({ discordId, unlinked: true });
});

/* ------------------------------------------------------------------ Store */

// Function, not a module-scope constant: `env` isn't populated until
// initEnvFromProcess()/initEnvFromBindings() runs, which happens after this
// module's own top-level code has already been evaluated.
function frontendUrl(): string {
  return env.isProduction ? 'https://imperiummc.net' : 'http://localhost:3000';
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
  if (requireBotAuth(c)) {
    const uuid = c.req.header('x-mc-uuid');
    if (!uuid) {
      return c.json({ error: 'Missing X-Mc-Uuid header' }, 400);
    }
    // Validate UUID format — accepts Minecraft UUIDs, Bedrock .prefix names,
    // and Discord snowflake IDs (numeric, 17-20 digits) since the frontend
    // may pass a discordId as fallback when no MC UUID is linked.
    if (!/^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/.test(uuid)
        && !/^\.[a-zA-Z0-9_]{3,16}$/.test(uuid)
        && !/^\d{17,20}$/.test(uuid)) {
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

/** Resolve (and lazily create) the PayNow customer id for the calling player. */
async function resolvePaynowCustomerId(uuid: string): Promise<string> {
  const existing = await getPaynowCustomerId(uuid);
  if (existing) return existing;
  const customerId = await findOrCreatePaynowCustomer(uuid);
  await setPaynowCustomerId(uuid, customerId);
  return customerId;
}

/**
 * GET /api/store/subscription — the caller's current donor subscription, if any.
 * Reads from our webhook-fed cache first (fast, no PayNow round trip); falls
 * back to a live Storefront API call if we've never seen a webhook for this
 * player yet (e.g. their very first purchase, before the webhook lands).
 */
api.get('/store/subscription', storeAuth, async (c) => {
  const uuid = c.var.mcUuid!;

  const cached = await getCachedSubscription(uuid);
  if (cached) {
    return c.json({
      subscriptionId: cached.subscription_id,
      productId: cached.product_id,
      status: cached.status,
    });
  }

  const customerId = await getPaynowCustomerId(uuid);
  if (!customerId) {
    return c.json({ subscription: null });
  }

  try {
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
    return c.json({ subscription: null });
  }
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

  try {
    const customerId = await resolvePaynowCustomerId(uuid);
    const session = await createCheckoutSession({
      customerId,
      productId: body.productId,
      subscription: Boolean(body.subscription),
      returnUrl: `${frontendUrl()}/dashboard/subscription?checkout=success`,
      cancelUrl: `${frontendUrl()}/store?checkout=canceled`,
    });
    return c.json({ url: session.url });
  } catch (err) {
    if (err instanceof PaynowApiError) {
      logger.warn({ err: err.body, status: err.status, uuid }, 'PayNow checkout creation failed');
      return c.json({ error: err.message }, 502);
    }
    logger.error({ err, uuid }, 'Checkout creation failed');
    return c.json({ error: 'Failed to create checkout session' }, 500);
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

  const customerId = await getPaynowCustomerId(uuid);
  if (!customerId) {
    return c.json({ error: 'No PayNow customer on record for this account' }, 404);
  }

  try {
    const token = await createCustomerToken(customerId);
    const result = await previewTierChange(token, body.targetProductId);
    return c.json(result);
  } catch (err) {
    if (err instanceof PaynowApiError) {
      return c.json({ error: err.message }, 502);
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

  const customerId = await getPaynowCustomerId(uuid);
  if (!customerId) {
    return c.json({ error: 'No PayNow customer on record for this account' }, 404);
  }

  try {
    const token = await createCustomerToken(customerId);
    const result = await applyTierChange(token, body.targetProductId, body.verificationCode);
    return c.json(result);
  } catch (err) {
    if (err instanceof PaynowApiError) {
      return c.json({ error: err.message }, 502);
    }
    logger.error({ err, uuid }, 'Tier change failed');
    return c.json({ error: 'Failed to change tier' }, 500);
  }
});

/**
 * GET /api/player/lookup?username=... — resolve a username to a UUID (and
 * display name) for the gifting flow. Requires a linked session; only tells
 * the caller whether *some* account exists under that name, nothing else.
 */
api.get('/player/lookup', storeAuth, async (c) => {
  const username = (c.req.query('username') ?? '').trim();
  if (!username) {
    return c.json({ error: 'Missing username query parameter' }, 400);
  }
  const uuid = await getUuidByUsername(username);
  if (!uuid) {
    return c.json({ error: 'No player found with that username' }, 404);
  }
  return c.json({ uuid, username });
});

/**
 * POST /api/store/gift-checkout — create a checkout session for a one-time
 * lifetime product, delivered to a *different* player's Minecraft account.
 * The caller pays (redirected to the returned checkout URL); the PayNow
 * customer — and therefore the delivery target — is resolved from the
 * recipient's username, not the caller's own account. Lifetime products
 * only: see isLifetimeProduct() for why subscriptions aren't giftable.
 */
api.post('/store/gift-checkout', storeAuth, async (c) => {
  const buyerUuid = c.var.mcUuid!;
  let body: { productId?: string; recipientUsername?: string };
  try {
    body = (await c.req.json()) as { productId?: string; recipientUsername?: string };
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  if (!body.productId || !isLifetimeProduct(body.productId)) {
    return c.json({ error: 'Invalid or unknown productId — gifting only supports lifetime ranks' }, 400);
  }
  const recipientUsername = (body.recipientUsername ?? '').trim();
  if (!recipientUsername) {
    return c.json({ error: 'Missing recipientUsername' }, 400);
  }

  const recipientUuid = await getUuidByUsername(recipientUsername);
  if (!recipientUuid) {
    return c.json({ error: 'No player found with that username — have they joined the server before?' }, 404);
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
      logger.warn({ err: err.body, status: err.status, buyerUuid, recipientUuid }, 'PayNow gift checkout creation failed');
      return c.json({ error: err.message }, 502);
    }
    logger.error({ err, buyerUuid, recipientUuid }, 'Gift checkout creation failed');
    return c.json({ error: 'Failed to create gift checkout session' }, 500);
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

  let event: { event_type?: string; data?: Record<string, unknown> };
  try {
    event = JSON.parse(rawBody) as { event_type?: string; data?: Record<string, unknown> };
  } catch {
    return c.json({ error: 'Invalid JSON payload' }, 400);
  }

  const eventType = event.event_type ?? '';
  const data = event.data ?? {};

  try {
    switch (eventType) {
      case 'OnSubscriptionActivated':
      case 'OnSubscriptionRenewed': {
        const customerId = String(data['customer_id'] ?? (data['customer'] as { id?: string })?.id ?? '');
        const subscriptionId = String(data['id'] ?? '');
        const productId = String(data['product_id'] ?? (data['product'] as { id?: string })?.id ?? '');
        const status = String(data['status'] ?? 'active');
        const uuid = customerId ? await getUuidByPaynowCustomerId(customerId) : null;
        if (uuid && subscriptionId && productId) {
          await upsertCachedSubscription(uuid, subscriptionId, productId, status);
        }
        break;
      }
      case 'OnSubscriptionCanceled': {
        const customerId = String(data['customer_id'] ?? (data['customer'] as { id?: string })?.id ?? '');
        const subscriptionId = String(data['id'] ?? '');
        const productId = String(data['product_id'] ?? (data['product'] as { id?: string })?.id ?? '');
        const uuid = customerId ? await getUuidByPaynowCustomerId(customerId) : null;
        if (uuid && subscriptionId && productId) {
          await upsertCachedSubscription(uuid, subscriptionId, productId, 'canceled');
        }
        break;
      }
      default:
        // Other event types (orders, refunds, chargebacks) don't need caching —
        // rank grant/revoke is already handled by PayNow's product commands.
        break;
    }
  } catch (err) {
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
