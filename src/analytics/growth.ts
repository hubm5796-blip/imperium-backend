/**
 * S2-D12 (Lane D) — the growth-metrics stitch behind GET
 * /api/v2/admin/growth/overview: ONE owner-readable payload shaped like the
 * weekly table in docs/season-2/06-MARKETING-AND-GROWTH.md §6, assembled
 * from the endpoints that already exist. A READ-ONLY composite; nothing here
 * writes, and every cell states what it derives from — an empty pre-launch
 * cell is served as an honest zero/null with its source marker, never
 * fabricated (the queue row's acceptance rule).
 *
 * §6 row -> cells:
 *   1. unique site visitors -> connect attempts
 *        attribution_intent by source (E09). Each intent row IS one distinct
 *        visitor IP hash (latest tag wins), so the counts are the honest
 *        visitor->attempt proxy the backend holds; true page-view analytics
 *        live frontend-side. Rows live 48h and are pruned on write — the
 *        payload DISCLOSES that limit; the durable history is claims + the
 *        retention fold.
 *   2. server-list referral by list
 *        the vote-<list> slices of intents, claims, and fold joins.
 *   3. Discord joins -> in-game joins
 *        discord_links rows created in the window (Postgres — a Discord
 *        account that went on to link an in-game account). GUILD join
 *        counts are not tracked anywhere in the backend (no table carries
 *        guild-member-add timestamps) — served as null with the marker,
 *        never invented.
 *   4. D1/D7/D30 by acquisition source
 *        computeSourceRetention over the retention fold (first_seen join
 *        day + presence days). This derives from retention_player_seen /
 *        retention_player_days, NOT from attribution_claim: claims prove
 *        attribution, the fold proves presence. dN is null while the
 *        cohort's window is open (the pinned D07 definition).
 *   5. CAC vs ARPPU — §6 lists it as a manual monthly metric; served as
 *        null with the marker, out of scope by design.
 *
 * Degradation: the launchday doctrine — each source read is isolated; a
 * dead source nulls its OWN cells and marks them 'unavailable' in
 * `sources` while the page still loads whole.
 */
import { listAttributionIntents, ATTRIBUTION_INTENT_WINDOW_MS, type AttributionSourceCount } from './attribution.js';
import {
  addDays,
  computeSourceRetention,
  dayKey,
  dayStartMs,
  listSeenRows,
  loadActiveDays,
  type CohortSlice,
} from './retention.js';
import { query } from '../db/pool.js';
import { logger } from '../utils/logger.js';

const DAY_MS = 86_400_000;

export interface GrowthSourceCount {
  source: string;
  count: number;
}

export interface GrowthServerListSlice {
  list: string;
  count: number;
}

export interface GrowthDiscordBridge {
  links_created_in_window: number;
  /** Honestly null: no backend table records Discord guild joins. */
  discord_guild_joins: null;
  note: string;
}

export interface GrowthRetentionBySource {
  overall: CohortSlice;
  by_source: Record<string, CohortSlice>;
  derivation: string;
}

export interface GrowthOverview {
  generated_at: string;
  from: string;
  to: string;
  window_days: number;
  connect_attempts: {
    by_source: GrowthSourceCount[];
    days: Array<{ day: string; by_source: Record<string, number> }>;
    intent_window_hours: number;
    note: string;
  } | null;
  joins: {
    /** Every first join the fold knows in-window, 'direct' included (the full denominator). */
    total: number | null;
    by_source: GrowthSourceCount[] | null;
    /** The E09 one-shot claim record — exists only for joins after the plugin half shipped. */
    claims_by_source: GrowthSourceCount[] | null;
  };
  server_lists: {
    intent_copies_by_list: GrowthServerListSlice[] | null;
    claimed_joins_by_list: GrowthServerListSlice[] | null;
    joins_by_list: GrowthServerListSlice[] | null;
  };
  discord_bridge: GrowthDiscordBridge | null;
  retention_by_source: GrowthRetentionBySource | null;
  cac_vs_arppu: null;
  sources: Record<string, string>;
}

/** One isolated source read — failure nulls the section, never the page. */
async function section<T>(name: string, read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    logger.error({ err: String(err), section: name }, 'growth: section source failed');
    return null;
  }
}

/** Postgres count of discord_links rows created in [fromMs, toMs). */
async function countDiscordLinks(fromMs: number, toMs: number): Promise<number> {
  const res = await query<{ n: number | string }>(
    `SELECT COUNT(*)::int AS n FROM discord_links WHERE created_at >= $1 AND created_at < $2`,
    [new Date(fromMs).toISOString(), new Date(toMs).toISOString()],
  );
  return Number(res.rows[0]?.n ?? 0);
}

/** The vote-<list> slice of a by-source summary, prefix stripped (§6 row 2). */
function voteSlices(counts: AttributionSourceCount[] | null): GrowthServerListSlice[] | null {
  if (counts === null) return null;
  return counts
    .filter((c) => c.source.startsWith('vote-'))
    .map((c) => ({ list: c.source.slice('vote-'.length), count: c.count }));
}

