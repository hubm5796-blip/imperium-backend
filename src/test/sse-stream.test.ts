import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * V6 05-02 SSE tests. The Redis/PG sources are mocked; the stream route is
 * driven through the real Hono app. Contracts:
 *   1. Topic allowlist — unknown topics 400 with the allowed list.
 *   2. Frame discipline — first connect emits a status frame; unchanged
 *      snapshots suppress further frames; a changed snapshot frames.
 *   3. In-flight dedupe — concurrent sharedSnapshot() calls produce ONE
 *      upstream pull.
 *   4. Last-Event-ID resume — reconnecting with the last seen seq replays
 *      missed frames from the ring.
 */

vi.mock('../db/redis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/redis.js')>();
  return {
    ...actual,
    getOnlinePlayerCount: vi.fn(async () => 0),
  };
});

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    query: vi.fn(async () => ({ rows: [] })),
  };
});

import { createApp } from '../app.js';
import { initEnvFromBindings } from '../env.js';
import { getOnlinePlayerCount } from '../db/redis.js';
import {
  STATUS_TOPIC,
  frameIfChanged,
  framesAfter,
  resetPollers,
  sharedSnapshot,
  type TopicDefinition,
} from '../api/expansion/sse/poller.js';

let app: ReturnType<typeof createApp>;
const statusMock = getOnlinePlayerCount as ReturnType<typeof vi.fn>;

beforeAll(() => {
  initEnvFromBindings({
    JWT_SECRET: 'unit-test-jwt-secret-0123456789abcdef0123',
    WEBPANEL_HMAC_SECRET: 'unit-test-webpanel-secret-0123456789abcdef',
    DISCORD_CLIENT_ID: 'test-client-id',
    DISCORD_CLIENT_SECRET: 'test-client-secret',
    PAYNOW_API_KEY: 'test-paynow-key',
    PAYNOW_STORE_ID: 'test-store',
    PAYNOW_WEBHOOK_SECRETS: 'test-webhook-secret',
    NODE_ENV: 'test',
  } as never);
  app = createApp();
});

import { beforeAll } from 'vitest';

beforeEach(() => {
  vi.clearAllMocks();
  statusMock.mockResolvedValue(0);
  resetPollers();
});

/** Read the stream for up to `ms`, collecting raw text. */
async function readStream(res: Response, ms: number, until?: (text: string) => boolean): Promise<string> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const next = await Promise.race([
      reader.read(),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 100)),
    ]);
    if (next === undefined) {
      if (until?.(text)) break;
      continue;
    }
    if (next.done) break;
    text += decoder.decode(next.value, { stream: true });
    if (until?.(text)) break;
  }
  void reader.cancel().catch(() => {});
  return text;
}

describe('GET /api/v2/events/stream', () => {
  it('rejects unknown topics with the allowlist', async () => {
    const res = await app.request('/api/v2/events/stream?topics=status,nonsense');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { allowed: string[] };
    expect(body.allowed).toContain('status');
    expect(body.allowed).toContain('economy');
  });

  it('streams a first status frame and suppresses unchanged snapshots', async () => {
    statusMock.mockResolvedValue(7);
    const res = await app.request('/api/v2/events/stream?topics=status');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/event-stream');

    const text = await readStream(res, 1500, (t) => t.includes('event: status'));
    expect(text).toContain(': connected');
    expect(text).toContain('event: status');
    expect(text).toContain('"playerCount":7');
    // Unchanged snapshot (7 -> 7): no second status frame within the window.
    const frames = text.split('event: status').length - 1;
    expect(frames).toBe(1);
  });
});

describe('poller dedupe + resume', () => {
  it('concurrent sharedSnapshot calls produce ONE upstream pull', async () => {
    let pulls = 0;
    const def: TopicDefinition = {
      name: 'test-topic',
      intervalMs: 1000,
      fetch: async () => {
        pulls += 1;
        await new Promise((r) => setTimeout(r, 30));
        return { n: pulls };
      },
      same: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    };
    await Promise.all([sharedSnapshot(def), sharedSnapshot(def), sharedSnapshot(def)]);
    expect(pulls).toBe(1);
  });

  it('frames only on change and replays missed frames by seq', async () => {
    let value = 1;
    const def: TopicDefinition = {
      name: 'flip-topic',
      intervalMs: 1000,
      fetch: async () => ({ value }),
      same: (a, b) => (a as { value?: number } | null)?.value === (b as { value?: number } | null)?.value,
    };

    await sharedSnapshot(def);
    const first = frameIfChanged(def);
    expect(first).not.toBeNull();
    expect(first!.seq).toBe(1);

    // Unchanged: no frame.
    await sharedSnapshot(def);
    expect(frameIfChanged(def)).toBeNull();

    // Changed: seq 2.
    value = 2;
    await sharedSnapshot(def);
    const second = frameIfChanged(def);
    expect(second!.seq).toBe(2);

    // Resume from seq 1 replays exactly the seq-2 frame.
    const missed = framesAfter(def, 1);
    expect(missed).toHaveLength(1);
    expect(missed[0]!.seq).toBe(2);
    expect(JSON.parse(missed[0]!.data)).toEqual({ value: 2 });
  });
});
