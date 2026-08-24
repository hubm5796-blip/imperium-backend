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

/** How long a previously-built profile may be re-served after the database
 * stops answering. Public profile data is not transactional — a slightly
 * stale rank during an outage beats a 503 on a page linked from everywhere. */
const STALE_SERVE_MS = 10 * 60_000;

const staleProfiles = new Map<string, { profile: PublicProfile; at: number }>();

/** The synced player_ranks.rank_name has been observed carrying the numeric
 * level ("24") rather than the in-game Roman form. The game says XXIV, the
 * web says XXIV too — derive it when the stored name isn't Roman already. */
function toRoman(n: number): string {
  if (!Number.isFinite(n) || n < 1 || n > 3999) return String(n);
  const table: Array<[number, string]> = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let out = '';
  let rest = Math.floor(n);
  for (const [value, numeral] of table) {
    while (rest >= value) {
      out += numeral;
      rest -= value;
    }
  }
  return out;
}

function romanizeRankName(rankName: string | null | undefined, level: number): string | null {
  if (rankName && !/^\d+$/.test(rankName)) return rankName; // already a name/Roman
  return level >= 1 ? toRoman(level) : null;
}

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
  const nameKey = rawName.toLowerCase();

  /** Serve the last good build when the database is failing, else the passed
   *  status. Keeps the public page alive through DB flaps (observed 2026-08-20:
   *  Hyperdrive idle-reap storms) with data at most STALE_SERVE_MS old. */
  const staleOr = (status: 503) => {
    const entry = staleProfiles.get(nameKey);
    if (entry && Date.now() - entry.at <= STALE_SERVE_MS) {
      return c.json(
        { ...entry.profile, stale: true },
        200,
        { 'Cache-Control': 'public, max-age=30, s-maxage=60', 'X-Stale-Profile': '1' },
      );
    }
    return c.json({ error: status === 503 ? 'Registry unavailable' : 'Unexpected' }, status);
  };

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
    return staleOr(503);
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

  // Distinguish "no profile row" (a real 404) from "the profile read failed"
  // (an outage that must not masquerade as a missing player).
  let profile: Awaited<ReturnType<typeof buildPublicProfile>> | null;
  try {
    profile = await buildPublicProfile(uuid, canonicalName);
  } catch {
    return staleOr(503);
  }
  if (!profile) {
    return c.json({ error: 'Player not found' }, 404);
  }

  staleProfiles.set(nameKey, { profile, at: Date.now() });
  if (staleProfiles.size > 500) {
    // Bound the map: drop the oldest half — profiles are cheap to rebuild.
    const entries = [...staleProfiles.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [key] of entries.slice(0, Math.floor(entries.length / 2))) {
      staleProfiles.delete(key);
    }
  }

  // Fire-and-forget: a Redis outage must never delay or fail the response.
  void setCachedJson(cacheKey, profile, 60);
  return c.json(profile, 200, { 'Cache-Control': 'public, max-age=30, s-maxage=60' });
});

/** Assemble the public projection. Throws ONLY on a failed core profile read
 *  (an outage); returns null when the uuid genuinely has no profile row (404).
 *  Every optional table degrades to a null / zero default on error — a missing
 *  achievements table must not take the whole profile down (same
 *  degrade-gracefully pattern as the rest of the expansion). */
