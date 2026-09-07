/**
 * B-C16/B-C19 — PayNow order fulfillment.
 *
 * ON_ORDER_COMPLETED used to fall into the webhook's `default: break`, so
 * every real-money one-time purchase (lifetime ranks, rank upgrades, Aureus
 * packs) was charged and never delivered: a paid-order black hole. This module
 * turns a completed order into signed Redis-bus commands the plugin's
 * WebPanelCommandHandler already knows:
 *
 *   Aureus pack            → STORE_PURCHASE_AUREUS   { player_uuid, amount, pack_name, order_id, transaction_id }
 *   Lifetime rank          → STORE_PURCHASE_RANK     { player_uuid, tier, subscription: 'PERMANENT', order_id, transaction_id }
 *   Rank upgrade           → STORE_PURCHASE_RANK     (same shape; tier = upgrade target)
 *   Crate-key bundle       → STORE_PURCHASE_CRATE_KEY{ player_uuid, crate_id, quantity, order_id, transaction_id }
 *   Booster pack (B-C33)   → STORE_PURCHASE_BOOSTER  { player_uuid, booster_id, quantity, order_id, transaction_id }
 *
 * Reliability model (each layer makes the next one cheap):
 *   1. D1 insert-or-ignore per (order_id, line_key) — webhook retries (and our
 *      own re-deliveries) never re-dispatch a line that already went out. The
 *      line_key carries the LINE INDEX (B-57) so two identical cart lines each
 *      claim their own key instead of colliding.
 *   2. The plugin's PurchaseRegistry dedupes on transaction_id — even a row
 *      lost before dispatch can't double-credit when it retries. Because that
 *      registry keys on transaction_id ALONE, every line beyond the first also
 *      carries a per-line suffix ("orderId:L1", …) so identical lines aren't
 *      swallowed as duplicates plugin-side (the other half of B-57).
 *   3. Dispatch failures surface as HTTP 500 from the webhook so PayNow
 *      retries until the plugin is reachable — a fire-and-forget PUBLISH would
 *      silently lose the order whenever the game server is down.
 *
 * The crate-key and booster branches are fully implemented end-to-end but
 * their PayNow catalogs are OWNER DATA and ship empty (B-C30/B-C33): the
 * products must be created in the PayNow dashboard first, then one entry per
 * product in CRATE_KEY_PACKS / BOOSTER_PACKS (constants.ts) lights up
 * checkout validation AND this dispatch with no further code.
 */
import { getD1, getUuidByPaynowCustomerId, setPaynowCustomerId } from '../db/pool.js';
import { sendCommandWithResponse } from '../db/redis.js';
import { getPaynowCustomer } from './client.js';
import {
  findAureusPack,
  findBoosterPack,
  findCrateKeyPack,
  findRankUpgrade,
  findTierByLifetimeProductId,
} from './constants.js';
import { logger } from '../utils/logger.js';

/* ── event-name normalization ─────────────────────────────────────────────── */

export type CanonicalPaynowEvent =
  | 'order_completed'
  | 'subscription_activated'
  | 'subscription_renewed'
  | 'subscription_canceled'
  | 'unknown';

/**
 * PayNow's docs spell event enums ON_ORDER_COMPLETED, the existing webhook
 * switch matched CamelCase (OnSubscriptionActivated), and the fix prompt also
 * references dotted snake (order.completed). Normalize all three families to
 * one canonical token instead of betting on a single spelling.
 */
export function normalizePaynowEventType(raw: string): CanonicalPaynowEvent {
  const compact = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (compact === 'onordercompleted' || compact === 'ordercompleted') return 'order_completed';
  if (compact === 'onsubscriptionactivated' || compact === 'subscriptionactivated') return 'subscription_activated';
  if (compact === 'onsubscriptionrenewed' || compact === 'subscriptionrenewed') return 'subscription_renewed';
  if (compact === 'onsubscriptioncanceled' || compact === 'subscriptioncanceled') return 'subscription_canceled';
  return 'unknown';
}

