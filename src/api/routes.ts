import { Hono, type Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import {
  AUTH_COOKIE_NAME,
  authCookieOptions,
  clearAuthCookieOptions,
  signJwt,
} from '../auth/jwt.js';
import { env } from '../env.js';
import {
  buildAvatarUrl,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchDiscordUser,
} from '../auth/discord.js';
import { attachUser, requireAuth, requireLinked } from '../middleware/auth.js';
import { authRateLimit, globalRateLimit, webcodeRateLimit } from '../middleware/rateLimit.js';
import {
  deleteDiscordLinkByDiscordId,
  getCachedSubscription,
  getDiscordIdByUuid,
  getEloLeaderboard,
  getLeaderboard,
  getParkourLeaderboard,
  getPaynowCustomerId,
  getPlayerBalances,
  getPlayerFactions,
  getPlayerParkour,
  getPlayerProfile,
  getPlayerSkills,
  getPlayerStats,
  getPlayerTransactions,
  getUuidByDiscordId,
  getUuidByPaynowCustomerId,
  getWaveLeaderboard,
  setPaynowCustomerId,
  upsertCachedSubscription,
  upsertDiscordLink,
} from '../db/pool.js';
import {
  consumeLinkCode,
  consumeLoginCode,
  createLinkCode,
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
import { isDonorSubscriptionProduct } from '../paynow/constants.js';
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
 */
function requireBotAuth(c: Context): boolean {
  const token = c.req.header('X-Bot-Token');
  return !!env.botApiToken && token === env.botApiToken;
}

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
    return c.json({ error: 'Invalid state' }, 400);
  }

  if (error) {
    logger.warn({ error }, 'Discord OAuth2 returned an error');
    return c.redirect('/login?error=oauth_denied', 302);
  }
  if (!code) {
    return c.redirect('/login?error=missing_code', 302);
  }

  try {
    const token = await exchangeCodeForToken(code);
    const discordUser = await fetchDiscordUser(token.access_token);

    const jwt = signJwt({
      authMethod: 'discord',
      discordId: discordUser.id,
      discordUsername: discordUser.global_name ?? discordUser.username,
      discordAvatar: buildAvatarUrl(discordUser),
    });

    setCookie(c, AUTH_COOKIE_NAME, jwt, authCookieOptions());
    return c.redirect('/dashboard', 302);
  } catch (err) {
    logger.error({ err }, 'Discord OAuth2 callback failed');
    return c.redirect('/login?error=callback_failed', 302);
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
 */
api.post('/auth/webcode/verify', webcodeRateLimit, async (c) => {
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

  const jwt = signJwt({
    authMethod: 'mc_code',
    mcUuid: record.uuid,
    ...(discordId ? { discordId } : {}),
  });
  setCookie(c, AUTH_COOKIE_NAME, jwt, authCookieOptions());

  return c.json({
    ok: true,
    uuid: record.uuid,
    username: record.username ?? null,
    linkedToDiscord: discordId !== null,
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

  return c.json({
    uuid,
    username: (profile as any).username ?? `Player`,
    discordId: queryDiscordId ?? c.var.user?.discordId ?? null,
    rank: (profile as any).rank ?? (profile as any).rank_level ?? 0,
    prestigeLevel: (profile as any).prestigeLevel ?? (profile as any).prestige_level ?? 0,
    denarius: (profile as any).denarius ?? balances.denarius ?? 0,
    auctoritas: (profile as any).auctoritas ?? balances.tokens ?? 0,
    civitas: (profile as any).civitas ?? balances.beacons ?? 0,
    aureus: (profile as any).aureus ?? balances.goldenCoins ?? 0,
    blocksMined: (profile as any).blocksMined ?? (profile as any).blocks_mined ?? 0,
    playtimeSeconds: Number((profile as any).playtimeSeconds ?? (profile as any).play_time ?? 0),
    pvpKills: (profile as any).pvpKills ?? (profile as any).pvp_kills ?? 0,
    pvpDeaths: (profile as any).pvpDeaths ?? (profile as any).pvp_deaths ?? 0,
    trophies: (profile as any).trophies ?? (profile as any).pvp_trophies ?? 0,
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
    highest_wave: row.highest_wave,
    total_sessions: row.total_sessions,
  }));
  return c.json({ entries });
});

/** GET /api/server/status — online player count from Redis (live) or DB. */
api.get('/server/status', async (c) => {
  try {
    const online = await getOnlinePlayerCount();
    return c.json({
      online: online === null ? false : online > 0,
      playerCount: online ?? 0,
      maxPlayers: 200,
      timestamp: Date.now(),
      source: online === null ? 'unknown' : 'redis',
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

/** POST /api/link/confirm — validate a code and persist the link. Called by the bot. */
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
  const discordId = body.discordId ?? '';
  if (!code) {
    return c.json({ error: 'Missing code' }, 400);
  }
  if (!discordId) {
    return c.json({ error: 'Missing discordId' }, 400);
  }

  // Step 1: Verify the code against the plugin's SQLite database (link_codes table).
  // This is the code the player got from /discord link in-game.
  const { verifyLinkCode } = await import('../db/sqlite.js');
  const codeRecord = verifyLinkCode(code);
  if (!codeRecord) {
    // Fall back to Redis-based verification if SQLite isn't available
    const redisRecord = await consumeLinkCode(code);
    if (!redisRecord) {
      return c.json({ error: 'Invalid or expired code. Run /discord link in-game for a fresh one.' }, 404);
    }
    // Redis path
    const uuid = body.uuid ?? redisRecord.uuid;
    if (!uuid || !discordId) {
      return c.json({ error: 'Cannot complete link' }, 400);
    }
    try {
      await upsertDiscordLink(uuid, discordId);
      return c.json({ ok: true, linked: true, discordId, uuid, username: 'Player' });
    } catch {
      return c.json({ error: 'Failed to persist link' }, 500);
    }
  }

  // SQLite path: code is valid, now write the link directly to SQLite.
  const uuid = codeRecord.uuid;
  const { upsertDiscordLinkSqlite } = await import('../db/sqlite.js');
  const written = upsertDiscordLinkSqlite(uuid, discordId);
  if (written) {
    return c.json({
      ok: true,
      linked: true,
      discordId,
      uuid,
      username: `Player`,
    });
  }
  // Fallback: try PostgreSQL
  try {
    await upsertDiscordLink(uuid, discordId);
    return c.json({ ok: true, linked: true, discordId, uuid, username: 'Player' });
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

const FRONTEND_URL = env.isProduction ? 'https://imperiummc.net' : 'http://localhost:3000';

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
api.get('/store/subscription', requireAuth, requireLinked, async (c) => {
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
api.post('/store/checkout', requireAuth, requireLinked, async (c) => {
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
      returnUrl: `${FRONTEND_URL}/dashboard/subscription?checkout=success`,
      cancelUrl: `${FRONTEND_URL}/store?checkout=canceled`,
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
api.post('/store/subscription/preview-change', requireAuth, requireLinked, async (c) => {
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
api.post('/store/subscription/change', requireAuth, requireLinked, async (c) => {
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
