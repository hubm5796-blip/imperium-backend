import { Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import {
  AUTH_COOKIE_NAME,
  authCookieOptions,
  clearAuthCookieOptions,
  signJwt,
} from '../auth/jwt.js';
import {
  buildAvatarUrl,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchDiscordUser,
} from '../auth/discord.js';
import { attachUser, requireAuth, requireLinked } from '../middleware/auth.js';
import { authRateLimit, globalRateLimit } from '../middleware/rateLimit.js';
import {
  deleteDiscordLinkByDiscordId,
  getLeaderboard,
  getPlayerBalances,
  getPlayerProfile,
  getPlayerStats,
  getPlayerTransactions,
  getUuidByDiscordId,
  upsertDiscordLink,
} from '../db/pool.js';
import {
  consumeLinkCode,
  createLinkCode,
  getOnlinePlayerCount,
  sendCommandWithResponse,
} from '../db/redis.js';
import type { AppContextVariables } from '../types/index.js';
import { logger } from '../utils/logger.js';

type ApiEnv = { Variables: AppContextVariables };

/** Full API surface mounted at /api by the main app. */
export const api = new Hono<ApiEnv>();

// Attach the current user (if any) to every request.
api.use('*', attachUser);
// Apply a default sliding-window limit to everything.
api.use('*', globalRateLimit);

/* ------------------------------------------------------------------ Auth */

/** GET /api/auth/discord — redirect to Discord OAuth2 authorize URL. */
api.get('/auth/discord', (c) => {
  // A simple state token to mitigate CSRF on the callback.
  const state = Math.random().toString(36).slice(2);
  const url = buildAuthorizeUrl(state);
  return c.redirect(url, 302);
});

/** GET /api/auth/discord/callback — handle the OAuth2 callback. */
api.get('/auth/discord/callback', authRateLimit, async (c) => {
  const code = c.req.query('code');
  const error = c.req.query('error');

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

/** GET /api/auth/me — return the current Discord user + MC link status. */
api.get('/auth/me', requireAuth, async (c) => {
  const user = c.var.user!;
  return c.json({
    discordId: user.discordId,
    username: user.discordUsername,
    avatar: user.discordAvatar,
    mcLinked: c.var.mcUuid !== null,
    mcUuid: c.var.mcUuid,
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

/* -------------------------------------------------------------- Linking */

/** POST /api/link/initiate — generate a 6-char code stored in Redis (10 min TTL). */
api.post('/link/initiate', requireAuth, async (c) => {
  const user = c.var.user!;
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
