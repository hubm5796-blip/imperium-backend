import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B-32 — POST /api/v2/webhooks/subscriptions/:id/test must deliver to :id
 * ONLY. It used to call emit(), fanning test.ping to every active subscriber:
 * "test this subscriber" spammed all endpoints and a green test said nothing
 * about the one being tested.
 *
 * B-33 — the public gallery list must answer 503 with a GENERIC body; the
 * D1/driver error text (table/SQL fragments) goes to the log, never into
 * error.details of an unauthenticated response.
 */

const { subscribers, deliveries } = vi.hoisted(() => ({
  subscribers: new Map<string, Record<string, unknown>>(),
  deliveries: new Map<string, Record<string, unknown>>(),
}));

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    getD1: vi.fn(() => {
      // B-33: a driver error carrying internals.
      if (galleryBroken.value) {
        throw new Error('D1_ERROR: no such table: gallery_posts near `FROM gallery_posts` (SQLSTATE 42S02)');
      }
      return fakeD1();
    }),
  };
});

const { galleryBroken } = vi.hoisted(() => ({ galleryBroken: { value: false } }));

function fakeD1() {
  return {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return { run: async () => ({ meta: { changes: apply(sql, params) } }), first: async <T>() => (null as T | null), all: async () => ({ results: [] }) };
        },
        async run() {
          return { meta: { changes: apply(sql, []) } };
        },
        async first<T>() {
          if (/FROM webhook_subscribers WHERE id = \?/.test(sql)) return null as T | null;
          return null as T | null;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
      };
    },
    async batch(stmts: Array<{ sql: string; params: unknown[] }>) {
      return stmts.map((s) => ({ meta: { changes: apply(s.sql, s.params) }, results: [] }));
    },
  };
}

function apply(sql: string, params: unknown[]): number {
  if (/^CREATE TABLE/i.test(sql)) return 0;
  if (/^DELETE FROM rate_limit/i.test(sql)) return 0;
  if (/INSERT INTO webhook_deliveries/.test(sql)) {
    const [subscriberId, eventId, type, payload] = params as [string, string, string, string];
    deliveries.set(`${subscriberId}|${eventId}`, { subscriberId, eventId, type, payload });
    return 1;
  }
  return 0;
}

vi.mock('../webhooks/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../webhooks/store.js')>();
  return {
    ...actual,
    getSubscriber: vi.fn(async (id: string) => (subscribers.get(id) ?? null)),
    enqueueDeliveries: vi.fn(
      async (rows: Array<{ subscriberId: string; eventId: string; type: string; payload: string }>) => {
        for (const r of rows) deliveries.set(`${r.subscriberId}|${r.eventId}`, { ...r });
        return rows.length;
      },
    ),
  };
});

import { webhooksApi } from '../api/expansion/webhookAdmin.js';
import { galleryV2 } from '../api/v2/gallery.js';
import { __resetEnvForTests, initEnvFromBindings } from '../env.js';

beforeAll(() => {
  __resetEnvForTests();
  initEnvFromBindings({
    JWT_SECRET: 'test-jwt-secret-0123456789abcdef',
    DISCORD_CLIENT_ID: '1',
    DISCORD_CLIENT_SECRET: 'x',
    WEBPANEL_HMAC_SECRET: 'hmac',
    PAYNOW_API_KEY: 'pk',
    PAYNOW_STORE_ID: '1',
    PAYNOW_WEBHOOK_SECRETS: 'whsec',
    BOT_API_TOKEN: 'bot-token-for-tests',
  } as unknown as Record<string, unknown>);
});

beforeEach(() => {
  subscribers.clear();
  deliveries.clear();
  galleryBroken.value = false;
  subscribers.set('sub-a', { id: 'sub-a', name: 'A', url: 'https://a.example/hook', secret: 's1', events: '["test.ping"]', owner_kind: 'internal', owner_id: null, status: 'active' });
  subscribers.set('sub-b', { id: 'sub-b', name: 'B', url: 'https://b.example/hook', secret: 's2', events: '["test.ping"]', owner_kind: 'internal', owner_id: null, status: 'active' });
});

describe('B-32 webhook test delivery is scoped to :id', () => {
  it('a test ping queues exactly one delivery row, for the addressed subscriber', async () => {
    const res = await webhooksApi.request('/webhooks/subscriptions/sub-a/test', {
      method: 'POST',
      headers: { 'X-Bot-Token': 'bot-token-for-tests' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { queued: number; subscriberId: string };
    expect(body.queued).toBe(1);
    expect(body.subscriberId).toBe('sub-a');
    expect(deliveries.size).toBe(1);
    const only = [...deliveries.values()][0]!;
    expect(only.subscriberId).toBe('sub-a'); // sub-b was NOT queued — no fan-out
    expect(only.type).toBe('test.ping');
    expect(String(only.payload)).toContain('"type":"test.ping"');
  });

  it('unknown subscriber → 404, paused subscriber → 409', async () => {
    const missing = await webhooksApi.request('/webhooks/subscriptions/nope/test', {
      method: 'POST',
      headers: { 'X-Bot-Token': 'bot-token-for-tests' },
    });
    expect(missing.status).toBe(404);

    subscribers.set('sub-paused', { ...subscribers.get('sub-a')!, id: 'sub-paused', status: 'paused' });
    const paused = await webhooksApi.request('/webhooks/subscriptions/sub-paused/test', {
      method: 'POST',
      headers: { 'X-Bot-Token': 'bot-token-for-tests' },
    });
    expect(paused.status).toBe(409);
    expect(deliveries.size).toBe(0);
  });
});

describe('B-33 gallery errors do not reflect internals', () => {
  it('the public list answers a generic 503 with no driver text in the body', async () => {
    galleryBroken.value = true;
    const res = await galleryV2.request('/community/gallery');
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    const err = body.error as Record<string, unknown> | undefined;
    expect(err?.message).toBe('Gallery unavailable.');
    expect(err?.code).toBe('REGISTRY_UNAVAILABLE');
    // The driver message (table name / SQL fragments) must not ride along.
    expect(JSON.stringify(body)).not.toContain('gallery_posts');
    expect(JSON.stringify(body)).not.toContain('SQLSTATE');
  });
});
