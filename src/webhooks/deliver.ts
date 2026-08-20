// V6 05-03: emission + the signed delivery loop.
//
// Signature scheme (PayNow-style, already familiar to consumers):
//   X-Imperium-Signature: t=<unix>,v1=<hex hmac_sha256(secret, "t." + t + "." + body)>
// The Discord bot verifies with its secretsMatch helper over "<secret>.<body>"
// — ITS scheme — so bot-targeted pushes additionally carry the header
//   X-Signature: <hex hmac_sha256(botSecret, botSecret + "." + body)>
// which is exactly what /roles/sync expects. Both headers, one POST.
//
// Retry ladder: 1m/5m/30m/2h/6h, dead after 8 attempts; 404/410 ×3 kills the
// subscriber (an endpoint that went away must not burn the queue forever).
import { createHmac } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { envelopeOf, type OutboundEvent, type WebhookEnvelope } from './types.js';
import {
  activeSubscribersFor,
  dueDeliveries,
  enqueueDeliveries,
  getSubscriber,
  markDelivery,
  updateSubscriberStatus,
  type DeliveryRow,
  type Subscriber,
} from './store.js';

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];
const MAX_ATTEMPTS = 8;
const DELIVERY_TIMEOUT_MS = 10_000;
const TICK_BATCH = 20;

export function signPayload(secret: string, timestamp: number, body: string): string {
  return createHmac('sha256', secret).update(`t.${timestamp}.${body}`).digest('hex');
}

/** Bot-side header: hex hmac(secret, secret + "." + body). */
export function botSignature(secret: string, body: string): string {
  return createHmac('sha256', secret).update(`${secret}.${body}`).digest('hex');
}

/** Fan an event out to every active subscriber of its type (queue only —
 *  delivery happens on the cron tick, so emission never blocks the caller). */
export async function emit(event: OutboundEvent): Promise<number> {
  const id = crypto.randomUUID();
  const envelope = envelopeOf(event, id);
  const body = JSON.stringify(envelope);

  // The bot's /roles/sync endpoint takes { discordId } — translate the
  // subscriber-facing envelope into the bot's native push shape for the
  // internal subscriber so it can act without parsing the generic envelope.
  const botBody =
    event.type === 'subscription.updated' || event.type === 'player.prestige' || event.type === 'player.rankup'
      ? await botPushBody(event, id)
      : null;

  const subscribers = await activeSubscribersFor(event.type);
  const rows = subscribers.map((s) => ({
    subscriberId: s.id,
    eventId: id,
    type: event.type,
    payload: s.id === 'discord-bot' && botBody ? botBody : body,
  }));
  return enqueueDeliveries(rows);
}

/** Resolve the Discord id for a uuid-backed event (null when unlinked — the
 *  bot's nightly audit covers those members). */
async function botPushBody(event: OutboundEvent, id: string): Promise<string | null> {
  if (!('uuid' in event) || !event.uuid) return null;
  const { query } = await import('../db/pool.js');
  try {
    const result = await query<{ discord_id: string }>(
      'SELECT discord_id FROM discord_links WHERE uuid = $1 AND unlinked_at IS NULL LIMIT 1',
      [event.uuid],
    );
    const discordId = result.rows[0]?.discord_id;
    if (!discordId) return null;
    return JSON.stringify({ discordId, reason: `${event.type}:${id}`.slice(0, 64) });
  } catch {
    return null;
  }
}

async function deliverOne(row: DeliveryRow, subscriber: Subscriber, now: number): Promise<'delivered' | 'retry' | 'dead'> {
  const timestamp = Math.floor(now / 1000);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Imperium-Event-Id': row.event_id,
    'X-Imperium-Signature': `t=${timestamp},v1=${signPayload(subscriber.secret, timestamp, row.payload)}`,
  };
  if (subscriber.id === 'discord-bot') {
    headers['X-Signature'] = botSignature(subscriber.secret, row.payload);
  }

  let code = 0;
  let delivered = false;
  let lastError: string | null = null;
  try {
    const res = await fetch(subscriber.url, {
      method: 'POST',
      headers,
      body: row.payload,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    code = res.status;
    delivered = res.ok;
  } catch (err) {
    lastError = err instanceof Error ? err.message : 'network error';
  }

  const attempt = row.attempt + 1;
  if (delivered) {
    await markDelivery(row.subscriber_id, row.event_id, { status: 'delivered', responseCode: code, attempt });
    return 'delivered';
  }

  // Endpoint permanently gone: 3 consecutive 404/410s kill the subscriber.
  if (code === 404 || code === 410) {
    if (attempt >= 3) {
      await updateSubscriberStatus(row.subscriber_id, 'dead');
      await markDelivery(row.subscriber_id, row.event_id, {
        status: 'dead',
        responseCode: code,
        lastError: `subscriber dead after ${attempt} 4xx-gone attempts`,
        attempt,
      });
      logger.warn({ subscriber: row.subscriber_id }, 'webhook subscriber marked dead (404/410)');
      return 'dead';

    }
  }

  if (attempt >= MAX_ATTEMPTS) {
    await markDelivery(row.subscriber_id, row.event_id, {
      status: 'dead',
      responseCode: code || undefined,
      lastError: lastError ?? `gave up after ${attempt} attempts (last code ${code})`,
      attempt,
    });
    return 'dead';

  }

  const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
  await markDelivery(row.subscriber_id, row.event_id, {
    status: 'failed',
    responseCode: code || undefined,
    lastError: lastError ?? `HTTP ${code}`,
    nextAttemptAt: now + delay,
    attempt,
  });
  return 'retry';
}

export interface DeliveryTickReport {
  processed: number;
  delivered: number;
  retried: number;
  dead: number;
}

/** One cron pass: up to TICK_BATCH due deliveries. Never throws. */
export async function runDeliveryTick(now = Date.now()): Promise<DeliveryTickReport> {
  const report: DeliveryTickReport = { processed: 0, delivered: 0, retried: 0, dead: 0 };
  let due: DeliveryRow[];
  try {
    due = await dueDeliveries(TICK_BATCH, now);
  } catch (err) {
    logger.error({ err: String(err) }, 'webhook delivery tick: queue read failed');
    return report;
  }

  const subscriberCache = new Map<string, Subscriber | null>();
  for (const row of due) {
    report.processed += 1;
    try {
      let subscriber = subscriberCache.get(row.subscriber_id);
      if (subscriber === undefined) {
        subscriber = await getSubscriber(row.subscriber_id);
        subscriberCache.set(row.subscriber_id, subscriber);
      }
      if (!subscriber || subscriber.status !== 'active') {
        // Subscriber gone/paused — drop the delivery.
        await markDelivery(row.subscriber_id, row.event_id, { status: 'dead', lastError: 'subscriber inactive' });
        report.dead += 1;
        continue;
      }
      const outcome = await deliverOne(row, subscriber, now);
      if (outcome === 'delivered') report.delivered += 1;
      else if (outcome === 'retry') report.retried += 1;
      else report.dead += 1;
    } catch (err) {
      logger.error({ err: String(err), eventId: row.event_id }, 'webhook delivery crashed for one row');
    }
  }
  return report;
}

export type { WebhookEnvelope };
