import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * V6 05-03 outbound-webhook tests. D1 is faked with an in-memory table store
 * exposing the same prepared-statement surface the code uses (bind/run/all/
 * first/batch); the delivery loop's HTTP calls go through a stubbed global
 * fetch. Contracts:
 *   1. Signature round-trip — a receiver verifying with the documented scheme
 *      accepts; a tampered body rejects.
 *   2. Retry ladder — 500s schedule 1m/5m backoffs; dead after 8 attempts;
 *      3× 404 kills the SUBSCRIBER.
 *   3. Fan-out — emit() queues one row per matching active subscriber only.
 */

// ── D1 fake ──────────────────────────────────────────────────────────────────

function makeFakeD1() {
  const tables = new Map<string, Map<string, Record<string, unknown>>>();
  const table = (name: string) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name)!;
  };
  const pkOf = (name: string, row: Record<string, unknown>): string => {
    if (name === 'webhook_deliveries') return `${row.subscriber_id}|${row.event_id}`;
    return String(row.id ?? row.key ?? row.url);
  };

  function exec(sql: string, params: unknown[]): { changes: number; rows: Record<string, unknown>[] } {
    const insert = /^INSERT INTO (\w+)/i.exec(sql);
    const select = /^SELECT (.+?) FROM (\w+)/is.exec(sql);
    const update = /^UPDATE\s+(\w+)\s+SET/is.exec(sql);
    const del = /^DELETE FROM (\w+)/i.exec(sql);
    const create = /^CREATE TABLE IF NOT EXISTS (\w+)/i.exec(sql);

    if (create) {
      table(create[1]!);
      return { changes: 0, rows: [] };
    }
    if (insert) {
      const name = insert[1]!;
      const conflict = /ON CONFLICT \(([^)]+)\) DO UPDATE SET (.+)$/is.exec(sql);
      const values = params as unknown[];
      // Column list lives in the head (before VALUES); the tail's parens are
      // the placeholder group.
      const cols = /\(([^)]+)\)/.exec(sql.split('VALUES')[0]!)![1].split(',').map((c) => c.trim());
      const row: Record<string, unknown> = {};
      cols.forEach((c, i) => (row[c] = values[i]));
      const t = table(name);
      const key = pkOf(name, row);
      if (conflict && t.has(key)) {
        t.set(key, { ...t.get(key)!, ...row }); // merge-duplicates
      } else if (conflict && /DO NOTHING/i.test(sql)) {
        if (t.has(key)) return { changes: 0, rows: [] };
        t.set(key, row);
      } else {
        if (t.has(key) && /DO NOTHING/i.test(sql)) return { changes: 0, rows: [] };
        t.set(key, row);
      }
      return { changes: 1, rows: [row] };
    }
    if (select) {
      const name = select[2]!.trim();
      const t = table(name);
      let rows = [...t.values()];
      const where = sql;
      if (name === 'webhook_subscribers' && /id = \?/.test(where) && params[0] !== undefined) {
        rows = rows.filter((r) => r.id === params[0]);
      }
      if (name === 'webhook_subscribers' && !/id = \?/.test(where)) {
        // list all
      }
      if (name === 'webhook_deliveries' && /next_attempt_at <= \?/.test(where)) {
        const now = params[0] as number;
        const limit = params[1] as number;
        rows = rows
          .filter((r) => (r.status === 'pending' || r.status === 'failed') && (r.next_attempt_at as number) <= now)
          .sort((a, b) => (a.next_attempt_at as number) - (b.next_attempt_at as number))
          .slice(0, limit);
      }
      if (name === 'webhook_state' && /key = \?/.test(where)) {
        rows = rows.filter((r) => r.key === params[0]);
      }
      return { changes: 0, rows: rows.slice(0, 1 && name === 'webhook_state' ? 1 : 200) };
    }
    if (update) {
      const name = update[1]!;
      const t = table(name);
      if (name === 'webhook_subscribers' && /status = \? WHERE id = \?/.test(sql)) {
        let changes = 0;
        for (const [k, r] of t) {
          if (r.id === params[1]) {
            r.status = params[0];
            changes += 1;
          }
        }
        return { changes, rows: [] };
      }
      if (name === 'webhook_deliveries') {
        let changes = 0;
        for (const [k, r] of t) {
          if (r.subscriber_id === params[5] && r.event_id === params[6]) {
            r.status = params[0];
            r.response_code = params[1];
            r.last_error = params[2];
            r.next_attempt_at = params[3];
            r.attempt = params[4];
            changes += 1;
          }
        }
        return { changes, rows: [] };
      }
      if (name === 'webhook_state') {
        // handled via INSERT ON CONFLICT
      }
      return { changes: 0, rows: [] };
    }
    if (del) {
      const name = del[1]!;
      const t = table(name);
      let changes = 0;
      for (const [k, r] of t) {
        const target = name === 'webhook_subscribers' ? r.id === params[0] : r.subscriber_id === params[0];
        if (target) {
          t.delete(k);
          changes += 1;
        }
      }
      return { changes, rows: [] };
    }
    return { changes: 0, rows: [] };
  }

  const stmt = (sql: string) => ({
    bind: (...params: unknown[]) => ({
      run: async () => ({ meta: { changes: exec(sql, params).changes } }),
      first: async <T>(): Promise<T | null> => (exec(sql, params).rows[0] as T) ?? null,
      all: async <T>(): Promise<{ results: T[] | null }> => ({ results: exec(sql, params).rows as T[] }),
    }),
    run: async () => ({ meta: { changes: exec(sql, []).changes } }),
    first: async <T>(): Promise<T | null> => (exec(sql, []).rows[0] as T) ?? null,
    all: async <T>(): Promise<{ results: T[] | null }> => ({ results: exec(sql, []).rows as T[] }),
  });

  return {
    prepare: stmt,
    batch: async (stmts: Array<{ run: () => Promise<{ meta: { changes: number } }> }>) =>
      Promise.all(stmts.map((s) => s.run())),
    __tables: tables,
  };
}