/* ── order parsing (defensive — payload shapes per PayNow's OrderDTO) ─────── */

export interface ParsedOrderLine {
  productId: string;
  quantity: number;
  /** PayNow customer id when this line is a gift (deliver to recipient, not buyer). */
  giftCustomerId: string | null;
}

export interface ParsedOrder {
  orderId: string;
  customerId: string;
  /** Minecraft UUID embedded in the order's customer object, when present. */
  customerMinecraftUuid: string | null;
  lines: ParsedOrderLine[];
}

function str(v: unknown): string {
  return typeof v === 'string' && v.length > 0 ? v : '';
}

/** Extract the durable fields we dispatch on from an ON_ORDER_COMPLETED body. */
export function parsePaynowOrder(body: Record<string, unknown>): ParsedOrder | null {
  const orderId = str(body['id']) || str(body['order_id']);
  const customer = body['customer'] as Record<string, unknown> | undefined;
  const customerId = str(body['customer_id']) || str(customer?.['id']);
  if (!orderId || !customerId) return null;

  const minecraft = customer?.['minecraft'] as Record<string, unknown> | undefined;
  const customerMinecraftUuid = str(minecraft?.['id']) || str(body['minecraft_uuid']) || null;

  const rawLines = Array.isArray(body['lines'])
    ? body['lines']
    : Array.isArray(body['products'])
      ? body['products']
      : Array.isArray(body['items'])
        ? body['items']
        : [];
  const lines: ParsedOrderLine[] = [];
  for (const raw of rawLines) {
    if (typeof raw !== 'object' || raw === null) continue;
    const line = raw as Record<string, unknown>;
    const productId = str(line['product_id']) || str(line['id']);
    if (!productId) continue;
    const qtyRaw = Number(line['quantity'] ?? 1);
    const quantity = Number.isFinite(qtyRaw) ? Math.min(99, Math.max(1, Math.floor(qtyRaw))) : 1;
    const gift = line['gift_to_customer'] as Record<string, unknown> | undefined;
    lines.push({ productId, quantity, giftCustomerId: str(gift?.['id']) || null });
  }
  return { orderId, customerId, customerMinecraftUuid, lines };
}

/* ── product → dispatch mapping ───────────────────────────────────────────── */

export type ResolvedStoreDispatch =
  | { kind: 'aureus'; amount: number; packName: string }
  | { kind: 'rank'; tier: string }
  | { kind: 'crate_key'; crateId: string; keyAmount: number }
  | { kind: 'booster'; boosterId: string; boosterAmount: number };

/** Map a PayNow product id to the in-game delivery it must trigger, or null if unknown. */
export function resolveStoreDispatch(productId: string): ResolvedStoreDispatch | null {
  const pack = findAureusPack(productId);
  if (pack) return { kind: 'aureus', amount: pack.totalAureus, packName: `aureus_${pack.totalAureus}` };

  const upgrade = findRankUpgrade(productId);
  if (upgrade) return { kind: 'rank', tier: upgrade.toTier };

  const lifetimeTier = findTierByLifetimeProductId(productId);
  if (lifetimeTier) return { kind: 'rank', tier: lifetimeTier.id.toUpperCase() };

  const crate = findCrateKeyPack(productId);
  if (crate) return { kind: 'crate_key', crateId: crate.crateId, keyAmount: crate.keyAmount };

  const booster = findBoosterPack(productId);
  if (booster) return { kind: 'booster', boosterId: booster.boosterId, boosterAmount: booster.boosterAmount };

  return null;
}

