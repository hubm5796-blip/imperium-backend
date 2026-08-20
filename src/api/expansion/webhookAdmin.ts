// V6 05-03: webhook subscription management. Internal-only for now (bot
// token gate) — the api-key owner model arrives with auth v2 (04), at which
// point these routes scope by owner_id. Secrets are write-only: never in any
// response body.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { botTokenMatches } from '../../middleware/auth.js';
import { readRateLimit, writeRateLimit } from '../../middleware/rateLimit.js';
import { logger } from '../../utils/logger.js';
import { ALL_EVENT_TYPES, type OutboundEventType } from '../../webhooks/types.js';
import {
  createSubscriber,
  deleteSubscriber,
  getSubscriber,
  listDeliveries,
  listSubscribers,
} from '../../webhooks/store.js';
import { emit } from '../../webhooks/deliver.js';
import type { AppContextVariables } from '../../types/index.js';

type ApiEnv = { Variables: AppContextVariables };

export const webhooksApi = new Hono<ApiEnv>();

const createSchema = z.object({
  name: z.string().min(1).max(80),
  url: z.string().url().max(500),
  events: z.array(z.enum(ALL_EVENT_TYPES as [OutboundEventType, ...OutboundEventType[]])).min(1).max(10),
});

function requireBot(c: Context): boolean {
  return botTokenMatches(c);
}

/** POST /api/v2/webhooks/subscriptions — register a subscriber (internal). */
webhooksApi.post('/webhooks/subscriptions', writeRateLimit, async (c) => {
  if (!requireBot(c)) return c.json({ error: 'Unauthorized' }, 401);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid subscription', issues: parsed.error.issues.map((i) => i.message) }, 400);
  }
  try {
    const secret = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
    const created = await createSubscriber({
      name: parsed.data.name,
      url: parsed.data.url,
      secret,
      events: parsed.data.events,
      ownerKind: 'internal',
      ownerId: null,
    });
    // The ONLY response that ever includes the secret — at creation, to the
    // operator who just set it. Store it; it is not retrievable again.
    return c.json({ id: created.id, name: created.name, url: created.url, events: created.events, secret }, 201);
  } catch (err) {
    logger.error({ err: String(err) }, 'webhook subscription create failed');
    return c.json({ error: 'Create failed' }, 500);
  }
});

/** GET /api/v2/webhooks/subscriptions — list (secret redacted). */
webhooksApi.get('/webhooks/subscriptions', readRateLimit, async (c) => {
  if (!requireBot(c)) return c.json({ error: 'Unauthorized' }, 401);
  const subscribers = await listSubscribers();
  return c.json({
    subscribers: subscribers.map((s) => ({
      id: s.id,
      name: s.name,
      url: s.url,
      events: s.events,
      ownerKind: s.owner_kind,
      status: s.status,
    })),
  });
});

/** POST /api/v2/webhooks/subscriptions/:id/test — enqueue a test.ping. */
webhooksApi.post('/webhooks/subscriptions/:id/test', writeRateLimit, async (c) => {
  if (!requireBot(c)) return c.json({ error: 'Unauthorized' }, 401);
  const subscriber = await getSubscriber(c.req.param('id') ?? '');
  if (!subscriber) return c.json({ error: 'Subscriber not found' }, 404);
  if (subscriber.status !== 'active') return c.json({ error: `Subscriber is ${subscriber.status}` }, 409);
  const queued = await emit({ type: 'test.ping', v: 1, at: new Date().toISOString() });
  return c.json({ queued, note: 'Delivery happens on the next cron tick' });
});

/** DELETE /api/v2/webhooks/subscriptions/:id */
webhooksApi.delete('/webhooks/subscriptions/:id', writeRateLimit, async (c) => {
  if (!requireBot(c)) return c.json({ error: 'Unauthorized' }, 401);
  const removed = await deleteSubscriber(c.req.param('id') ?? '');
  if (!removed) return c.json({ error: 'Subscriber not found' }, 404);
  return c.json({ ok: true });
});

/** GET /api/v2/webhooks/deliveries?status=&limit= — queue inspection. */
webhooksApi.get('/webhooks/deliveries', readRateLimit, async (c) => {
  if (!requireBot(c)) return c.json({ error: 'Unauthorized' }, 401);
  const status = c.req.query('status');
  const rawLimit = Number.parseInt(c.req.query('limit') ?? '50', 10);
  const limit = Number.isNaN(rawLimit) ? 50 : Math.min(Math.max(rawLimit, 1), 200);
  const rows = await listDeliveries(status, limit);
  return c.json({
    deliveries: rows.map((r) => ({
      subscriberId: r.subscriber_id,
      eventId: r.event_id,
      type: r.type,
      attempt: r.attempt,
      status: r.status,
      responseCode: r.response_code,
      lastError: r.last_error,
    })),
  });
});
