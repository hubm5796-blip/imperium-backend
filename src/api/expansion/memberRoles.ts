// V6 02-07 (auto-roles): GET /api/v2/member?discord_id= — the one aggregate
// the bot's role-sync engine consumes. Bot-gated (it's a targeted read), one
// round trip joining everything the sync plan needs: link identity, rank,
// prestige, and live donor state.
//
// Donor truth: the plugin-synced donor_ranks table (tier + subscription_type
// + expires_at), NOT the backend's D1 subscription cache — the plugin row is
// what the game itself honors, so the Discord role can never disagree with
// in-game perks. A donor is "active" when a row exists and either never
// expires (PERMANENT) or hasn't expired yet.
import { Hono } from 'hono';
import { query } from '../../db/pool.js';
import { getCachedJson, setCachedJson } from '../../db/redis.js';
import { botTokenMatches } from '../../middleware/auth.js';
import { readRateLimit } from '../../middleware/rateLimit.js';
import type { AppContextVariables } from '../../types/index.js';

type ApiEnv = { Variables: AppContextVariables };

export const memberApi = new Hono<ApiEnv>();

export interface MemberSummary {
  uuid: string;
  discordId: string;
  username: string | null;
  rank: number;
  prestigeLevel: number;
  donor: { tier: string; type: string; active: boolean; expiresAt: string | null } | null;
}

memberApi.get('/member', readRateLimit, async (c) => {
  // Targeted identity read — bot only, same rule as /api/player/profile.
  if (!botTokenMatches(c)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  const discordId = (c.req.query('discord_id') ?? '').trim();
  if (!/^\d{5,25}$/.test(discordId)) {
    return c.json({ error: 'Invalid discord_id' }, 400);
  }

  const cacheKey = `member_summary:${discordId}`;
  const cached = await getCachedJson<MemberSummary>(cacheKey);
  if (cached) return c.json(cached);

  interface MemberRow {
    uuid: string;
    discord_id: string;
    username: string | null;
    rank_level: string | number | null;
    prestige_level: string | number | null;
    donor_tier: string | null;
    donor_type: string | null;
    donor_expires: Date | null;
  }
  let row: MemberRow | undefined;
  try {
    const result = await query<MemberRow>(
      `SELECT dl.uuid, dl.discord_id, pn.username,
              pr.rank_level, pd.prestige_level,
              dr.tier AS donor_tier, dr.subscription_type AS donor_type, dr.expires_at AS donor_expires
         FROM discord_links dl
         LEFT JOIN player_names pn ON pn.uuid = dl.uuid
         LEFT JOIN player_ranks pr ON pr.uuid = dl.uuid
         LEFT JOIN prestige_data pd ON pd.uuid = dl.uuid
         LEFT JOIN donor_ranks dr ON dr.uuid = dl.uuid
        WHERE dl.discord_id = $1
        LIMIT 1`,
      [discordId],
    );
    row = result.rows[0];
  } catch {
    return c.json({ error: 'Registry unavailable' }, 503);
  }

  if (!row) {
    // Not linked — a distinct answer from "backend down": the sync engine
    // treats this as "strip donor/prestige roles", not as retry-later.
    return c.json({ error: 'Not linked' }, 404);
  }

  const num = (v: string | number | null | undefined): number => {
    const n = typeof v === 'number' ? v : Number.parseInt(v ?? '', 10);
    return Number.isFinite(n) ? n : 0;
  };
  const donorActive =
    row.donor_tier != null &&
    (row.donor_expires == null || new Date(row.donor_expires).getTime() > Date.now());

  const summary: MemberSummary = {
    uuid: row.uuid,
    discordId: row.discord_id,
    username: row.username ?? null,
    rank: num(row.rank_level),
    prestigeLevel: num(row.prestige_level),
    donor:
      row.donor_tier != null
        ? {
            tier: row.donor_tier,
            type: row.donor_type ?? 'UNKNOWN',
            active: donorActive,
            expiresAt: row.donor_expires ? new Date(row.donor_expires).toISOString() : null,
          }
        : null,
  };

  // Short TTL: role sync wants timely donor changes, but the nightly audit
  // hammers this endpoint for every linked member — 60s collapses that.
  void setCachedJson(cacheKey, summary, 60);
  return c.json(summary);
});
