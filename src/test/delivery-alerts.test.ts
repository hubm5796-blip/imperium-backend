import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

/**
 * S2-D03 — failed-delivery alerting.
 *
 * Queue acceptance: "a seeded stale row produces exactly one alert, not a
 * loop, and a later execution posts a resolve." The dedupe is DURABLE (the
 * ledger row's alerted_at in D1), so it survives isolate restarts — an
 * in-memory dedupe would re-alert on every deploy, which is the loop the
 * packet forbids.
 */

/* ── the in-memory D1 (same interpreter contract as delivery-ledger.test) ── */

function makeLedgerD1() {
  type Row = Record<string, unknown>;
  const rows = new Map<string, Row>();
  return {
    __rows: rows,
    prepare(sql: string) {
      const exec = (params: unknown[]) => ({
        run: async () => {
          if (sql.includes('CREATE TABLE') || sql.includes('CREATE INDEX')) return { meta: { changes: 0 } };
          if (sql.startsWith('INSERT INTO store_delivery_ledger')) {
            const [
              order_id, line_key, pretty_id, customer_name, customer_uuid,
              product_id, sku_label, command, queued_at, updated_at,
            ] = params as string[];
            const key = `${order_id}|${line_key}`;
            const existing = rows.get(key);
            if (existing) {
              existing['status'] = 'pending';
              existing['executed_at'] = null;
              existing['failed_reason'] = null;
              existing['updated_at'] = updated_at;
            } else {
              rows.set(key, {
                order_id, line_key, pretty_id, customer_name, customer_uuid,
                product_id, sku_label, command,
                status: 'pending', queued_at, executed_at: null, failed_reason: null,
                grant_verified_at: null, grant_evidence: null,
                alerted_at: null, resolved_at: null, updated_at,
              });
            }
            return { meta: { changes: existing ? 0 : 1 } };
          }
          if (sql.startsWith('UPDATE store_delivery_ledger')) {
            const setPart = sql.slice(sql.indexOf('SET ') + 4, sql.indexOf(' WHERE '));
            const sets = [...setPart.matchAll(/(\w+) = \?/g)].map((m) => m[1]!);
            const wherePart = sql.slice(sql.indexOf(' WHERE '));
            const whereKeys = [...wherePart.matchAll(/(order_id|line_key) = \?/g)].map((m) => m[1]!);
            const setValues = params.slice(0, sets.length);
            const whereValues = params.slice(sets.length);
            let changed = 0;
            for (const [, row] of rows) {
              const okMatch = whereKeys.every((wk, i) => row[wk] === whereValues[i]);
              if (!okMatch) continue;
              sets.forEach((col, i) => {
                row[col] = setValues[i];
              });
              changed++;
            }
            return { meta: { changes: changed } };
          }
          return { meta: { changes: 0 } };
        },
        first: async () => null,
        all: async () => {
          if (sql.includes('FROM store_delivery_ledger')) {
            const all = [...rows.values()] as Row[];
            all.sort((a, b) => (b['queued_at'] as number) - (a['queued_at'] as number));
            return { results: all };
          }
          return { results: [] };
        },
      });
      return {
        bind: (...params: unknown[]) => exec(params),
        ...exec([]),
      };
    },
  };
}

/* ── module state ────────────────────────────────────────────────────────── */

const posts: Array<{ url: string; body: string }> = [];
const originalFetch = globalThis.fetch;

let d1 = makeLedgerD1();

vi.mock('../db/redis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/redis.js')>();
  return { ...actual, sendCommandWithResponse: vi.fn() };
});

import { initD1 } from '../db/pool.js';
import { __resetEnvForTests, initEnvFromBindings } from '../env.js';
import { ledgerLineExecuted, ledgerLineQueued } from '../db/deliveryLedger.js';
import { runDeliveryAlertSweep } from '../alerts/deliveryAlerts.js';

const NOW = new Date('2026-10-27T12:00:00Z');
const STALE_MS = 24 * 60 * 60 * 1000;

beforeAll(() => {
  __resetEnvForTests();
  initEnvFromBindings({
    JWT_SECRET: 'test-jwt-secret-0123456789abcdef0123456789abcdef',
    WEBPANEL_HMAC_SECRET: 'test-hmac-secret-0123456789abcdef0123456789abcdef',
    DISCORD_CLIENT_ID: 'test-client-id',
    DISCORD_CLIENT_SECRET: 'test-client-secret',
    BOT_API_TOKEN: 'test-bot-token',
    PAYNOW_API_KEY: 'test-paynow-key',
    PAYNOW_STORE_ID: 'test-store',
    PAYNOW_WEBHOOK_SECRETS: 'test-webhook-secret',
    NODE_ENV: 'test',
    STAFF_ALERT_WEBHOOK_URL: 'https://discord.example.test/webhook/staff',
    D1_RATE_LIMIT: { stub: true },
  } as unknown as Record<string, unknown>);
});