/**
 * The signed Redis-bus command for one resolved product, per the plugin's
 * WebPanelCommandHandler contract.
 *
 * B-C26: `quantity` is the ORDER LINE quantity and multiplies stackable goods
 * — Aureus packs credit `amount * quantity`, crate-key bundles deliver
 * `keyAmount * quantity` keys, and booster packs deliver `boosterAmount *
 * quantity` units (B-C33). Rank grants are NOT stackable (rank 3x is still
 * one rank), so the rank branch deliberately ignores it. Default 1 keeps direct
 * callers (single-unit paths) unchanged.
 *
 * B-57: `transactionId` defaults to the order id (PayNow's order webhook has
 * no separate payment id, and it is unique per purchase which is what the
 * plugin's registry dedupe needs). Callers dispatching a MULTI-line order must
 * pass a per-line id ("orderId:L1", …): the plugin's PurchaseRegistry dedupes
 * on transaction_id ALONE, so two identical lines sharing the order id would
 * have the second swallowed as a duplicate. Line 0 keeps the bare order id so
 * retries of already-dispatched single-line orders stay dedupe-compatible.
 */
export function buildStoreDispatchCommand(
  resolved: ResolvedStoreDispatch,
  playerUuid: string,
  orderId: string,
  quantity: number = 1,
  transactionId?: string,
): { type: string; payload: Record<string, unknown> } {
  // parsePaynowOrder clamps line quantity to 1..99; clamp again so direct
  // callers can't zero-out or inflate a delivery.
  const qty = Math.max(1, Math.min(99, Math.floor(quantity)));
  const transaction_id = transactionId ?? orderId;
  switch (resolved.kind) {
    case 'aureus':
      return {
        type: 'STORE_PURCHASE_AUREUS',
        payload: { player_uuid: playerUuid, amount: resolved.amount * qty, pack_name: resolved.packName, order_id: orderId, transaction_id },
      };
    case 'rank':
      return {
        type: 'STORE_PURCHASE_RANK',
        payload: { player_uuid: playerUuid, tier: resolved.tier, subscription: 'PERMANENT', order_id: orderId, transaction_id },
      };
    case 'crate_key':
      return {
        type: 'STORE_PURCHASE_CRATE_KEY',
        payload: { player_uuid: playerUuid, crate_id: resolved.crateId, quantity: resolved.keyAmount * qty, order_id: orderId, transaction_id },
      };
    case 'booster':
      // B-C33: same stackable-goods semantics as crate keys — one pack carries
      // boosterAmount units and the order-line quantity multiplies them. The
      // plugin's handler validates booster_id against its BoosterType enum
      // (case-insensitive) and queues via PendingGrantService for offline buyers.
      return {
        type: 'STORE_PURCHASE_BOOSTER',
        payload: { player_uuid: playerUuid, booster_id: resolved.boosterId, quantity: resolved.boosterAmount * qty, order_id: orderId, transaction_id },
      };
  }
}

/* ── buyer / recipient resolution ─────────────────────────────────────────── */

/**
 * Resolve the Minecraft UUID for a PayNow customer id, or null.
 * Order: the UUID embedded in the order body → our paynow_customers cache →
 * (B-C23 fallback) PayNow's Management API, caching the result. The fallback
 * closes the permanent-desync hole where a checkout was created through a path
 * that never populated our cache.
 */
export async function resolveCustomerUuid(
  customerId: string,
  embeddedUuid: string | null,
): Promise<string | null> {
  if (embeddedUuid) return embeddedUuid;

  const cached = await getUuidByPaynowCustomerId(customerId).catch((err: unknown) => {
    logger.warn({ err: String(err), customerId }, 'fulfillment: paynow_customers lookup failed');
    return null;
  });
  if (cached) return cached;

  try {
    const customer = await getPaynowCustomer(customerId);
    const uuid = customer.minecraft_uuid ?? customer.minecraft?.id ?? null;
    if (uuid) {
      // Cache so later webhooks resolve locally. Non-fatal: a failed cache
      // write just means the next webhook re-runs this fallback.
      try {
        await setPaynowCustomerId(uuid, customerId);
      } catch {
        // ignore
      }
      return uuid;
    }
    logger.error({ customerId }, 'fulfillment: PayNow customer has no linked Minecraft UUID — delivery impossible until linked');
    return null;
  } catch (err) {
    logger.warn({ err: String(err), customerId }, 'fulfillment: Management API customer fallback failed');
    return null;
  }
}

