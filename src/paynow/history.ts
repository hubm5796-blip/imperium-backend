/**
 * bC10 — PayNow (real-money) order history for the store-orders surfaces.
 *
 * The order-history surfaces only ever read web_queue (Denarius web-shop
 * rows), so every PayNow purchase — lifetime ranks, rank upgrades, Aureus
 * packs — vanished from the player's history the moment checkout completed.
 * This module merges the two sources the backend actually has:
 *
 *   1. PayNow's Management API order list (`listCustomerOrders`) — what was
 *      bought and when, straight from the payment processor.
 *   2. The local D1 dispatch ledger (`paynow_order_dispatches`) — our proof
 *      that a completed order's lines were actually dispatched in-game. A
 *      completed order WITH ledger rows maps to 'delivered'; without ledger
 *      evidence we say 'complete' (PayNow's truth) and never claim in-game
 *      delivery we can't prove.
 *
 * Failure discipline: this is an ENRICHMENT, not a gate. If the customer
 * lookup, the Management API call, or the ledger read fails, the caller gets
 * an empty list and serves the web-shop rows alone — order history must not
 * 503 because PayNow had a bad minute. Every stage logs at warn level.
 */
import { getD1, getPaynowCustomerId } from '../db/pool.js';
import { listCustomerOrders, type PaynowOrderDto } from './client.js';
import {
  findAureusPack,
  findRankUpgrade,
  findTierByLifetimeProductId,
} from './constants.js';
import { logger } from '../utils/logger.js';

/** One merged PayNow order row, shaped for the /shop/orders response. */
export interface PaynowHistoryOrder {
  kind: 'paynow';
  /** PayNow order id (FlakeId). */
  id: string;
  /** Human-facing "pn-…" identifier, when PayNow provides one. */
  prettyId: string | null;
  /** Product display name ("Aureus ×5600", "Rank upgrade → IMPERATOR", …). */
  sku: string;
  quantity: number;
  status: string;
  createdAt: string | null;
  processedAt: string | null;
  /** In-game delivery timestamp proven by the dispatch ledger, else null. */
  deliveredAt: string | null;
}

/** Short per-uuid memo so the orders page's poll burst doesn't hammer PayNow. */
const MEMO_TTL_MS = 30_000;
const memo = new Map<string, { at: number; orders: PaynowHistoryOrder[] }>();

/** Best-effort display label for a product id, preferring PayNow's own name. */
function labelForLine(productId?: string, productName?: string | null): string | null {
  if (productName && productName.trim()) return productName.trim().slice(0, 80);
  if (!productId) return null;
  const pack = findAureusPack(productId);
  if (pack) return `Aureus ×${pack.totalAureus}`;
  const upgrade = findRankUpgrade(productId);
  if (upgrade) return `Rank upgrade → ${upgrade.toTier}`;
  const tier = findTierByLifetimeProductId(productId);
  if (tier) return `${tier.id.charAt(0).toUpperCase()}${tier.id.slice(1)} rank (lifetime)`;
  return null;
}

/**
 * PayNow status → the store-orders vocabulary. 'delivered' is reserved for
 * orders the dispatch ledger can prove went out in-game; a 'completed' order
 * with no ledger rows (bought before the ledger existed, or lines skipped as
 * unknown products) is 'complete' — paid, per PayNow — never a fabricated
 * delivery claim. Unknown statuses pass through lowercase (the UI renders
 * them neutrally instead of lying about them).
 */
function mapOrderStatus(rawStatus: string, delivered: boolean): string {
  switch (rawStatus.toLowerCase()) {
    case 'completed':
      return delivered ? 'delivered' : 'complete';
    case 'created':
      return 'pending';
    default:
      return rawStatus.toLowerCase();
  }
}

/** Ledger evidence per order id: MAX(created_at) of that order's dispatched lines. */
async function ledgerDeliveredAt(orderIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (orderIds.length === 0) return out;
  try {
    const placeholders = orderIds.map(() => '?').join(', ');
    const result = await getD1()
      .prepare(
        `SELECT order_id, MAX(created_at) AS delivered_at
           FROM paynow_order_dispatches
          WHERE order_id IN (${placeholders})
          GROUP BY order_id`,
      )
      .bind(...orderIds)
      .all<{ order_id: string; delivered_at: string }>();
    for (const row of result.results ?? []) {
      if (row?.order_id && row.delivered_at) out.set(row.order_id, String(row.delivered_at));
    }
  } catch (err) {
    // Enrichment gap only: those orders will read 'complete' instead of
    // 'delivered'. Never fail the history over it.
    logger.warn({ err: String(err), count: orderIds.length }, 'paynow history: dispatch-ledger read failed — delivery evidence unavailable');
  }
  return out;
}

/**
 * The player's PayNow order history, newest first, or [] when unavailable
 * (no linked customer, PayNow down, ledger unreadable — all degrade quietly).
 * Never throws.
 */
export async function getPaynowOrdersForUuid(
  uuid: string,
  limit: number,
): Promise<PaynowHistoryOrder[]> {
  const cached = memo.get(uuid);
  if (cached && Date.now() - cached.at < MEMO_TTL_MS) {
    return cached.orders.slice(0, Math.max(1, limit));
  }

  let customerId: string | null = null;
  try {
    customerId = await getPaynowCustomerId(uuid);
  } catch (err) {
    logger.warn({ err: String(err), uuid }, 'paynow history: customer lookup failed — serving web-shop rows only');
    return [];
  }
  if (!customerId) return []; // never checked out via PayNow — nothing to show

  let dtos: PaynowOrderDto[];
  try {
    dtos = await listCustomerOrders(customerId, 50);
  } catch (err) {
    logger.warn({ err: String(err), uuid, customerId }, 'paynow history: Management API order list failed — serving web-shop rows only');
    return [];
  }

  const delivered = await ledgerDeliveredAt(dtos.map((o) => o.id).filter(Boolean));
  const orders: PaynowHistoryOrder[] = dtos.map((order) => {
    const lines = Array.isArray(order.lines) ? order.lines : [];
    const first = lines[0];
    const baseLabel = labelForLine(first?.product_id, first?.product_name) ?? 'Store Purchase';
    const deliveredAt = delivered.get(order.id) ?? null;
    return {
      kind: 'paynow',
      id: order.id,
      prettyId: order.pretty_id ?? null,
      sku: lines.length > 1 ? `${baseLabel} (+${lines.length - 1} more)` : baseLabel,
      quantity: Number.isFinite(Number(first?.quantity)) ? Number(first?.quantity) : 1,
      status: mapOrderStatus(order.status ?? '', deliveredAt !== null),
      createdAt: order.created_at ?? null,
      processedAt: deliveredAt ?? order.completed_at ?? null,
      deliveredAt,
    };
  });

  memo.set(uuid, { at: Date.now(), orders });
  return orders.slice(0, Math.max(1, limit));
}

/** Test seam: drop the memo between tests. */
export function __resetPaynowHistoryMemoForTests(): void {
  memo.clear();
}
