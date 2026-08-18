// 12a expansion: web-facilitated write endpoints —
//   POST /api/vote/:site      (vote-site callback → web_queue row, kind='vote')
//   GET  /api/shop/catalog    (public catalog, SWR-cached)
//   POST /api/shop/order      (linked session → web_queue row, kind='shop_order')
//
// Both writes ONLY enqueue a signed web_queue row; the plugin's poller grants
// in-game (reason `web:vote` / `web:shop`) after verifying the row signature
// and re-validating pricing/identity. Vote callbacks are anonymous but
// key-authenticated (per-site shared secret in X-Vote-Key); shop orders come
// from the linked browser session.
import { timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { env } from '../../env.js';
import { botTokenMatches, requireAuth, requireLinked } from '../../middleware/auth.js';
import { readRateLimit, shopWriteRateLimit, writeRateLimit } from '../../middleware/rateLimit.js';
import { getNameByUuid, query } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { swrJson } from './cache.js';
import { SHOP_CATALOG, findShopItem } from './shopCatalog.js';
import { enqueueWebQueue } from './webqueue.js';
import { mcUuidSchema, shopOrderSchema, voteBodySchema } from './schemas.js';
import type { AppContextVariables } from '../../types/index.js';

type ApiEnv = { Variables: AppContextVariables };

export const webshopApi = new Hono<ApiEnv>();

/** 422/400 hook: keep the repo's {error: ...} response shape for validation failures. */
const validationHook = (result: { success: boolean }, c: Context) => {
  if (!result.success) {
    return c.json({ error: 'Validation failed' }, 400);
  }
};

/** Timing-safe shared-secret check (same discipline as requireBotAuth in routes.ts). */
function voteKeyMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/* --------------------------------------------------------------- Vote */

/**
 * POST /api/vote/:site — vote-site webhook callback.
 *
 * Auth: the `site` path slug must be configured in VOTE_CALLBACK_KEYS
 * ("site:key" pairs, a Workers secret — same convention as
 * PAYNOW_WEBHOOK_SECRETS) and the request must carry the matching key in
 * `X-Vote-Key`. Body (Zod): { username? , uuid? , timestamp? , payload? } with
 * at least one of uuid/username. The backend does NOT credit anything — it
 * inserts one signed web_queue row and 202s; the plugin resolves the identity,
 * dedups per (uuid, site, day) via vote_claims (existing behavior), and grants
 * the vote reward.
 */
webshopApi.post('/vote/:site', writeRateLimit, zValidator('json', voteBodySchema, validationHook), async (c) => {
  const site = (c.req.param('site') ?? '').toLowerCase();
  const expectedKey = env.voteCallbackKeys[site];
  if (!expectedKey) {
    // Unknown or unconfigured site — 404 so misconfigured vote-site URLs surface.
    return c.json({ error: 'Unknown vote site' }, 404);
  }
  const providedKey = c.req.header('X-Vote-Key') ?? '';
  if (!providedKey || !voteKeyMatches(providedKey, expectedKey)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const body = c.req.valid('json');
  try {
    const { id, requestId } = await enqueueWebQueue({
      kind: 'vote',
      uuid: body.uuid ?? null,
      username: body.username ?? null,
      site,
      payload: {
        timestamp: body.timestamp ?? null,
        sitePayload: body.payload ?? {},
      },
    });
    // 202 Accepted: the callback itself is valid; the grant happens plugin-side.
    return c.json({ ok: true, queued: true, id, requestId }, 202);
  } catch (err) {
    logger.error({ err, site }, 'vote enqueue failed');
    return c.json({ error: 'Queue unavailable — vote site should retry' }, 503);
  }
});

/* --------------------------------------------------------------- Shop */

/** GET /api/shop/catalog — public catalog, SWR-cached (static list, so effectively always fresh). */
webshopApi.get('/shop/catalog', readRateLimit, async (c) => {
  return await swrJson(c, 'shop:catalog:v1', async () => ({
    currency: 'denarius',
    note: 'Prices shown in Denarius; grants are delivered in-game by the server after checkout.',
    items: SHOP_CATALOG,
  }));
});

/**
 * POST /api/shop/order — place an order for a catalog SKU. Linked session
 * required (the buyer is the session's Minecraft account). The backend
 * validates the SKU, computes the total from the catalog, and enqueues a
 * signed web_queue row; the plugin re-validates the price, withdraws the
 * Denarius, and grants (AUREUS via EconomyService.depositPremium — the AUREUS
 * wall — or crate keys via CrateService). If the player lacks funds the plugin
 * marks the row `failed` and the queue id can be shown as the receipt.
 */
webshopApi.post('/shop/order', requireAuth, requireLinked, shopWriteRateLimit, zValidator('json', shopOrderSchema, validationHook), async (c) => {
  const uuid = c.var.mcUuid!;
  const body = c.req.valid('json');

  const item = findShopItem(body.sku);
  if (!item) {
    return c.json({ error: 'Unknown SKU' }, 404);
  }

  let username: string | null = null;
  try {
    username = await getNameByUuid(uuid);
  } catch {
    // Registry hiccup — the uuid is enough for the plugin to resolve.
  }

  try {
    const { id, requestId } = await enqueueWebQueue({
      kind: 'shop_order',
      uuid,
      username,
      sku: item.sku,
      quantity: body.quantity,
      payload: {
        kind: item.kind,
        unitPrice: item.price,
        totalPrice: item.price * body.quantity,
        grant: item.grant,
      },
    });
    return c.json({
      ok: true,
      queued: true,
      id,
      requestId,
      sku: item.sku,
      quantity: body.quantity,
      totalPrice: item.price * body.quantity,
      currency: 'denarius',
    }, 202);
  } catch (err) {
    logger.error({ err, uuid, sku: item.sku }, 'shop order enqueue failed');
    return c.json({ error: 'Queue unavailable — try again shortly' }, 503);
  }
});

/**
 * GET /api/shop/orders?uuid=&limit= — order history for one player: their
 * web_queue rows with kind='shop_order', newest first (12b companion read;
 * the queue id doubles as the receipt). Auth: a linked session may read its
 * OWN orders (uuid omitted or matching); the bot token may target any uuid
 * (the frontend's server-side proxy path). No cache — personal data.
 */
webshopApi.get('/shop/orders', readRateLimit, async (c) => {
  const queryUuid = c.req.query('uuid') ?? '';
  let uuid: string;
  if (queryUuid) {
    // Targeted read: bot only (same rule as /api/player/profile).
    if (!botTokenMatches(c)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const parsed = mcUuidSchema.safeParse(queryUuid);
    if (!parsed.success) {
      return c.json({ error: 'Invalid uuid parameter' }, 400);
    }
    uuid = parsed.data;
  } else {
    if (!c.var.user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (!c.var.mcUuid) {
      return c.json({ error: 'Minecraft account not linked', linkRequired: true }, 403);
    }
    uuid = c.var.mcUuid;
  }

  const limitRaw = Number.parseInt(c.req.query('limit') ?? '20', 10);
  const limit = Math.min(Math.max(Number.isNaN(limitRaw) ? 20 : limitRaw, 1), 50);

  try {
    const result = await query<{
      id: number | string;
      request_id: string;
      sku: string | null;
      quantity: number;
      status: string;
      created_at: Date;
      processed_at: Date | null;
      payload: Record<string, unknown> | null;
    }>(
      `SELECT id, request_id, sku, quantity, status, created_at, processed_at, payload
         FROM web_queue
        WHERE kind = 'shop_order' AND uuid = $1
        ORDER BY id DESC
        LIMIT $2`,
      [uuid, limit],
    );

    const orders = result.rows.map((row) => {
      // totalPrice lives in the (unsigned) payload; the catalog is the
      // signed source of truth, so re-derive when the payload is absent.
      const payloadTotal = Number(row.payload?.totalPrice);
      const catalogItem = row.sku ? findShopItem(row.sku) : undefined;
      const totalPrice =
        Number.isFinite(payloadTotal) && payloadTotal > 0
          ? payloadTotal
          : (catalogItem ? catalogItem.price * row.quantity : 0);
      return {
        id: String(row.id),
        requestId: row.request_id,
        sku: row.sku ?? '',
        quantity: Number(row.quantity ?? 1),
        totalPrice,
        currency: 'denarius',
        status: row.status,
        createdAt: row.created_at,
        processedAt: row.processed_at,
      };
    });

    return c.json({ uuid, orders }, 200, { 'Cache-Control': 'private, no-store' });
  } catch (err) {
    logger.error({ err, uuid }, 'shop orders read failed');
    return c.json({ error: 'Order history unavailable — try again shortly' }, 503);
  }
});
