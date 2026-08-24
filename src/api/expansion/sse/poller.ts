// V6 05-02: SSE topic poller (the server side of the live feed).
//
// Model (per the blueprint): every connection runs its own loop
// `while (open) { await sleep(interval); frame-if-changed }`, but the actual
// data pull goes through sharedSnapshot() — an in-flight promise dedupe so N
// connections on one isolate produce ONE upstream query per topic per tick.
// No setInterval (Workers-safe); the last connection out leaves the cached
// snapshot behind, which also serves as the Last-Event-ID replay source until
// the next subscriber arrives.
//
// Each topic also keeps a small ring of recent frames for Last-Event-ID
// resume: a client that reconnects with the id of the last frame it saw gets
// the frames it missed (best-effort, per-isolate — after an isolate recycle
// the client simply re-syncs from the next live frame).
import { getOnlinePlayerCount } from '../../../db/redis.js';
import { query } from '../../../db/pool.js';

export interface TopicDefinition {
  name: string;
  /** Poll cadence per connection loop. */
  intervalMs: number;
  /** Pull the current snapshot. Throws on source failure — the loop keeps the
   *  last frame and retries next tick (source outages don't kill streams). */
  fetch(): Promise<unknown>;
  /** Suppress no-op frames: true when the two snapshots would produce an
   *  identical frame. Errors/undefined data on either side counts as same. */
  same(a: unknown, b: unknown): boolean;
}

interface TopicState {
  def: TopicDefinition;
  /** In-flight snapshot pull (dedupe) + last completed snapshot. */
  inFlight: Promise<unknown> | null;
  last: { snapshot: unknown; at: number } | null;
  /** Ring of [seq, frame] for Last-Event-ID replay. */
  ring: Array<{ seq: number; event: string; data: string }>;
  seq: number;
}

const RING_SIZE = 50;

const registry = new Map<string, TopicState>();

function stateFor(def: TopicDefinition): TopicState {
  let state = registry.get(def.name);
  if (!state) {
    state = { def, inFlight: null, last: null, ring: [], seq: 0 };
    registry.set(def.name, state);
  }
  return state;
}

/**
 * Pull a topic's snapshot at most once per tick regardless of how many
 * connections ask (in-flight promise dedupe). On failure the previous
 * snapshot is kept — a source outage pauses frames, it never drops them.
 */
export async function sharedSnapshot(def: TopicDefinition): Promise<unknown> {
  const state = stateFor(def);
  if (state.inFlight) return state.inFlight;
  const pull = (async () => {
    try {
      const snapshot = await def.fetch();
      state.last = { snapshot, at: Date.now() };
      return snapshot;
    } finally {
      state.inFlight = null;
    }
  })();
  state.inFlight = pull;
  return pull;
}

/** Build (and ring) the next frame for a topic if the snapshot changed.
 *  Returns null when unchanged (no frame this tick). */
export function frameIfChanged(def: TopicDefinition): { seq: number; event: string; data: string } | null {
  const state = stateFor(def);
  const last = state.last;
  if (!last) return null;
  const previous = state.ring.length > 0 ? state.ring[state.ring.length - 1] : null;
  // Compare against the last FRAMED snapshot: parse the previous frame's data
  // is wasteful; instead keep the framed snapshot on the ring entry.
  const framedSnapshot = (state as TopicState & { framed?: unknown }).framed;
  if (previous && def.same(framedSnapshot, last.snapshot)) return null;
  state.seq += 1;
  const entry = {
    seq: state.seq,
    event: def.name,
    data: JSON.stringify(last.snapshot),
  };
  (state as TopicState & { framed?: unknown }).framed = last.snapshot;
  state.ring.push(entry);
  if (state.ring.length > RING_SIZE) state.ring.shift();
  return entry;
}

/** Frames with seq > afterSeq, for Last-Event-ID resume. Empty when unknown. */
export function framesAfter(def: TopicDefinition, afterSeq: number): Array<{ seq: number; event: string; data: string }> {
  const state = registry.get(def.name);
  if (!state) return [];
  return state.ring.filter((f) => f.seq > afterSeq);
}

