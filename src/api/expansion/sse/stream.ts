// V6 05-02: GET /api/v2/events/stream — the SSE transport.
//
// One connection per client; each connection's loop pulls shared snapshots
// (per-isolate dedupe in poller.ts) and writes frames only when a topic's
// data changed. Keepalive comment frames every 25s keep proxies from idling
// the stream; connections self-close with `event: bye` at the 10-minute cap
// (EventSource reconnects transparently, replaying missed frames via
// Last-Event-ID). Public topics only in v1 — the private `orders` topic
// arrives with the store-delivery UI (04-WEB/02).
//
// ── RESUME SEMANTICS (documented, B-24) ────────────────────────────────────
// Last-Event-ID is honored from the HEADER ONLY (seqs in query strings end up
// in access logs/proxies — that variant is gone). Replay is BEST-EFFORT and
// PER-ISOLATE: each isolate keeps its own ring (50 frames/topic) and its own
// seq counter, first positioned at the newest row. A client that reconnects
// onto a different isolate (recycle, second PoP) may see a seq reset, a gap,
// or duplicated frames — there is no cross-isolate cursor in v1. Consumers
// treat `events` entries as at-least-once and dedupe on the carried
// web_events id; the REST feed (/api/events) is the history source. The
// `events` topic deliberately strips player uuids (the REST feed exposes
// them to authenticated callers only) — that disclosure split is intentional.
//
// ── CONNECTION DISCIPLINE (B-24) ───────────────────────────────────────────
// The route is rate-limited like every neighbor (readRateLimit) and capped:
// MAX_STREAMS_PER_IP concurrent streams per client IP (429 + Retry-After),
// MAX_STREAMS_PER_ISOLATE per isolate (503 — an isolate-level valve, not a
// client error). A client that stops reading while the server keeps framing
// would otherwise buffer unboundedly inside the stream — every write is
// stall-bounded (WRITE_STALL_MS) and a stalled consumer gets its connection
// aborted instead of a memory leak.
import { Hono } from 'hono';
import { logger } from '../../../utils/logger.js';
import { clientIp, readRateLimit } from '../../../middleware/rateLimit.js';
import {
  PUBLIC_TOPICS,
  frameIfChanged,
  framesAfter,
  sharedSnapshot,
  sleep,
  topicByName,
  type TopicDefinition,
} from './poller.js';
import type { AppContextVariables } from '../../../types/index.js';

type ApiEnv = { Variables: AppContextVariables };

export const sseApi = new Hono<ApiEnv>();

const KEEPALIVE_MS = 25_000;
const CONNECTION_CAP_MS = 10 * 60_000;
const FIRST_FRAME_DELAY_MS = 250;
const WRITE_STALL_MS = 30_000;
const MAX_STREAMS_PER_IP = 5;
const MAX_STREAMS_PER_ISOLATE = 100;

// ── concurrent-connection accounting (per isolate; acquire/release brackets pump) ──
let openTotal = 0;
const openByIp = new Map<string, number>();

/** Test seam: current stream-pressure counters. */
export function __streamPressure(): { total: number; byIp: Record<string, number> } {
  const byIp: Record<string, number> = {};
  for (const [ip, n] of openByIp) byIp[ip] = n;
  return { total: openTotal, byIp };
}

/** Test seam: reset the pressure counters between tests. */
export function __resetStreamPressure(): void {
  openTotal = 0;
  openByIp.clear();
}

function acquireStream(ip: string): void {
  openTotal += 1;
  openByIp.set(ip, (openByIp.get(ip) ?? 0) + 1);
}

function releaseStream(ip: string): void {
  openTotal = Math.max(0, openTotal - 1);
  const n = (openByIp.get(ip) ?? 1) - 1;
  if (n <= 0) openByIp.delete(ip);
  else openByIp.set(ip, n);
}

interface ParsedTopics {
  topics: TopicDefinition[];
  invalid: string[];
}

