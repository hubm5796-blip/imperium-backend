// V6 05-03: webhook subscriber + delivery queue storage on D1 (backend-owned
// config, keeps game Postgres clean). Tables self-migrate at first use —
// CREATE IF NOT EXISTS is idempotent and cheap on a warm-isolate flag.
import type { D1Database } from '@cloudflare/workers-types';
import type { OutboundEventType } from './types.js';

let migrated = false;

export interface Subscriber {
  id: string;
  name: string;
  url: string;
  secret: string;
  events: string[]; // JSON array column
  owner_kind: 'internal' | 'api_key' | 'public';
  owner_id: string | null;
  status: 'active' | 'paused' | 'dead';
}

interface SubscriberRow {
  id: string;
  name: string;
  url: string;
  secret: string;
  events: string;
  owner_kind: string;
  owner_id: string | null;
  status: string;
}

function toSubscriber(row: SubscriberRow): Subscriber {
  let events: string[] = [];
  try {
    const parsed = JSON.parse(row.events);
    if (Array.isArray(parsed)) events = parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    // malformed events array — treat as subscribed to nothing
  }
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    secret: row.secret,
    events,
    owner_kind: (row.owner_kind as Subscriber['owner_kind']) ?? 'public',
    owner_id: row.owner_id,
    status: (row.status as Subscriber['status']) ?? 'active',
  };
}

import { getD1 } from '../db/pool.js';

function db(): D1Database {
  return getD1();
}

export async function ensureWebhookTables(): Promise<D1Database> {
  const d1 = db();
  if (migrated) return d1;
  await d1.batch([
    d1.prepare(`CREATE TABLE IF NOT EXISTS webhook_subscribers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      secret TEXT NOT NULL,
      events TEXT NOT NULL,
      owner_kind TEXT NOT NULL DEFAULT 'public',
      owner_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS webhook_deliveries (
      subscriber_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      response_code INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (subscriber_id, event_id)
    )`),
    d1.prepare(`CREATE TABLE IF NOT EXISTS webhook_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`),
  ]);
  migrated = true;
  return d1;
}

export async function listSubscribers(): Promise<Subscriber[]> {
  const d1 = await ensureWebhookTables();
  const { results } = await d1
    .prepare('SELECT id, name, url, secret, events, owner_kind, owner_id, status FROM webhook_subscribers')
    .all<SubscriberRow>();
  return (results ?? []).map(toSubscriber);
}

export async function activeSubscribersFor(type: OutboundEventType): Promise<Subscriber[]> {
  const all = await listSubscribers();
  return all.filter((s) => s.status === 'active' && (s.events.includes(type) || s.events.includes('*')));
}

export async function getSubscriber(id: string): Promise<Subscriber | null> {
  const d1 = await ensureWebhookTables();
  const row = await d1
    .prepare('SELECT id, name, url, secret, events, owner_kind, owner_id, status FROM webhook_subscribers WHERE id = ?')
    .bind(id)
    .first<SubscriberRow>();
  return row ? toSubscriber(row) : null;
}