/** Test/ops seam: drop all topic state (fresh rings, fresh snapshots). */
export function resetPollers(): void {
  registry.clear();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Topic definitions (v1 public set)
// ─────────────────────────────────────────────────────────────────────────────

/** status (15s): Redis heartbeat — is the server up, how many online. */
export const STATUS_TOPIC: TopicDefinition = {
  name: 'status',
  intervalMs: 15_000,
  fetch: async () => {
    const count = await getOnlinePlayerCount();
    return { online: count !== null, playerCount: count ?? 0 };
  },
  same: (a, b) => {
    const x = a as { online?: boolean; playerCount?: number } | null;
    const y = b as { online?: boolean; playerCount?: number } | null;
    return x?.online === y?.online && x?.playerCount === y?.playerCount;
  },
};

/** season (120s): active season identity + live festival chip. */
export const SEASON_TOPIC: TopicDefinition = {
  name: 'season',
  intervalMs: 120_000,
  fetch: async () => {
    try {
      const season = await query<{ season_id: string; name: string }>(
        'SELECT season_id, name FROM seasonal_data WHERE active = TRUE ORDER BY season_id DESC LIMIT 1',
        [],
      );
      const festival = await query<{ name: string }>(
        'SELECT name FROM festivals WHERE active = TRUE LIMIT 1',
        [],
      ).catch(() => ({ rows: [] as { name: string }[] }));
      return {
        season: season.rows[0] ? { id: season.rows[0].season_id, name: season.rows[0].name } : null,
        festival: festival.rows[0]?.name ?? null,
      };
    } catch {
      return { season: null, festival: null, unavailable: true };
    }
  },
  same: (a, b) => JSON.stringify(a) === JSON.stringify(b),
};

/** events (30s): the plugin's web_events tail. Incremental by id-cursor so a
 *  frame carries ONLY the rows new since the previous frame (a rolling time
 *  window would re-frame on drift as rows age out). At-least-once per
 *  connection; the web_events row id in each entry lets clients dedupe.
 *  First poll on a fresh isolate positions the cursor at the newest row
 *  (history is the REST feed's job, not the live stream's). */
let eventsCursor: number | null = null;
export const EVENTS_TOPIC: TopicDefinition = {
  name: 'events',
  intervalMs: 30_000,
  fetch: async () => {
    try {
      if (eventsCursor === null) {
        const max = await query<{ max: string | null }>('SELECT MAX(id)::text AS max FROM web_events', []);
        eventsCursor = Number(max.rows[0]?.max ?? 0);
        return { events: [] };
      }
      const rows = await query<{ id: string | number; event_type: string; uuid: string; message: string }>(
        `SELECT id, event_type, uuid, message
           FROM web_events
          WHERE id > $1
          ORDER BY id ASC
          LIMIT 100`,
        [eventsCursor],
      );
      if (rows.rows.length > 0) {
        eventsCursor = Number(rows.rows[rows.rows.length - 1]!.id);
      }
      return { events: rows.rows.map((r) => ({ id: String(r.id), type: r.event_type, message: r.message })) };
    } catch {
      return { events: [] };
    }
  },
  same: (a, b) => (Array.isArray((b as { events?: unknown[] })?.events) ? ((b as { events: unknown[] }).events.length === 0) : true),
};

/** economy (60s): denarius supply + 24h flow shares. */
export const ECONOMY_TOPIC: TopicDefinition = {
  name: 'economy',
  intervalMs: 60_000,
  fetch: async () => {
    try {
      const supply = await query<{ total: string | null }>(
        "SELECT SUM(balance)::text AS total FROM currency_balances WHERE currency IN ('denarius', 'money')",
        [],
      );
      // WHOLE-UNIT STORAGE (2026-08-18 / plugin migration V28): SUM(balance) is already whole units.
      return { denariusSupply: Number(supply.rows[0]?.total ?? 0) };
    } catch {
      return { unavailable: true };
    }
  },
  same: (a, b) => JSON.stringify(a) === JSON.stringify(b),
};

export const PUBLIC_TOPICS: TopicDefinition[] = [STATUS_TOPIC, SEASON_TOPIC, EVENTS_TOPIC, ECONOMY_TOPIC];

export function topicByName(name: string): TopicDefinition | null {
  return PUBLIC_TOPICS.find((t) => t.name === name) ?? null;
}