async function buildPublicProfile(uuid: string, username: string): Promise<PublicProfile | null> {
  // Happy path: ONE round trip. The multi-query shape below makes ~10
  // sequential calls; during Hyperdrive connection flaps every extra call is
  // another window for a dying socket to take the request down (observed
  // 2026-08-20: heavy routes 1101'd an order of magnitude more than 1-query
  // routes). Falls back to the resilient multi-query path on schema gaps.
  try {
    const mega = await query<MegaProfileRow>(MEGA_PROFILE_SQL, [username]);
    const row = mega.rows[0];
    if (row && row.uuid) return profileFromMegaRow(uuid, username, row);
  } catch {
    // Any failure (schema gap on a synced table, connection flap) falls back
    // to the resilient multi-query path below — if the database is truly down
    // it throws there and the caller stale-serves.
  }

  const p = await getPlayerProfile(uuid); // throws propagate → caller staleOr(503)
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
    rankName: romanizeRankName(p.rank?.name, p.rank?.level ?? 0),
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

// ─────────────────────────────────────────────────────────────────────────────
// Single-round-trip aggregate (the happy path). One statement joins everything
// the public profile needs; see buildPublicProfile for why the trip count
// matters. Column types are coerced defensively — pg hands back strings for
// bigint/numeric, and a schema drift on one column must not NaN the payload.
// ─────────────────────────────────────────────────────────────────────────────

interface MegaProfileRow {
  uuid: string | null;
  rank_level: string | number | null;
  rank_name: string | null;
  prestige_level: string | number | null;
  blocks_mined: string | number | null;
  play_time: string | number | null;
  pvp_kills: string | number | null;
  pvp_deaths: string | number | null;
  pvp_trophies: string | number | null;
  denarius_raw: string | number | null;
  civitas_raw: string | number | null;
  koth_wins: string | null;
  legion_name: string | null;
  elo: string | number | null;
  peak_elo: string | number | null;
  ach_count: string | null;
  recent_ach: Array<{ achievement_id: string; completed_at: string | number }> | null;
  online: boolean | null;
  parkour: Array<{ course_id: string; best_time_ms: string | number; completions: string | number }> | null;
}

const MEGA_PROFILE_SQL = `
  WITH me AS (
    SELECT uuid, username FROM player_names WHERE LOWER(username) = LOWER($1) LIMIT 1
  ), bal AS (
    SELECT
      COALESCE((SELECT SUM(balance) FROM currency_balances WHERE uuid = me.uuid AND currency IN ('denarius', 'money')), 0) AS denarius_raw,
      COALESCE((SELECT SUM(balance) FROM currency_balances WHERE uuid = me.uuid AND currency IN ('civitas', 'beacons')), 0) AS civitas_raw
    FROM me
  )
  SELECT
    me.uuid,
    pr.rank_level, pr.rank_name,
    pd.prestige_level,
    ps.blocks_mined, ps.play_time, ps.pvp_kills, ps.pvp_deaths, ps.pvp_trophies,
    bal.denarius_raw, bal.civitas_raw,
    (SELECT SUM(value) FROM leaderboard_stats WHERE uuid = me.uuid AND category = 'KOTH_WINS' AND period = 'ALL_TIME') AS koth_wins,
    (SELECT l.name FROM legion_members m JOIN legions l ON l.name = m.legion_name WHERE m.player_uuid = me.uuid LIMIT 1) AS legion_name,
    e.elo, e.peak_elo,
    (SELECT COUNT(*) FROM player_achievements pa WHERE pa.uuid = me.uuid AND pa.completed) AS ach_count,
    (SELECT json_agg(t) FROM (
       SELECT pa.achievement_id, pa.completed_at FROM player_achievements pa
        WHERE pa.uuid = me.uuid AND pa.completed
        ORDER BY pa.completed_at DESC LIMIT 8
     ) t) AS recent_ach,
    EXISTS (SELECT 1 FROM online_players op WHERE op.uuid = me.uuid) AS online,
    (SELECT json_agg(x) FROM (
       SELECT pr2.course_id, pr2.best_time_ms, pr2.completions FROM parkour_records pr2
        WHERE pr2.player_uuid = me.uuid
        ORDER BY pr2.best_time_ms ASC LIMIT 3
     ) x) AS parkour
  FROM me
  LEFT JOIN player_ranks pr ON pr.uuid = me.uuid
  LEFT JOIN prestige_data pd ON pd.uuid = me.uuid
  LEFT JOIN player_stats ps ON ps.uuid = me.uuid
  LEFT JOIN player_elo e ON e.uuid = me.uuid
  CROSS JOIN bal`;

function num(v: string | number | null | undefined): number {
  const n = typeof v === 'number' ? v : Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : 0;
}

function profileFromMegaRow(uuid: string, username: string, r: MegaProfileRow): PublicProfile {
  const rank = num(r.rank_level);
  // completed_at is epoch-millis and may arrive as a string — sort numerically,
  // then trim to the 6 the payload exposes (SQL pre-limited to 8).
  const recent = (r.recent_ach ?? [])
    .slice()
    .sort((a, b) => num(b.completed_at) - num(a.completed_at))
    .slice(0, 6)
    .map((a) => a.achievement_id);

  return {
    uuid,
    username,
    bedrock: username.startsWith('.'),
    online: Boolean(r.online),
    rank,
    rankName: romanizeRankName(r.rank_name, rank),
    prestige: num(r.prestige_level),
    legion: r.legion_name ?? null,
    // WHOLE-UNIT STORAGE (2026-08-18 / plugin migration V28): balances are stored in WHOLE
    // units — displayed as stored, no ÷100 minor-unit conversion.
    denarius: num(r.denarius_raw),
    civitas: num(r.civitas_raw),
    blocksMined: num(r.blocks_mined),
    playtimeSeconds: num(r.play_time),
    pvpKills: num(r.pvp_kills),
    pvpDeaths: num(r.pvp_deaths),
    trophies: num(r.pvp_trophies),
    kothWins: num(r.koth_wins),
    elo: r.elo == null ? null : { rating: num(r.elo), peak: num(r.peak_elo) },
    achievementCount: num(r.ach_count),
    recentAchievements: recent,
    parkourBests: (r.parkour ?? []).map((p) => ({
      course: p.course_id,
      timeMs: num(p.best_time_ms),
      completions: num(p.completions),
    })),
  };
}
