// V6 04-03: public player profiles. GET /api/v2/public/player/:username is the
// one aggregate the shareable /profile/[name] page renders from. It is the
// PUBLIC projection of a player: the schema excludes aureus/auctoritas by
// construction (they are not selected into the payload at all), so privacy is
// enforced server-side, not by the frontend declining to render a field.
//
// Deliberate differences from the bot-gated /api/player/profile:
//   - Name resolution reads player_names ONLY. No Mojang fallback (that path
//     WRITES a resolved row — a public endpoint must not let anonymous traffic
//     seed the registry) and no bot-token escalation for arbitrary targets.
//   - 404 (not a rich error) for unknown names: the page renders "never
//     joined" from the status, and scraping learns nothing but existence.
//   - Redis-cached 60s per uuid — popular profiles serve from cache, and the
//     page's ISR rides on top with its own revalidate window.
import { Hono } from 'hono';
import { query } from '../../db/pool.js';
import {
  getPlayerProfile,
  getPlayerBalances,
  getPlayerParkour,
  getPlayerAchievements,
} from '../../db/pool.js';
import { getCachedJson, setCachedJson } from '../../db/redis.js';
import { publicProfileRateLimit } from '../../middleware/rateLimit.js';
import type { AppContextVariables } from '../../types/index.js';

type ApiEnv = { Variables: AppContextVariables };

export const publicApi = new Hono<ApiEnv>();

/** Java names: [A-Za-z0-9_]{3,16}. Bedrock (Floodgate) names start with '.'
 * followed by the gamertag (allows spaces, stripped to 16 chars upstream). */
const USERNAME_PATTERN = /^[A-Za-z0-9_. -]{1,20}$/;

/** The public profile payload — the privacy contract lives HERE. Anything not
 * in this interface must never be added without re-reading the "public vs
 * private" table in MASTER-PLAN-V6/04-WEB-PLATFORM/03-PLAYER-PROFILES.md. */
interface PublicProfile {
  uuid: string;
  username: string;
  bedrock: boolean;
  online: boolean;
  rank: number;
  rankName: string | null;
  prestige: number;
  legion: string | null;
  // Denarius is public; civitas is a public legion-contribution score (the
  // in-game /legion top shows it for every member). Aureus and auctoritas are
  // PRIVATE and intentionally absent from this interface.
  denarius: number;
  civitas: number;
  blocksMined: number;
  playtimeSeconds: number;
  pvpKills: number;
  pvpDeaths: number;
  trophies: number;
  kothWins: number;
  elo: { rating: number; peak: number } | null;
  achievementCount: number;
  recentAchievements: string[];
  parkourBests: Array<{ course: string; timeMs: number; completions: number }>;
}

publicApi.get('/player/:username', publicProfileRateLimit, async (c) => {
  const rawName = (c.req.param('username') ?? '').trim();
  if (!rawName || !USERNAME_PATTERN.test(rawName)) {
    return c.json({ error: 'Invalid username' }, 400);
  }

  // Resolve from the plugin-maintained registry only. LOWER() on both sides:
  // canonical casing comes back from the row, not from the caller.
  let uuid: string | null = null;
  let canonicalName: string | null = null;
  try {
    const found = await query<{ uuid: string; username: string }>(
      'SELECT uuid, username FROM player_names WHERE LOWER(username) = LOWER($1) LIMIT 1',
      [rawName],
    );
    uuid = found.rows[0]?.uuid ?? null;
    canonicalName = found.rows[0]?.username ?? null;
  } catch {
    return c.json({ error: 'Registry unavailable' }, 503);
  }
  if (!uuid || !canonicalName) {
    // Never joined (or unknown) — a flat 404 carries no information beyond
    // existence, which the leaderboards already expose.
    return c.json({ error: 'Player not found' }, 404);
  }

  const cacheKey = `public_profile:${uuid}`;
  const cached = await getCachedJson<PublicProfile>(cacheKey);
  if (cached) {
    return c.json(cached, 200, { 'Cache-Control': 'public, max-age=30, s-maxage=60' });
  }

  const profile = await buildPublicProfile(uuid, canonicalName);
  if (!profile) {
    return c.json({ error: 'Player not found' }, 404);
  }

  // Fire-and-forget: a Redis outage must never delay or fail the response.
  void setCachedJson(cacheKey, profile, 60);
  return c.json(profile, 200, { 'Cache-Control': 'public, max-age=30, s-maxage=60' });
});

