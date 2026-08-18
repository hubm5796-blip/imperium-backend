// 12a expansion: season endpoints —
//   GET /api/seasons/current   (current season + 7-day event calendar + live festivals)
//   GET /api/seasons/hall/:id  (season hall of fame)
//
// Data sources:
//  - seasonal_data: LIVE (plugin-owned, SeasonService maintains it).
//  - events_calendar / festivals / season_hall: specced tables the plugin
//    hasn't created yet — each read is independent and degrades to empty with
//    available:false so the endpoint stays useful the moment the plugin lands
//    the table (see docs/api.md for the expected schemas).
import { Hono } from 'hono';
import { readRateLimit } from '../../middleware/rateLimit.js';
import { query } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { swrJson } from './cache.js';
import type { AppContextVariables } from '../../types/index.js';

type ApiEnv = { Variables: AppContextVariables };

export const seasonsApi = new Hono<ApiEnv>();

/** `id` must be a season id slug (matches seasonal_data.season_id VARCHAR(32)). */
const SEASON_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Fetch-and-degrade: an unqueryable table (typically not created yet) yields
 * { rows: [], available: false } instead of failing the whole request. The
 * frontend can distinguish "no events scheduled" from "calendar not wired yet".
 */
async function softRows<T extends Record<string, unknown>>(label: string, sql: string, params: unknown[]): Promise<{ rows: T[]; available: boolean }> {
  try {
    const result = await query<T>(sql, params);
    return { rows: result.rows, available: true };
  } catch (err) {
    logger.warn({ err, label }, 'Table unavailable on seasons endpoint — degrading to empty');
    return { rows: [], available: false };
  }
}

/** Discord-bot-facing event types derived from events_calendar.kind (12c). */
const DISCORD_EVENT_KINDS = new Set(['war', 'colosseum']);

/**
 * GET /api/seasons/current — public, SWR-cached (60s fresh / 5min stale).
 * Shape:
 *   { season: {seasonId, name, startsAt, endsAt, economyReset} | null,
 *     calendar: { available, events: [{id, name, kind, startsAt, endsAt}] },
 *     festivals: { available, live: [{id, name, startsAt, endsAt}] },
 *     events: [{id, type: 'war'|'colosseum', name, startsAt, signupDeadline?}],
 *     festival: {id, name, active, endsAt} | null }
 *
 * `events` + `festival` are the 12c Discord-worker sections: `events` filters
 * the same calendar rows to the kinds the bot schedules notifications for
 * (war 30/5-min warnings, colosseum signup deadlines — `signupDeadline` from
 * the row's payload JSONB), and `festival` is the single live festival or
 * null. Both degrade independently exactly like their parent sections: a
 * missing events_calendar yields events: [] and a missing festivals table
 * yields festival: null.
 */
seasonsApi.get('/current', readRateLimit, async (c) => {
  try {
    return await swrJson(c, 'seasons:current:v2', async () => {
      const seasonRows = await query<{
        season_id: string;
        name: string;
        starts_at: Date | null;
        start_date: Date | null;
        ends_at: Date | null;
        end_date: Date | null;
        economy_reset: boolean;
      }>(
        `SELECT season_id, name, starts_at, start_date, ends_at, end_date, economy_reset
           FROM seasonal_data
          WHERE active = TRUE
          ORDER BY season_id DESC
          LIMIT 1`,
        [],
      );

      const calendar = await softRows<{
        id: number | string;
        name: string;
        kind: string;
        starts_at: Date;
        ends_at: Date;
        signup_deadline: Date | string | null;
      }>(
        'events_calendar',
        `SELECT id, name, kind, starts_at, ends_at, payload->>'signup_deadline' AS signup_deadline
           FROM events_calendar
          WHERE ends_at >= NOW() AND starts_at <= NOW() + INTERVAL '7 days'
          ORDER BY starts_at
          LIMIT 50`,
        [],
      );

      const festivals = await softRows<{ id: number | string; name: string; starts_at: Date; ends_at: Date }>(
        'festivals',
        `SELECT id, name, starts_at, ends_at
           FROM festivals
          WHERE active = TRUE AND starts_at <= NOW() AND ends_at >= NOW()
          ORDER BY ends_at
          LIMIT 10`,
        [],
      );

      const seasonRow = seasonRows.rows[0];

      // 12c sections: war/colosseum rows with signup deadlines for the bot.
      const discordEvents = calendar.rows
        .filter((e) => DISCORD_EVENT_KINDS.has(e.kind))
        .map((e) => ({
          id: e.id,
          type: e.kind as 'war' | 'colosseum',
          name: e.name,
          startsAt: e.starts_at,
          ...(e.signup_deadline != null ? { signupDeadline: e.signup_deadline } : {}),
        }));

      const liveFestival = festivals.rows[0];

      return {
        season: seasonRow
          ? {
              seasonId: seasonRow.season_id,
              name: seasonRow.name,
              startsAt: seasonRow.starts_at ?? seasonRow.start_date,
              endsAt: seasonRow.ends_at ?? seasonRow.end_date,
              economyReset: Boolean(seasonRow.economy_reset),
            }
          : null,
        calendar: {
          available: calendar.available,
          events: calendar.rows.map((e) => ({
            id: e.id,
            name: e.name,
            kind: e.kind,
            startsAt: e.starts_at,
            endsAt: e.ends_at,
          })),
        },
        festivals: {
          available: festivals.available,
          live: festivals.rows.map((f) => ({
            id: f.id,
            name: f.name,
            startsAt: f.starts_at,
            endsAt: f.ends_at,
          })),
        },
        events: discordEvents,
        festival: liveFestival
          ? {
              id: liveFestival.id,
              name: liveFestival.name,
              active: true,
              endsAt: liveFestival.ends_at,
            }
          : null,
      };
    });
  } catch (err) {
    logger.error({ err }, 'seasons/current failed');
    return c.json({ error: 'Database unavailable' }, 503);
  }
});

/**
 * GET /api/seasons/hall/:id — public, SWR-cached. Reads season_hall
 * (specced; plugin creates it when hall-of-fame snapshots land). Until then:
 * available:false + empty entries.
 */
seasonsApi.get('/hall/:id', readRateLimit, async (c) => {
  const seasonId = c.req.param('id') ?? '';
  if (!SEASON_ID_PATTERN.test(seasonId)) {
    return c.json({ error: 'Invalid season id' }, 400);
  }
  try {
    return await swrJson(c, `seasons:hall:${seasonId}:v1`, async () => {
      const hall = await softRows<{
        category: string;
        rank: number;
        uuid: string;
        value: string;
        username: string | null;
      }>(
        'season_hall',
        `SELECT h.category, h.rank, h.uuid, h.value::text, pn.username
           FROM season_hall h
           LEFT JOIN player_names pn ON h.uuid = pn.uuid
          WHERE h.season_id = $1
          ORDER BY h.category, h.rank
          LIMIT 500`,
        [seasonId],
      );
      return {
        seasonId,
        available: hall.available,
        entries: hall.rows.map((row) => ({
          category: row.category,
          rank: Number(row.rank),
          uuid: row.uuid,
          username: row.username ?? row.uuid,
          value: Number(row.value ?? 0),
        })),
      };
    });
  } catch (err) {
    logger.error({ err, seasonId }, 'seasons/hall failed');
    return c.json({ error: 'Database unavailable' }, 503);
  }
});