beforeEach(() => {
  d1 = makeLedgerD1();
  initD1(d1 as never);
  posts.length = 0;
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    posts.push({ url: String(url), body: init?.body ?? '' });
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function seedStale(orderId = 'ord_stuck', queuedAt = NOW.getTime() - STALE_MS - 3_600_000): Promise<void> {
  await ledgerLineQueued({
    orderId,
    lineKey: '0:prod:1:buyer',
    prettyId: 'pn_stuck',
    customerName: 'BuyerBob',
    customerUuid: '99999999-8888-4777-8666-555555555555',
    productId: 'prod',
    skuLabel: 'PEREGRINUS (lifetime)',
    command: 'STORE_PURCHASE_RANK {"player_uuid":"buyer"}',
    queuedAt,
  });
}

describe('S2-D03: failed-delivery alerting', () => {
  it('a seeded stale row produces EXACTLY ONE alert — the next pass does not loop', async () => {
    await seedStale();
    const first = await runDeliveryAlertSweep(NOW);
    expect(first.alerted).toBe(1);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe('https://discord.example.test/webhook/staff');
    expect(posts[0]!.body).toContain('ord_stuck');
    expect(posts[0]!.body).toContain('STORE_PURCHASE_RANK');
    expect(posts[0]!.body).toContain('allowed_mentions'); // mentions never resolve

    // The dedupe survives anything an isolate restart would throw at it:
    // fresh in-memory state, same D1 rows.
    const second = await runDeliveryAlertSweep(NOW);
    expect(second.alerted).toBe(0);
    expect(posts).toHaveLength(1); // still exactly one — not a loop
  });

  it('a fresh (under 24h) pending row is not alerted', async () => {
    await ledgerLineQueued({
      orderId: 'ord_fresh',
      lineKey: '0:prod:1:buyer',
      productId: 'prod',
      skuLabel: 'Aureus ×5600',
      command: 'STORE_PURCHASE_AUREUS {}',
      queuedAt: NOW.getTime() - 3_600_000,
    });
    const report = await runDeliveryAlertSweep(NOW);
    expect(report.alerted).toBe(0);
    expect(posts).toHaveLength(0);
  });

  it('the sweep persists the stale transition (status filters see it between passes)', async () => {
    await seedStale('ord_mark');
    await runDeliveryAlertSweep(NOW);
    const row = [...d1.__rows.values()].find((r) => r['order_id'] === 'ord_mark')!;
    expect(row['status']).toBe('stale');
  });

  it('a later execution posts ONE resolve — and never a second', async () => {
    await seedStale('ord_recovery');
    await runDeliveryAlertSweep(NOW);
    expect(posts).toHaveLength(1);

    await ledgerLineExecuted('ord_recovery', '0:prod:1:buyer', NOW.getTime());
    const recovered = await runDeliveryAlertSweep(NOW);
    expect(recovered.resolved).toBe(1);
    expect(posts).toHaveLength(2);
    expect(posts[1]!.body).toContain('resolved');
    expect(posts[1]!.body).toContain('ord_recovery');

    const again = await runDeliveryAlertSweep(NOW);
    expect(again.resolved).toBe(0);
    expect(posts).toHaveLength(2);
  });

  it('a line that executed without ever breaching raises nothing', async () => {
    await ledgerLineQueued({
      orderId: 'ord_ok',
      lineKey: '0:prod:1:buyer',
      productId: 'prod',
      skuLabel: 'Aureus ×5600',
      command: 'STORE_PURCHASE_AUREUS {}',
      queuedAt: NOW.getTime() - 5_000,
    });
    await ledgerLineExecuted('ord_ok', '0:prod:1:buyer', NOW.getTime());
    const report = await runDeliveryAlertSweep(NOW);
    expect(report.alerted).toBe(0);
    expect(report.resolved).toBe(0);
    expect(posts).toHaveLength(0);
  });

  it('an old line that RE-DISPATCHES and executes resolves without a second breach alert', async () => {
    await seedStale('ord_retry');
    await runDeliveryAlertSweep(NOW); // breach alert #1
    // PayNow retry: re-queue (PayNow retried the webhook) then execute.
    await seedStale('ord_retry'); // upsert back to pending — alerted_at survives
    await ledgerLineExecuted('ord_retry', '0:prod:1:buyer', NOW.getTime());
    const report = await runDeliveryAlertSweep(NOW);
    expect(report.alerted).toBe(0); // no second breach alert
    expect(report.resolved).toBe(1); // the resolve still fires
    expect(posts).toHaveLength(2);
  });

  it('a webhook outage does not consume the breach (retries next pass)', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 502 })) as typeof fetch;
    await seedStale('ord_outage');
    const failed = await runDeliveryAlertSweep(NOW);
    expect(failed.alerted).toBe(0);
    expect(failed.errors).toBe(1);
    const row = [...d1.__rows.values()].find((r) => r['order_id'] === 'ord_outage')!;
    expect(row['alerted_at']).toBeNull(); // breach still armed

    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      posts.push({ url: 'webhook', body: init?.body ?? '' });
      return new Response('ok', { status: 200 });
    }) as typeof fetch;
    const recovered = await runDeliveryAlertSweep(NOW);
    expect(recovered.alerted).toBe(1); // exactly one once the webhook answers
    expect(posts).toHaveLength(1);
  });

  it('per-pass ceiling: a large backlog cannot fan out into a webhook storm', async () => {
    for (let i = 0; i < 15; i++) {
      await seedStale(`ord_backlog_${i}`);
    }
    const report = await runDeliveryAlertSweep(NOW);
    expect(report.alerted).toBe(10); // MAX_ALERTS_PER_PASS
    expect(posts).toHaveLength(10);
    // The remainder alert on subsequent passes (still one per line).
    const next = await runDeliveryAlertSweep(NOW);
    expect(next.alerted).toBe(5);
    expect(posts).toHaveLength(15);
  });
});