function parseTopics(raw: string | undefined): ParsedTopics {
  const requested = (raw ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
  const list = requested.length === 0 ? ['status'] : requested;
  const topics: TopicDefinition[] = [];
  const invalid: string[] = [];
  for (const name of list) {
    const def = topicByName(name);
    if (def) topics.push(def);
    else invalid.push(name);
  }
  return { topics, invalid };
}

function sseFrame(event: string, id: number | string, data: unknown): string {
  return `event: ${event}\nid: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
}

interface StreamSink {
  /** Resolve false when the write stalls past WRITE_STALL_MS (slow consumer). */
  write(chunk: string): Promise<boolean>;
  /** Tear the stream down after a stall — no further writes. */
  abort(): void;
}

function sinkFor(writable: WritableStream): StreamSink {
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  return {
    async write(chunk: string): Promise<boolean> {
      // The .then(_, false) form means a write rejected by a disconnecting
      // client resolves false instead of rejecting — and because `settled`
      // is the ONLY chain, a race-loser write can never surface as an
      // unhandled rejection (the 1101 crash class).
      const settled = writer.write(encoder.encode(chunk)).then(
        () => true,
        () => false,
      );
      return await Promise.race([settled, sleep(WRITE_STALL_MS).then(() => false)]);
    },
    abort(): void {
      void writer.abort().catch(() => undefined);
    },
  };
}

async function pump(
  sink: StreamSink,
  topics: TopicDefinition[],
  lastEventId: number,
  executionCtx: { waitUntil(p: Promise<unknown>): void } | null,
): Promise<void> {
  const startedAt = Date.now();
  try {
    // Immediate first pull so a fresh connection gets data within ~250ms
    // instead of waiting a full topic interval.
    if (!(await sink.write(': connected\n\n'))) return;
    for (const def of topics) {
      // Resume: replay anything the client missed from the ring first.
      for (const missed of framesAfter(def, lastEventId)) {
        if (!(await sink.write(sseFrame(missed.event, missed.seq, JSON.parse(missed.data))))) return;
      }
      try {
        await sharedSnapshot(def);
        const frame = frameIfChanged(def);
        if (frame && !(await sink.write(sseFrame(frame.event, frame.seq, JSON.parse(frame.data))))) return;
      } catch {
        // Source down at connect — the loop below keeps retrying.
      }
    }

    let lastKeepalive = Date.now();
    // One loop for all topics: the shortest interval drives the tick; longer
    // topics only pull when their own interval has elapsed.
    const nextDue = new Map<TopicDefinition, number>();
    for (const def of topics) nextDue.set(def, Date.now() + FIRST_FRAME_DELAY_MS);

    while (Date.now() - startedAt < CONNECTION_CAP_MS) {
      await sleep(500);
      const now = Date.now();
      if (now - lastKeepalive >= KEEPALIVE_MS) {
        if (!(await sink.write(': keepalive\n\n'))) return;
        lastKeepalive = now;
      }
      for (const def of topics) {
        if (now < (nextDue.get(def) ?? 0)) continue;
        nextDue.set(def, now + def.intervalMs);
        try {
          await sharedSnapshot(def);
          const frame = frameIfChanged(def);
          if (frame && !(await sink.write(sseFrame(frame.event, frame.seq, JSON.parse(frame.data))))) return;
        } catch (err) {
          // Source failure — frame stays suppressed; retry next interval.
          logger.debug({ err: String(err), topic: def.name }, 'SSE topic pull failed (retrying next tick)');
        }
      }
    }
    await sink.write('event: bye\ndata: {"reason":"connection cap"}\n\n');
  } catch {
    // Client detached (write rejected) — normal disconnect path.
  }
}

sseApi.get('/events/stream', readRateLimit, async (c) => {
  const { topics, invalid } = parseTopics(c.req.query('topics'));
  if (invalid.length > 0) {
    return c.json(
      { error: `Unknown topic(s): ${invalid.join(', ')}`, allowed: PUBLIC_TOPICS.map((t) => t.name) },
      400,
    );
  }

  // B-24: header-only resume — the ?last_event_id= query variant leaked seqs
  // into URLs and logs.
  const lastEventIdRaw = c.req.header('Last-Event-ID') ?? '';
  const lastEventId = Number.parseInt(lastEventIdRaw, 10);
  const resumeFrom = Number.isNaN(lastEventId) ? 0 : lastEventId;

  // B-24 connection caps: per-IP first (client-abusable), then the isolate
  // valve. Both are released when pump settles, so caps track LIVE streams,
  // not historical ones.
  const ip = clientIp(c);
  if ((openByIp.get(ip) ?? 0) >= MAX_STREAMS_PER_IP) {
    c.header('Retry-After', '30');
    return c.json({ error: 'Too many concurrent streams from this address', cap: MAX_STREAMS_PER_IP }, 429);
  }
  if (openTotal >= MAX_STREAMS_PER_ISOLATE) {
    c.header('Retry-After', '30');
    return c.json({ error: 'Stream capacity reached, retry shortly' }, 503);
  }
  acquireStream(ip);

  const { readable, writable } = new TransformStream();
  const sink = sinkFor(writable);
  // c.executionCtx THROWS (not null) outside a real request context — tests.
  let ctx: { waitUntil(p: Promise<unknown>): void } | null = null;
  try {
    ctx = c.executionCtx as unknown as { waitUntil(p: Promise<unknown>): void };
  } catch {
    ctx = null;
  }
  const run = pump(sink, topics, resumeFrom, ctx).finally(() => {
    releaseStream(ip);
    void writable.close().catch(() => {});
  });
  if (ctx) {
    ctx.waitUntil(run);
  } else {
    // No ExecutionContext (tests) — the stream itself keeps the loop alive.
    void run;
  }

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
});