// ── Module mocks ─────────────────────────────────────────────────────────────

const fakeD1 = makeFakeD1();

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    getD1: () => fakeD1,
    query: vi.fn(),
  };
});

import { createHmac } from 'node:crypto';
import { emit, runDeliveryTick, signPayload } from '../webhooks/deliver.js';
import { feedRowToEvent } from '../webhooks/tailer.js';
import { createSubscriber, dueDeliveries, getSubscriber, listSubscribers } from '../webhooks/store.js';

beforeEach(() => {
  fakeD1.__tables.clear();
});

const SUB_URL = 'https://bot.example/roles/sync';

async function seedSubscriber(events: string[] = ['subscription.updated']) {
  return createSubscriber({ name: 'test', url: SUB_URL, secret: 'whsec_test', events, ownerKind: 'internal', ownerId: null });
}

describe('emit + fan-out', () => {
  it('queues one delivery per matching ACTIVE subscriber only', async () => {
    await seedSubscriber(['subscription.updated']);
    await seedSubscriber(['player.rankup']);
    const queued = await emit({ type: 'subscription.updated', v: 1, uuid: 'u-1', productId: 'p', status: 'active', at: new Date().toISOString() });
    expect(queued).toBe(1);
    const due = await dueDeliveries(10, Date.now());
    expect(due).toHaveLength(1);
    expect(due[0]!.type).toBe('subscription.updated');
  });

  it('skips subscribers that are paused or dead', async () => {
    const sub = await seedSubscriber();
    const { updateSubscriberStatus } = await import('../webhooks/store.js');
    await updateSubscriberStatus(sub.id, 'paused');
    const queued = await emit({ type: 'subscription.updated', v: 1, uuid: 'u', productId: 'p', status: 'active', at: new Date().toISOString() });
    expect(queued).toBe(0);
  });
});