/**
 * The §6 stitch. `fromDay`/`toDay` are inclusive UTC days; `nowMs` is
 * injectable so tests pin cohort windows exactly.
 */
export async function buildGrowthOverview(fromDay: string, toDay: string, nowMs: number): Promise<GrowthOverview> {
  const toMs = dayStartMs(toDay) + DAY_MS; // `to` is inclusive
  const windowDays = Math.round((toMs - dayStartMs(fromDay)) / DAY_MS);

  // Attribution read (D1): intents + claims in one pass — they share the
  // table family and the window, so they fail together if D1 is down.
  const attribution = await section('connect_attempts+claims', () => listAttributionIntents(fromDay, toDay));

  // Retention fold read (D1): players + presence days → joins by source +
  // the d1/d7/d30-by-source cell. The day window extends past `to` so a d30
  // window that closes after `to` can still be evaluated (the cohorts
  // route's own headroom).
  const fold = await section('joins+retention', async () => {
    const players = await listSeenRows();
    const active = await loadActiveDays(dayKey(dayStartMs(fromDay) - 365 * DAY_MS), addDays(toDay, 35));
    const inWindow = players.filter((p) => {
      const joinDay = dayKey(p.first_seen_ms);
      return joinDay >= fromDay && joinDay <= toDay;
    });
    const bySource = new Map<string, number>();
    for (const p of inWindow) bySource.set(p.source, (bySource.get(p.source) ?? 0) + 1);
    const joins = {
      total: inWindow.length,
      by_source: [...bySource.entries()]
        .map(([source, count]) => ({ source, count }))
        .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source)),
    };
    const retention = computeSourceRetention(players, active, { from: fromDay, to: toDay, nowMs });
    return { joins, retention };
  });

  // Discord bridge (Postgres): independent store, independent failure.
  const discordLinks = await section('discord_links', () => countDiscordLinks(dayStartMs(fromDay), toMs));

  const sources: Record<string, string> = {
    connect_attempts:
      attribution === null
        ? 'unavailable'
        : 'attribution_intent (D1) — distinct visitor IP hashes, latest tag wins, 48h TTL',
    joins: `by_source: ${
      fold === null ? 'unavailable' : 'retention_player_seen (daily fold from the game MySQL)'
    }; claims_by_source: ${attribution === null ? 'unavailable' : 'attribution_claim (D1, E09 one-shot)'}`,
    server_lists: 'derived: vote-<list> slices of connect_attempts / claims / the retention fold',
    'discord_bridge.links': discordLinks === null ? 'unavailable' : 'discord_links (Postgres) — links created in window',
    'discord_bridge.guild_joins':
      'not tracked in the backend — Discord guild-join timestamps live bot-side; no backend table carries them',
    retention_by_source:
      fold === null
        ? 'unavailable'
        : 'retention_player_seen (join day) + retention_player_days (active days), folded daily from the game MySQL',
    cac_vs_arppu: 'manual monthly metric (06 §6) — out of scope for this endpoint',
  };

  return {
    generated_at: new Date(nowMs).toISOString(),
    from: fromDay,
    to: toDay,
    window_days: windowDays,
    connect_attempts:
      attribution === null
        ? null
        : {
            by_source: attribution.intents.sources,
            days: attribution.intents.days,
            intent_window_hours: ATTRIBUTION_INTENT_WINDOW_MS / 3_600_000,
            note:
              'attribution_intent counts distinct visitor IP hashes (one row per hash, latest tag wins) — ' +
              'the backend visitor->connect-attempt proxy. Rows live 48h and are pruned on write, so a window ' +
              'older than ~48h reads empty by design; the durable join history is claims + the retention fold. ' +
              'True page-view analytics live frontend-side and are not part of this number.',
          },
    joins: {
      total: fold?.joins.total ?? null,
      by_source: fold?.joins.by_source ?? null,
      claims_by_source: attribution?.claims.sources ?? null,
    },
    server_lists: {
      intent_copies_by_list: voteSlices(attribution?.intents.sources ?? null),
      claimed_joins_by_list: voteSlices(attribution?.claims.sources ?? null),
      joins_by_list: voteSlices(fold?.joins.by_source ?? null),
    },
    discord_bridge:
      discordLinks === null
        ? null
        : {
            links_created_in_window: discordLinks,
            discord_guild_joins: null,
            note:
              'links_created_in_window counts discord_links rows created in the window — a Discord account ' +
              'that went on to link an in-game account, the bridge conversion the backend can actually see. ' +
              'Discord GUILD join counts are not tracked backend-side (null), so guild->game conversion ' +
              'cannot be computed from this payload.',
          },
    retention_by_source: fold
      ? {
          overall: fold.retention.overall,
          by_source: fold.retention.by_source,
          derivation:
            'dN = share of the source’s join cohort active on join-day+N; join day from ' +
            'retention_player_seen.first_seen, active days from retention_player_days (days with economy ' +
            'activity), both folded daily from the game MySQL. null = the cohort’s dN window has not closed ' +
            '(a partial window is never presented as data).',
        }
      : null,
    cac_vs_arppu: null,
    sources,
  };
}