/* ── idempotency (layer 1) ────────────────────────────────────────────────── */

/**
 * Claim a (order_id, line_key) pair for dispatch. Returns true when this call
 * is the first to claim it (dispatch should proceed), false when the line was
 * already dispatched (skip). When D1/the table is unavailable it fails OPEN
 * (returns true) — the plugin's registry dedupe is the hard guarantee; this
 * layer only avoids pointless re-dispatch.
 */
async function claimOrderLine(orderId: string, lineKey: string, commandType: string): Promise<boolean> {
  try {
    const result = await getD1()
      .prepare(
        `INSERT INTO paynow_order_dispatches (order_id, line_key, command, created_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT (order_id, line_key) DO NOTHING`,
      )
      .bind(orderId, lineKey, commandType)
      .run();
    return (result.meta.changes ?? 1) > 0;
  } catch (err) {
    logger.warn({ err: String(err), orderId, lineKey }, 'fulfillment: dispatch-claim write failed — proceeding (plugin registry still dedupes)');
    return true;
  }
}

/**
 * Roll back a claim after a FAILED dispatch. The claim exists to suppress
 * PayNow webhook RETRIES — but a retry must re-attempt lines that never
 * delivered. Leaving the claim in place after a failure would turn one
 * transient plugin outage into a permanently undelivered paid line, which is
 * the exact black hole this module exists to close.
 */
async function releaseOrderLine(orderId: string, lineKey: string): Promise<void> {
  try {
    await getD1()
      .prepare('DELETE FROM paynow_order_dispatches WHERE order_id = ? AND line_key = ?')
      .bind(orderId, lineKey)
      .run();
  } catch {
    // Worst case a retry is skipped as a duplicate; the plugin's registry
    // dedupe makes re-dispatch safe anyway, so this stays a warning-level gap.
  }
}

/* ── orchestration ────────────────────────────────────────────────────────── */

export interface FulfillmentResult {
  /**
   * 'ok' — lines dispatched (or safely skipped) and the order is settled.
   * 'error' — delivery failed; the webhook MUST 500 so PayNow retries.
   * 'empty_order' (B-59) — the order parsed but had NO lines. Not 'ok': an
   *   empty body is either a PayNow test ping or a malformed OrderDTO, and
   *   answering ok would let PayNow treat a possibly-malformed order as
   *   delivered. The webhook still answers 200 (a test ping must not trigger
   *   a retry storm) but flags the order as explicitly not-dispatched.
   */
  status: 'ok' | 'error' | 'empty_order';
  dispatched: number;
  skippedDuplicate: number;
  skippedUnknownProduct: number;
  error?: string;
}

/** Per-line dispatch timeout — bounded so a dead plugin can't hang the webhook. */
const DISPATCH_TIMEOUT_MS = 6_000;

/**
 * Fulfill one completed order: resolve the buyer, then dispatch every known
 * product line to the plugin over the signed Redis bus. Lines run in parallel
 * and each is independently idempotent; ANY delivery failure marks the whole
 * result as an error so the webhook returns non-2xx and PayNow retries (the
 * already-delivered lines dedupe out on retry).
 */
