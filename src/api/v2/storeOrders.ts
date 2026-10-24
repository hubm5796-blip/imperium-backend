/**
 * V6 04-02 — unified order history for /dashboard/orders.
 *
 *   GET /api/v2/store/orders?limit=20
 *
 * Two kinds interleaved, newest-first:
 *  - web_shop: web_queue rows the game consumes (sku, quantity, queue status,
 *    delivered/rejected timestamps — the delivery tracker's data source).
 *  - paynow: the player's REAL PayNow order history (bC10) — the Management
 *    API order list merged with the local dispatch ledger's delivery
 *    evidence (paynow/history.ts). 'delivered' means the ledger proves the
 *    lines went out in-game; a paid order without ledger evidence is
 *    'complete', not a fabricated delivery claim.
 *
 * Auth: the caller's own data — session (linked) or delegated proxy.
 */
import { Hono } from 'hono';
import { query } from '../../db/pool.js';
import { standardReadLimit } from '../../middleware/rateLimitV2-presets.js';
import { requireSelfOrDelegated } from '../../middleware/gates.js';
import { getPaynowOrdersForUuid } from '../../paynow/history.js';
import { logger } from '../../utils/logger.js';
import type { AppContextVariables } from '../../types/index.js';
import { limitParam } from '../../utils/paging.js';

type ApiEnv = { Variables: AppContextVariables };

export const storeOrdersV2 = new Hono<ApiEnv>();

storeOrdersV2.use('/store*', standardReadLimit, requireSelfOrDelegated);

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
      id: string;
      prettyId: string | null;
      sku: string;
      quantity: number;
      status: string;
      createdAt: string | null;
      processedAt: string | null;
      deliveredAt: string | null;
    };

storeOrdersV2.get('/store/orders', async (c) => {
  const uuid = c.get('mcUuid');
  if (!uuid) return c.json({ error: 'Unauthorized' }, 401);
  const limit = limitParam(c.req.query('limit'), 20, 50);
  try {
    const web = await query(
      `SELECT request_id, sku, quantity, status, created_at, processed_at, payload
       FROM web_queue WHERE uuid = $1 AND kind = 'shop_order' ORDER BY created_at DESC LIMIT $2`,
      [uuid, limit],
    );
    const webOrders: UnifiedOrder[] = web.rows.map((r) => {
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

    // bC10: the paynow half of the "unified" history — previously promised in
    // the docstring, never actually queried. Degrades to web-only on failure
    // (the helper never throws); unknown products and pre-ledger orders show
    // 'complete' rather than invented delivery evidence.
    const paynowOrders = await getPaynowOrdersForUuid(uuid, limit).catch(() => []);

    const orders: UnifiedOrder[] = [...webOrders, ...paynowOrders]
      .sort((a, b) => Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? ''))
      .slice(0, limit);

    return c.json({ orders });
  } catch (err) {
    logger.error({ err: String(err) }, 'v2 store orders failed');
    return c.json({ error: 'Order history unavailable' }, 503);
  }
});
