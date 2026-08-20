// V6 05-03: web_events tailer — turns plugin-written feed rows into outbound
// webhooks (server-side, the same polling the bot cron used to do). The
// cursor is the last-seen event id, stored in webhook_state; a gap larger
// than the 200-row window just means we skip un-emitted history (webhooks
// are best-effort pushes, not a ledger).
import { logger } from '../utils/logger.js';
import { query } from '../db/pool.js';
import { getState, setState } from './store.js';
import { emit } from './deliver.js';
import { FEED_TYPE_MAP, type OutboundEvent } from './types.js';

const CURSOR_KEY = 'web_events_tailer_cursor';

interface FeedRow {
  id: string | number;
  event_type: string;
  uuid: string;
  message: string;
  at: Date;
}

/**
 * Map one feed row to an outbound event, or null when the row's payload
 * can't produce a meaningful event. The plugin writes human-readable
 * `message` strings; the payload fields ride the message as
 * "name=value name=value" pairs when present (rankup writes from/to).
 */
export function feedRowToEvent(row: FeedRow): OutboundEvent | null {
  const type = FEED_TYPE_MAP[row.event_type];
  if (!type) return null;
  const at = new Date(row.at).toISOString();
  const fields = new Map<string, string>();
  for (const match of row.message.matchAll(/(\w+)=(\S+)/g)) {
    fields.set(match[1]!, match[2]!);
  }
  const username = fields.get('player') ?? row.uuid.slice(0, 8);
  switch (type) {
    case 'player.rankup': {
      const fromRank = Number(fields.get('from'));
      const toRank = Number(fields.get('to'));
      if (!Number.isFinite(toRank)) return null;
      return { type, v: 1, uuid: row.uuid, username, fromRank: Number.isFinite(fromRank) ? fromRank : toRank - 1, toRank, at };
    }
    case 'player.prestige': {
      const prestigeLevel = Number(fields.get('level'));
      if (!Number.isFinite(prestigeLevel)) return null;
      return { type, v: 1, uuid: row.uuid, username, prestigeLevel, at };
    }
    case 'war.result':
      return { type, v: 1, eventId: String(row.id), winnerLegion: fields.get('winner') ?? 'unknown', at };
    case 'season.roll':
      return { type, v: 1, seasonId: String(row.id), name: fields.get('name') ?? 'new season', at };
    default:
      return null;
  }
}

export interface TailerReport {
  scanned: number;
  emitted: number;
}

/** One tailer pass (called from the cron). Never throws. */
export async function runEventsTailer(): Promise<TailerReport> {
  const report: TailerReport = { scanned: 0, emitted: 0 };
  let cursor: string | null = null;
  try {
    cursor = await getState(CURSOR_KEY);
  } catch {
    cursor = null; // fresh start — first pass emits nothing new beyond the window
  }

  let rows: FeedRow[];
  try {
    rows = await query<FeedRow>(
      `SELECT id, event_type, uuid, message, at
         FROM web_events
        WHERE ($1::text IS NULL OR id::text > $1)
        ORDER BY id ASC
        LIMIT 200`,
      [cursor],
    ).then((r) => r.rows);
  } catch (err) {
    logger.warn({ err: String(err) }, 'webhook tailer: web_events unavailable');
    return report;
  }

  let lastId: string | null = cursor;
  for (const row of rows) {
    report.scanned += 1;
    lastId = String(row.id);
    const event = feedRowToEvent(row);
    if (!event) continue;
    try {
      const queued = await emit(event);
      report.emitted += queued;
    } catch (err) {
      logger.error({ err: String(err), eventId: String(row.id) }, 'webhook tailer: emit failed for one row');
    }
  }

  if (lastId !== cursor) {
    try {
      await setState(CURSOR_KEY, lastId ?? '');
    } catch (err) {
      logger.warn({ err: String(err) }, 'webhook tailer: cursor write failed (will rescan next tick)');
    }
  }
  return report;
}