/** Assemble the public projection. Every optional table degrades to a null /
 * zero default on error — a missing achievements table must not take the whole
 * profile down (same degrade-gracefully pattern as the rest of the expansion). */
async function buildPublicProfile(uuid: string, username: string): Promise<PublicProfile | null> {
  const p = await getPlayerProfile(uuid).catch(() => null);
  if (!p) return null;

  // Balances: pick ONLY the public fields out of the helper's full result.
  // aureus (goldenCoins) and auctoritas (tokens) never leave this function.
  let denarius = 0;
  let civitas = 0;
  try {
    const balances = await getPlayerBalances(uuid);
    denarius = balances.denarius ?? 0;
    civitas = balances.beacons ?? 0;
  } catch {
    // Public page tolerates zero balances on a PG blip.
  }

  const base: PublicProfile = {
    uuid,
    username,
    bedrock: username.startsWith('.'),
    online: false,
    rank: p.rank?.level ?? 0,
    rankName: p.rank?.name ?? null,
    prestige: p.prestige?.level ?? 0,
    legion: null,
    denarius,
    civitas,
    blocksMined: p.stats?.blocksMined ?? 0,
    playtimeSeconds: Number(p.stats?.playTime ?? 0),
    pvpKills: p.stats?.pvpKills ?? 0,
    pvpDeaths: p.stats?.pvpDeaths ?? 0,
    trophies: p.stats?.pvpTrophies ?? 0,
    kothWins: 0,
    elo: null,
    achievementCount: 0,
    recentAchievements: [],
    parkourBests: [],
  };

  // online_players is a live registry keyed by uuid — a hit means online now.
  try {
    const online = await query<{ uuid: string }>(
      'SELECT uuid FROM online_players WHERE uuid = $1 LIMIT 1',
      [uuid],
    );
    base.online = online.rows.length > 0;
  } catch {
    // Registry unavailable — report offline rather than failing.
  }

  try {
    const legion = await query<{ name: string }>(
      `SELECT l.name
         FROM legion_members m
         JOIN legions l ON l.name = m.legion_name
        WHERE m.player_uuid = $1
        LIMIT 1`,
      [uuid],
    );
    base.legion = legion.rows[0]?.name ?? null;
  } catch {
    // Legion tables unavailable — omit.
  }

  try {
    const koth = await query<{ total: string | null }>(
      `SELECT SUM(value)::text AS total
         FROM leaderboard_stats
        WHERE uuid = $1 AND category = 'KOTH_WINS' AND period = 'ALL_TIME'`,
      [uuid],
    );
    base.kothWins = Number(koth.rows[0]?.total ?? 0);
  } catch {
    // leaderboard_stats unavailable — zero.
  }

  try {
    const elo = await query<{ elo: string; peak_elo: string }>(
      'SELECT elo, peak_elo FROM player_elo WHERE uuid = $1 LIMIT 1',
      [uuid],
    );
    const row = elo.rows[0];
    if (row) {
      base.elo = { rating: Number(row.elo ?? 0), peak: Number(row.peak_elo ?? 0) };
    }
  } catch {
    // No player_elo row (never PVP'd) — stays null.
  }

  try {
    const achievements = await getPlayerAchievements(uuid);
    const all = achievements.achievements ?? [];
    const completed = all.filter((a) => a.completed);
    base.achievementCount = completed.length;
    // Badge ids only (the checklist itself is private) — latest 6 by unlock time.
    base.recentAchievements = completed
      .slice()
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
      .slice(0, 6)
      .map((a) => a.achievementId);
  } catch {
    // Achievements table unavailable — zero-count profile.
  }

  try {
    const parkour = await getPlayerParkour(uuid);
    base.parkourBests = (parkour.records ?? [])
      .slice(0, 3)
      .map((r) => ({ course: r.course, timeMs: r.best_time_ms, completions: r.completions }));
  } catch {
    // Parkour table unavailable — empty list.
  }

  return base;
}
