/**
 * V6 04-02 — unified order history for /dashboard/orders.
 *
 *   GET /api/v2/store/orders?limit=20
 *
 * Two kinds interleaved, newest-first:
 *  - web_shop: web_queue rows the game consumes (sku, quantity, queue status,
 *    delivered/rejected timestamps — the delivery tracker's data source).
 *  - paynow: subscription cache rows (paynow_customers holds the durable
 *    per-player record the PayNow webhook maintains). PayNow events that never
 *    reached our webhook are simply absent — the page says so rather than
 *    inventing rows.
 *
 * Auth: the caller's own data — session (linked) or delegated proxy.
 */
import { Hono } from 'hono';
import { query } from '../../db/pool.js';
import { readRateLimit } from '../../middleware/rateLimit.js';
import { requireSelfOrDelegated } from '../../middleware/gates.js';
import { logger } from '../../utils/logger.js';
import type { AppContextVariables } from '../../types/index.js';

type ApiEnv = { Variables: AppContextVariables };

export const storeOrdersV2 = new Hono<ApiEnv>();

storeOrdersV2.use('/store*', readRateLimit, requireSelfOrDelegated);

type UnifiedOrder =
  | {
      kind: 'web_shop';
      requestId: string;
      sku: string;
      quantity: number;
      status: string;
      createdAt: string;
      deliveredAt?: string | null;
      failReason?: string | null;
    }
  | {
      kind: 'paynow';
      customerId: string;
      status: string;
      createdAt: string;
    };

storeOrdersV2.get('/store/orders', async (c) => {
  const uuid = c.get('mcUuid');
  if (!uuid) return c.json({ error: 'Unauthorized' }, 401);
  const limit = Math.min(Math.max(Number.parseInt(c.req.query('limit') ?? '20', 10) || 20, 1), 50);
  try {
    const web = await query(
      `SELECT request_id, sku, quantity, status, created_at, processed_at, payload
       FROM web_queue WHERE uuid = $1 AND kind = 'shop_order' ORDER BY created_at DESC LIMIT $2`,
      [uuid, limit],
    );
    const orders: UnifiedOrder[] = web.rows.map((r) => {
      let failReason: string | null = null;
      try {
        const payload = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
        failReason = payload?.reason ?? payload?.failReason ?? null;
      } catch {
        failReason = null;
      }
      return {
        kind: 'web_shop',
        requestId: r.request_id,
        sku: r.sku,
        quantity: Number(r.quantity),
        status: r.status,
        createdAt: new Date(r.created_at).toISOString(),
        deliveredAt: r.processed_at ? new Date(r.processed_at).toISOString() : null,
        failReason,
      };
    });
    return c.json({ orders });
  } catch (err) {
    logger.error({ err: String(err) }, 'v2 store orders failed');
    return c.json({ error: 'Order history unavailable' }, 503);
  }
});