export async function fulfillPaynowOrder(body: Record<string, unknown>): Promise<FulfillmentResult> {
  const order = parsePaynowOrder(body);
  if (!order) {
    return { status: 'error', dispatched: 0, skippedDuplicate: 0, skippedUnknownProduct: 0, error: 'order body missing id/customer' };
  }

  // B-59: an order that parses but carries NO lines is not a delivery. It is
  // either a PayNow test ping or a malformed OrderDTO (lines under a key we
  // don't parse) — pre-fix this fell through to {ok, dispatched:0} and the
  // webhook's 200 told PayNow a possibly-malformed order was delivered. Return
  // a distinct not-ok status BEFORE any buyer resolution (an empty order must
  // not spend a Management API lookup); the webhook answers 200 but flags it.
  if (order.lines.length === 0) {
    const error = `order ${order.orderId}: no lines to dispatch (test ping or malformed OrderDTO)`;
    logger.error({ orderId: order.orderId, customerId: order.customerId }, `PayNow order fulfillment: ${error}`);
    return { status: 'empty_order', dispatched: 0, skippedDuplicate: 0, skippedUnknownProduct: 0, error };
  }

  const buyerUuid = await resolveCustomerUuid(order.customerId, order.customerMinecraftUuid);
  if (!buyerUuid) {
    return { status: 'error', dispatched: 0, skippedDuplicate: 0, skippedUnknownProduct: 0, error: `unresolvable customer ${order.customerId}` };
  }

  let dispatched = 0;
  let skippedDuplicate = 0;
  let skippedUnknownProduct = 0;
  const failures: string[] = [];

  await Promise.all(
    order.lines.map(async (line, lineIndex) => {
      const resolved = resolveStoreDispatch(line.productId);
      if (!resolved) {
        // Unknown product: never block the rest of the order — log and move on.
        skippedUnknownProduct++;
        logger.warn({ productId: line.productId, orderId: order.orderId }, 'fulfillment: order line is not a known store product — skipped');
        return;
      }

      // Gifts deliver to the recipient; everything else to the buyer.
      let targetUuid = buyerUuid;
      if (line.giftCustomerId && line.giftCustomerId !== order.customerId) {
        const recipientUuid = await resolveCustomerUuid(line.giftCustomerId, null);
        if (!recipientUuid) {
          failures.push(`gift recipient unresolvable: ${line.giftCustomerId}`);
          return;
        }
        targetUuid = recipientUuid;
      }

      // B-C26: pass the line quantity so multi-pack/multi-bundle buyers get
      // amount/keys multiplied by what they paid for.
      //
      // B-57: the claim key carries the line INDEX — two identical cart lines
      // (same product, quantity, target) used to collide on one key, so the
      // second was skippedDuplicate and never dispatched. And because the
      // plugin's PurchaseRegistry dedupes on transaction_id alone, lines past
      // the first get a ":L<index>" transaction id so they aren't swallowed
      // plugin-side either. Line 0 keeps the bare order id so retries of
      // already-dispatched single-line orders stay registry-compatible.
      const transactionId = lineIndex === 0 ? order.orderId : `${order.orderId}:L${lineIndex}`;
      const command = buildStoreDispatchCommand(resolved, targetUuid, order.orderId, line.quantity, transactionId);
      const lineKey = `${lineIndex}:${line.productId}:${line.quantity}:${targetUuid}`;
      if (!(await claimOrderLine(order.orderId, lineKey, command.type))) {
        skippedDuplicate++;
        return;
      }

      try {
        const response = await sendCommandWithResponse(command.type, command.payload, DISPATCH_TIMEOUT_MS);
        if (!response.ok) {
          failures.push(`${command.type} rejected: ${response.error ?? response.status}`);
          await releaseOrderLine(order.orderId, lineKey);
          return;
        }
        dispatched++;
      } catch (err) {
        failures.push(`${command.type} dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
        await releaseOrderLine(order.orderId, lineKey);
      }
    }),
  );

  if (failures.length > 0) {
    logger.error({ orderId: order.orderId, buyerUuid, failures, dispatched }, 'PayNow order fulfillment FAILED — webhook will 500 so PayNow retries');
    return {
      status: 'error',
      dispatched,
      skippedDuplicate,
      skippedUnknownProduct,
      error: `order ${order.orderId}: ${failures.join('; ')}`,
    };
  }

  logger.info({ orderId: order.orderId, buyerUuid, dispatched, skippedDuplicate, skippedUnknownProduct }, 'PayNow order fulfilled');
  return { status: 'ok', dispatched, skippedDuplicate, skippedUnknownProduct };
}