export async function createSubscriber(input: {
  name: string;
  url: string;
  secret: string;
  events: string[];
  ownerKind: Subscriber['owner_kind'];
  ownerId: string | null;
}): Promise<Subscriber> {
  const d1 = await ensureWebhookTables();
  const id = crypto.randomUUID();
  await d1
    .prepare(
      `INSERT INTO webhook_subscribers (id, name, url, secret, events, owner_kind, owner_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, input.name, input.url, input.secret, JSON.stringify(input.events), input.ownerKind, input.ownerId, 'active', Date.now())
    .run();
  const created = await getSubscriber(id);
  if (!created) throw new Error('subscriber insert failed');
  return created;
}

export async function updateSubscriberStatus(id: string, status: Subscriber['status']): Promise<void> {
  const d1 = await ensureWebhookTables();
  await d1.prepare('UPDATE webhook_subscribers SET status = ? WHERE id = ?').bind(status, id).run();
}

export async function deleteSubscriber(id: string): Promise<boolean> {
  const d1 = await ensureWebhookTables();
  const res = await d1.prepare('DELETE FROM webhook_subscribers WHERE id = ?').bind(id).run();
  await d1.prepare('DELETE FROM webhook_deliveries WHERE subscriber_id = ?').bind(id).run();
  return (res.meta.changes ?? 0) > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Delivery queue
// ─────────────────────────────────────────────────────────────────────────────

export interface DeliveryRow {
  subscriber_id: string;
  event_id: string;
  type: string;
  payload: string;
  attempt: number;
  next_attempt_at: number;
  status: string;
  response_code: number | null;
  last_error: string | null;
}

export async function enqueueDeliveries(
  rows: Array<{ subscriberId: string; eventId: string; type: OutboundEventType; payload: string }>,
): Promise<number> {
  if (rows.length === 0) return 0;
  const d1 = await ensureWebhookTables();
  const stmts = rows.map((r) =>
    d1
      .prepare(
        `INSERT INTO webhook_deliveries (subscriber_id, event_id, type, payload, attempt, next_attempt_at, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (subscriber_id, event_id) DO NOTHING`,
      )
      .bind(r.subscriberId, r.eventId, r.type, r.payload, 0, Date.now(), 'pending', Date.now()),
  );
  const results = await d1.batch(stmts);
  return results.reduce((sum, r) => sum + (r.meta.changes ?? 0), 0);
}

export async function dueDeliveries(limit: number, now: number): Promise<DeliveryRow[]> {
  const d1 = await ensureWebhookTables();
  const { results } = await d1
    .prepare(
      `SELECT subscriber_id, event_id, type, payload, attempt, next_attempt_at, status, response_code, last_error
         FROM webhook_deliveries
        WHERE status IN ('pending', 'failed') AND next_attempt_at <= ?
        ORDER BY next_attempt_at ASC
        LIMIT ?`,
    )
    .bind(now, limit)
    .all<DeliveryRow>();
  return results ?? [];
}

export async function markDelivery(
  subscriberId: string,
  eventId: string,
  outcome: { status: 'delivered' | 'failed' | 'dead'; responseCode?: number; lastError?: string; nextAttemptAt?: number; attempt?: number },
): Promise<void> {
  const d1 = await ensureWebhookTables();
  await d1
    .prepare(
      `UPDATE webhook_deliveries
          SET status = ?, response_code = ?, last_error = ?, next_attempt_at = ?, attempt = ?
        WHERE subscriber_id = ? AND event_id = ?`,
    )
    .bind(
      outcome.status,
      outcome.responseCode ?? null,
      (outcome.lastError ?? '').slice(0, 300) || null,
      outcome.nextAttemptAt ?? 0,
      outcome.attempt ?? 0,
      subscriberId,
      eventId,
    )
    .run();
}

export async function listDeliveries(status: string | null | undefined, limit: number): Promise<DeliveryRow[]> {
  const d1 = await ensureWebhookTables();
  const { results } = await (status
    ? d1
        .prepare(
          `SELECT subscriber_id, event_id, type, payload, attempt, next_attempt_at, status, response_code, last_error
             FROM webhook_deliveries WHERE status = ? ORDER BY created_at DESC LIMIT ?`,
        )
        .bind(status, limit)
        .all<DeliveryRow>()
    : d1
        .prepare(
          `SELECT subscriber_id, event_id, type, payload, attempt, next_attempt_at, status, response_code, last_error
             FROM webhook_deliveries ORDER BY created_at DESC LIMIT ?`,
        )
        .bind(limit)
        .all<DeliveryRow>());
  return results ?? [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Tailer cursor + internal-bot subscriber seeding
// ─────────────────────────────────────────────────────────────────────────────

export async function getState(key: string): Promise<string | null> {
  const d1 = await ensureWebhookTables();
  const row = await d1.prepare('SELECT value FROM webhook_state WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setState(key: string, value: string): Promise<void> {
  const d1 = await ensureWebhookTables();
  await d1
    .prepare('INSERT INTO webhook_state (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
    .bind(key, value)
    .run();
}

/** Seed the internal Discord-bot subscriber once WEBHOOK_BOT_URL is set.
 *  Idempotent on the fixed id; the shared secret matches the bot's
 *  ROLE_WEBHOOK_SECRET (HMAC key over "<secret>.<body>"). */
export async function seedInternalBotSubscriber(url: string, secret: string): Promise<void> {
  const d1 = await ensureWebhookTables();
  await d1
    .prepare(
      `INSERT INTO webhook_subscribers (id, name, url, secret, events, owner_kind, owner_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET url = excluded.url, secret = excluded.secret`,
    )
    .bind('discord-bot', 'ImperiumMC Discord bot (role sync + pushes)', url, secret, JSON.stringify(['subscription.updated', 'player.prestige', 'player.rankup', 'test.ping']), 'internal', null, 'active', Date.now())
    .run();
}
