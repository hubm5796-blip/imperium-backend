// V6 05-02: GET /api/v2/events/stream — the SSE transport.
//
// One connection per client; each connection's loop pulls shared snapshots
// (per-isolate dedupe in poller.ts) and writes frames only when a topic's
// data changed. Keepalive comment frames every 25s keep proxies from idling
// the stream; connections self-close with `event: bye` at the 10-minute cap
// (EventSource reconnects transparently, replaying missed frames via
// Last-Event-ID). Public topics only in v1 — the private `orders` topic
// arrives with the store-delivery UI (04-WEB/02).
import { Hono, type Context } from 'hono';
import { logger } from '../../../utils/logger.js';
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
  write(chunk: string): Promise<void>;
  closed(): boolean;
}

function sinkFor(writable: WritableStream): StreamSink {
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  return {
    async write(chunk: string) {
      await writer.write(encoder.encode(chunk));
    },
    closed() {
      return false; // writer.write rejects once the client detaches — that ends the loop
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
    await sink.write(': connected\n\n');
    for (const def of topics) {
      // Resume: replay anything the client missed from the ring first.
      for (const missed of framesAfter(def, lastEventId)) {
        await sink.write(sseFrame(missed.event, missed.seq, JSON.parse(missed.data)));
      }
      try {
        await sharedSnapshot(def);
        const frame = frameIfChanged(def);
        if (frame) await sink.write(sseFrame(frame.event, frame.seq, JSON.parse(frame.data)));
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
        await sink.write(': keepalive\n\n');
        lastKeepalive = now;
      }
      for (const def of topics) {
        if (now < (nextDue.get(def) ?? 0)) continue;
        nextDue.set(def, now + def.intervalMs);
        try {
          await sharedSnapshot(def);
          const frame = frameIfChanged(def);
          if (frame) await sink.write(sseFrame(frame.event, frame.seq, JSON.parse(frame.data)));
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

sseApi.get('/events/stream', async (c) => {
  const { topics, invalid } = parseTopics(c.req.query('topics'));
  if (invalid.length > 0) {
    return c.json(
      { error: `Unknown topic(s): ${invalid.join(', ')}`, allowed: PUBLIC_TOPICS.map((t) => t.name) },
      400,
    );
  }

  const lastEventIdRaw = c.req.header('Last-Event-ID') ?? c.req.query('last_event_id') ?? '';
  const lastEventId = Number.parseInt(lastEventIdRaw, 10);
  const resumeFrom = Number.isNaN(lastEventId) ? 0 : lastEventId;

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
