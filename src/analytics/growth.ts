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
import { readCcuNow, readCcuPeak7d } from './ccu.js';
import {
  addDays,
  computeSourceRetention,
  dayKey,
  dayStartMs,
  listSeenRows,
  loadActiveDays,
  type CohortSlice,
  type SourceRetention,
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
 * S2-G02 — the ONE fold read both growth surfaces share: players + presence
 * days → joins-by-source for the window + the whole-window per-source
 * retention slices. Extracted verbatim from buildGrowthOverview when the
 * public snapshot needed the same numbers, so the two surfaces can never
 * drift (the overview's pins are the behavior proof of this refactor).
 * Section-isolated: a fold failure reads as null, never a thrown page.
 */
export interface FoldStats {
  joins: {
    total: number;
    by_source: GrowthSourceCount[];
  };
  retention: SourceRetention;
}

export async function readFoldStats(fromDay: string, toDay: string, nowMs: number): Promise<FoldStats | null> {
  return section('joins+retention', async () => {
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
  const fold = await readFoldStats(fromDay, toDay, nowMs);

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

/* ── S2-G02: the public compact snapshot ─────────────────────────────────── */

/**
 * The season clock anchor: the plugin's seasons.calendar start-at
 * (config.yml, owner decisions #17/#19 — relaunch 2026-11-07, the Season 1
 * window opens 2026-11-14T20:00:00Z with the drops at weeks 2/6/10). The
 * calendar values are the owner's to shift; if they move start-at, this
 * constant moves with it in the same season (one line, stated in the payload
 * as season_starts_at so a mismatch is visible, never silent).
 */
export const SEASON_2_START_AT_MS = Date.parse('2026-11-14T20:00:00Z');

/** The snapshot's by-source list is capped at 5 (the task's own shape). */
export const SNAPSHOT_TOP_SOURCES = 5;

export interface GrowthSnapshotSourceCount {
  source: string;
  joins: number;
}

export interface GrowthSnapshot {
  /** UTC day the snapshot was generated (joins_7d includes this day). */
  date: string;
  generated_at: string;
  /** Whole UTC days since the season window opened; 0 before it. */
  season_days_elapsed: number;
  /** The anchor season_days_elapsed counts from — stated, not implied. */
  season_starts_at: string;
  /** Live concurrent players, or null when every status source failed. */
  ccu_now: number | null;
  /** Highest sampled daily peak over the 7 UTC days ending `date`; null
   * until the sampler (S2-G02 cron leg) has at least one answered sample. */
  ccu_peak_7d: number | null;
  joins_7d: {
    window: { from: string; to: string };
    total: number | null;
    by_source: GrowthSnapshotSourceCount[];
  };
  /** D1 of the join cohort over the 7 COMPLETE days ending yesterday (every
   * member's day-1 window has closed — the pinned D07 definition). null
   * pre-launch (no joins yet) or when the fold source is unavailable. */
  d1_cohort: { window: { from: string; to: string }; cohort_size: number; d1: number | null } | null;
  /** Per-cell honesty markers (the C13 rule: every cell states its source). */
  sources: Record<string, string>;
}

/**
 * S2-G02 — the PUBLIC compact snapshot the transparency posts cite. Same
 * D1 fold, same attribution-free join counts, same honest-empty rules as the
 * staff overview, projected down to counts/rates ONLY: no uuids, no names,
 * no per-player rows exist anywhere in this payload (test-pinned).
 *
 * Windows:
 *   joins_7d — the 7 UTC days ending TODAY (inclusive): the fresh number a
 *     weekly post wants, today's joins included.
 *   d1_cohort — the 7 COMPLETE days ending YESTERDAY: by construction every
 *     member's day-1 window has closed, so the pinned "null while the window
 *     is open, never a partial number" definition yields a real rate (or an
 *     honest null when there is no cohort at all — pre-launch).
 */
export async function buildGrowthSnapshot(nowMs: number): Promise<GrowthSnapshot> {
  const today = dayKey(nowMs);
  const joinsFrom = dayKey(nowMs - 6 * DAY_MS);
  const cohortFrom = dayKey(nowMs - 7 * DAY_MS);
  const cohortTo = dayKey(nowMs - 1 * DAY_MS);

  const joinsFold = await readFoldStats(joinsFrom, today, nowMs);
  const cohortFold = await readFoldStats(cohortFrom, cohortTo, nowMs);

  // CCU: live read + the stored peak series, isolated independently.
  const ccuNow = await section('ccu_now', () => readCcuNow());
  const ccuPeak = await section('ccu_peak_7d', () => readCcuPeak7d(nowMs));

  const overall = cohortFold?.retention.overall ?? null;
  const seasonDays = Math.max(0, Math.floor((nowMs - SEASON_2_START_AT_MS) / DAY_MS));

  return {
    date: today,
    generated_at: new Date(nowMs).toISOString(),
    season_days_elapsed: seasonDays,
    season_starts_at: new Date(SEASON_2_START_AT_MS).toISOString(),
    ccu_now: ccuNow?.count ?? null,
    ccu_peak_7d: ccuPeak,
    joins_7d: {
      window: { from: joinsFrom, to: today },
      total: joinsFold?.joins.total ?? null,
      by_source: (joinsFold?.joins.by_source ?? [])
        .slice(0, SNAPSHOT_TOP_SOURCES)
        .map((c) => ({ source: c.source, joins: c.count })),
    },
    d1_cohort:
      overall && overall.size > 0
        ? { window: { from: cohortFrom, to: cohortTo }, cohort_size: overall.size, d1: overall.d1 }
        : null,
    sources: {
      ccu_now: ccuNow
        ? `live: ${ccuNow.source}`
        : 'unavailable — every online-count source (Redis heartbeat, Postgres snapshot, game-MySQL snapshot) failed or timed out',
      ccu_peak_7d: ccuPeak === null ? 'no answered sample in the 7-day window yet (series starts with the S2-G02 deploy)' : 'ccu_daily_peak (D1) — MAX of per-minute sampled daily peaks',
      joins_7d: joinsFold
        ? 'retention_player_seen (daily fold from the game MySQL) — counts only, no player rows in this payload'
        : 'unavailable — retention fold failed',
      d1_cohort: overall
        ? 'retention fold: share of the join cohort active on join-day+1; window bounded to closed days'
        : 'null — no join cohort in the window (pre-launch) or the fold source is unavailable',
      season_days_elapsed: `whole UTC days since season_starts_at (the plugin seasons.calendar start-at)`,
    },
  };
}