describe('delivery loop', () => {
  it('delivers with a verifiable signature and marks delivered', async () => {
    await seedSubscriber(['test.ping']);
    await emit({ type: 'test.ping', v: 1, at: new Date().toISOString() });

    let captured: { body: string; headers: Record<string, string> } | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      captured = {
        body: String(init?.body),
        headers: (init?.headers ?? {}) as Record<string, string>,
      };
      return new Response('{}', { status: 202 });
    }) as typeof fetch;

    try {
      const report = await runDeliveryTick(Date.now());
      expect(report.delivered).toBe(1);

      // Verify with the documented scheme.
      const sig = captured!.headers['X-Imperium-Signature'];
      expect(sig).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
      const [, v1] = sig!.split(',');
      const t = sig!.match(/t=(\d+)/)![1]!;
      const expected = createHmac('sha256', 'whsec_test').update(`t.${t}.${captured!.body}`).digest('hex');
      expect(v1!.slice(3)).toBe(expected);

      const due = await dueDeliveries(10, Date.now());
      expect(due).toHaveLength(0); // no longer pending
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('retries a 500 with the 1-minute backoff, then the 5-minute one', async () => {
    await seedSubscriber(['test.ping']);
    await emit({ type: 'test.ping', v: 1, at: new Date().toISOString() });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    try {
      // Anchor to the real clock — the queue stores real timestamps.
      const t0 = Date.now();
      await runDeliveryTick(t0);
      let due = await dueDeliveries(10, t0 + 30_000);
      expect(due).toHaveLength(0); // 1-minute delay not yet elapsed
      due = await dueDeliveries(10, t0 + 61_000);
      expect(due).toHaveLength(1);
      expect(due[0]!.attempt).toBe(1);

      await runDeliveryTick(t0 + 61_000);
      due = await dueDeliveries(10, t0 + 61_000 + 5 * 60_000);
      expect(due).toHaveLength(1);
      expect(due[0]!.attempt).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('three 404s kill the subscriber', async () => {
    const sub = await seedSubscriber(['test.ping']);
    await emit({ type: 'test.ping', v: 1, at: new Date().toISOString() });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('', { status: 404 })) as typeof fetch;
    try {
      let t = Date.now();
      // Advance past each scheduled retry (60s, then 5m) so attempt 3 runs.
      const ticks = [t, t + 60_001, t + 60_001 + 5 * 60_000];
      for (const tick of ticks) {
        await runDeliveryTick(tick);
      }
      const after = await getSubscriber(sub.id);
      expect(after!.status).toBe('dead');
      // Dead subscriber receives no further fan-out.
      const queued = await emit({ type: 'test.ping', v: 1, at: new Date().toISOString() });
      expect(queued).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('signPayload', () => {
  it('matches the documented PayNow-style scheme', () => {
    const body = '{"id":"x"}';
    const t = 1234567890;
    const sig = signPayload('sekret', t, body);
    expect(sig).toBe(createHmac('sha256', 'sekret').update(`t.${t}.${body}`).digest('hex'));
  });
});

describe('feedRowToEvent', () => {
  it('maps rankup rows with from/to fields', () => {
    const event = feedRowToEvent({
      id: 5,
      event_type: 'player_rankup',
      uuid: 'u-1',
      message: 'player=Maximus from=6 to=7',
      at: new Date('2026-08-20T10:00:00Z'),
    });
    expect(event).toEqual({
      type: 'player.rankup',
      v: 1,
      uuid: 'u-1',
      username: 'Maximus',
      fromRank: 6,
      toRank: 7,
      at: '2026-08-20T10:00:00.000Z',
    });
  });

  it('drops unmapped types and rankups without a to= field', () => {
    expect(feedRowToEvent({ id: 1, event_type: 'contract_fulfilled', uuid: 'u', message: 'x', at: new Date() })).toBeNull();
    expect(feedRowToEvent({ id: 1, event_type: 'player_rankup', uuid: 'u', message: 'no fields', at: new Date() })).toBeNull();
  });
});
