/**
 * S2-D09 — the revenue summary: gross, refunds, chargebacks, per-SKU,
 * per-period, for GET /admin/revenue/summary.
 *
 * THE HONEST DATA-MAP (inspected 2026-10-27, packet directive):
 *   - migrations/d1_0001_paynow_subscriptions.sql — uuid, subscription_id,
 *     product_id, status (subscription state), updated_at. NO amounts, NO
 *     order lifecycle.
 *   - migrations/d1_0002_paynow_order_dispatches.sql — order_id, line_key,
 *     command, created_at. NO amounts, NO statuses.
 *   - migrations/d1_0004_delivery_ledger.sql — order/line identity,
 *     product_id, sku_label, DELIVERY status (pending/delivered/failed/stale
 *     — not a payment status), timestamps. NO amounts.
 *
 * No D1 column carries a monetary amount or a payment status. The amounts
 * and the completed/refunded/chargeback statuses live only in the PayNow
 * Management API (GET /v1/stores/{id}/orders — total_amount is an integer in
 * the smallest currency unit, per src/paynow/client.ts's PaynowOrderDto).
 * This module therefore has two layers, and the payload LABELS them:
 *
 *   money     — aggregated from the Management API's store orders when the
 *               store key is configured (it is required at boot, so the
 *               not-configured case is a hard failure upstream, not a silent
 *               zero); an API failure is served as money.available=false with
 *               the reason — a partial truth, never fabricated zeros;
 *   d1_ledger — what IS stored: order counts, per-SKU lines, delivery
 *               statuses. `amounts_stored: false`, stated in the payload.
 *
 * The reconciliation anchor (the store's only historical order, per
 * docs/season-2/BACKEND-WORK-QUEUE.md): pn-4hgmdwlcglc0, $149.99 = 14999
 * minor units, 2026-08-09, "Imperator (Lifetime)". The amount is NOT in D1 —
 * the unit tests pin the aggregation against that exact order shape fetched
 * from the API; the D1 ledger block corroborates the order's existence,
 * SKU and delivery. Live reconciliation is a post-deploy curl (owner keys).
 *
 * Bounding: one orders page of up to 100 (the Management API's max limit) on
 * an 8s deadline with a 2MB body cap; a full page reports truncated:true
 * rather than pretending completeness — pagination semantics we have not
 * verified are not guessed at.
 */
import { env } from '../env.js';
import { getD1 } from '../db/pool.js';
import { logger } from '../utils/logger.js';

export type RevenueGranularity = 'month' | 'week';

/** Structural subset of PayNow's order DTO — loosely typed upstream, so
 *  every field is defensive (the client's PaynowOrderDto, mirrored locally
 *  to keep this module free of the PayNow client's env dependency). */
export interface RevenueOrder {
  id: string;
  pretty_id?: string | null;
  /** created | completed | canceled | refunded | chargeback (their enum). */
  status?: string | null;
  type?: string | null;
  created_at?: string | null;
  completed_at?: string | null;
  /** Integer in the smallest currency unit (cents for USD). */
  total_amount?: number | null;
  currency?: string | null;
  lines?: RevenueOrderLine[] | null;
}

export interface RevenueOrderLine {
  product_id?: string | null;
  product_name?: string | null;
  quantity?: number | null;
  /** Per-line totals when PayNow includes them (checked defensively). */
  total_amount?: number | null;
  unit_price?: number | null;
}

/* ── Period keys ──────────────────────────────────────────────────────────── */

/** 'YYYY-MM' from an epoch ms (UTC). */
export function monthKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 7);
}

/** ISO-8601 week 'YYYY-Www' (weeks start Monday; the year of the week's
 *  Thursday names the week — 2027-01-01 is still 2026-W53). */
export function isoWeekKey(ts: number): string {
  const d = new Date(ts);
  const day = d.getUTCDay() || 7; // 1..7, Monday=1
  d.setUTCDate(d.getUTCDate() + 4 - day); // this week's Thursday
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function periodKey(granularity: RevenueGranularity, ts: number): string {
  return granularity === 'week' ? isoWeekKey(ts) : monthKey(ts);
}

/* ── The aggregation (pure — fully unit-tested against the known order) ──── */

const GROSS_STATUSES = new Set(['completed']);
const REFUND_STATUSES = new Set(['refunded']);
const CHARGEBACK_STATUSES = new Set(['chargeback']);

export interface RevenueTotals {
  gross_minor: number;
  refunds_minor: number;
  chargebacks_minor: number;
  net_minor: number;
  orders_completed: number;
  orders_refunded: number;
  orders_chargeback: number;
  /** created/canceled/anything unknown — counted, never counted as money. */
  orders_other: number;
  orders_total: number;
  /** order money that could not be attributed to a SKU (multi-line orders
   *  without per-line amounts) — totals and SKU sums reconcile exactly. */
  unattributed_minor: number;
}

export interface RevenueSku {
  product_id: string;
  label: string;
  units: number;
  gross_minor: number;
  refunds_minor: number;
  chargebacks_minor: number;
  net_minor: number;
}

export interface RevenueSummary {
  totals: RevenueTotals;
  periods: Array<{ period: string } & RevenueTotals>;
  skus: RevenueSku[];
  /** distinct non-null currencies seen on the orders (lowercased). */
  currencies: string[];
  /** the day each order was anchored to was missing — excluded from periods
   *  only; totals stay complete. Zero in any sane dataset. */
  unplaced: number;
}

function emptyTotals(): RevenueTotals {
  return {
    gross_minor: 0,
    refunds_minor: 0,
    chargebacks_minor: 0,
    net_minor: 0,
    orders_completed: 0,
    orders_refunded: 0,
    orders_chargeback: 0,
    orders_other: 0,
    orders_total: 0,
    unattributed_minor: 0,
  };
}

function addInto(target: RevenueTotals, delta: RevenueTotals): void {
  for (const key of Object.keys(delta) as Array<keyof RevenueTotals>) {
    target[key] += delta[key];
  }
}

function withNet(t: RevenueTotals): RevenueTotals {
  return { ...t, net_minor: t.gross_minor - t.refunds_minor - t.chargebacks_minor };
}

/** The minor-unit amount a line carries, derivable WITHOUT guessing:
 *  per-line total, else unit_price × quantity, else null. */
function lineAmountMinor(line: RevenueOrderLine): number | null {
  if (typeof line.total_amount === 'number' && Number.isFinite(line.total_amount)) {
    return line.total_amount;
  }
  if (typeof line.unit_price === 'number' && typeof line.quantity === 'number' && Number.isFinite(line.unit_price)) {
    return line.unit_price * Math.max(1, line.quantity);
  }
  return null;
}

/**
 * Attribute one order's money to its bucket (gross/refund/chargeback) and
 * its SKU lines. Attribution invariant (what the buyer PAID is the anchor):
 *
 *   - single-line order → the ORDER total IS the line total (tax-inclusive;
 *     the contract's reconciliation anchor is the order total), attributed
 *     to that line's SKU;
 *   - multi-line order  → per-line amounts when PayNow derives them, and any
 *     positive residual (order total − attributed sum) lands in
 *     unattributed_minor — multi-line money is NEVER split by guesswork;
 *   - lineless order    → the money is real, the SKU is unknown: it lands in
 *     unattributed_minor so no money vanishes from the totals.
 *
 * Totals and SKU sums therefore always reconcile exactly.
 */
function attributeOrder(order: RevenueOrder, bucket: 'gross' | 'refunds' | 'chargebacks'): {
  totals: RevenueTotals;
  skus: Map<string, RevenueSku>;
} {
  const totals = emptyTotals();
  const skus = new Map<string, RevenueSku>();
  totals.orders_total = 1;
  if (bucket === 'gross') totals.orders_completed = 1;
  else if (bucket === 'refunds') totals.orders_refunded = 1;
  else totals.orders_chargeback = 1;

  const orderAmount =
    typeof order.total_amount === 'number' && Number.isFinite(order.total_amount) ? order.total_amount : 0;
  const lines = (order.lines ?? []).filter(
    (l): l is RevenueOrderLine => Boolean(l) && typeof l === 'object',
  );

  if (lines.length === 0) {
    totals.unattributed_minor += orderAmount;
    if (bucket === 'gross') totals.gross_minor += orderAmount;
    else if (bucket === 'refunds') totals.refunds_minor += orderAmount;
    else totals.chargebacks_minor += orderAmount;
    return { totals: withNet(totals), skus };
  }

  const singleLine = lines.length === 1;
  let skuSum = 0;
  for (const line of lines) {
    // Single line: the order total (tax-inclusive) beats any per-line amount.
    const attributed = singleLine ? orderAmount : lineAmountMinor(line) ?? 0;
    skuSum += attributed;

    const productId = line.product_id ? String(line.product_id) : '(unknown-product)';
    const sku = skus.get(productId) ?? {
      product_id: productId,
      label: line.product_name ? String(line.product_name) : productId,
      units: 0,
      gross_minor: 0,
      refunds_minor: 0,
      chargebacks_minor: 0,
      net_minor: 0,
    };
    if (bucket === 'gross') {
      sku.units += Math.max(1, Math.floor(Number(line.quantity) || 1));
      sku.gross_minor += attributed;
    } else if (bucket === 'refunds') {
      sku.refunds_minor += attributed;
    } else {
      sku.chargebacks_minor += attributed;
    }
    skus.set(productId, sku);
  }

  const unattributed = singleLine ? 0 : Math.max(0, orderAmount - skuSum);
  totals.unattributed_minor += unattributed;
  const bucketMoney = skuSum + unattributed;
  if (bucket === 'gross') totals.gross_minor += bucketMoney;
  else if (bucket === 'refunds') totals.refunds_minor += bucketMoney;
  else totals.chargebacks_minor += bucketMoney;

  return { totals: withNet(totals), skus };
}

/**
 * Aggregate orders into the summary. `from`/`to` are inclusive 'YYYY-MM-DD'
 * bounds on the order's anchor day (completed_at, else created_at); an order
 * anchored outside the window is excluded ENTIRELY — totals, periods and
 * SKUs all describe the requested window (with no filter, that is all time).
 * An order with NO parsable anchor stays in totals (it cannot be placed, and
 * dropping it would understate the all-time answer) and increments
 * `unplaced`; it is never in a period.
 */
export function summarizeRevenue(
  orders: RevenueOrder[],
  opts: { granularity: RevenueGranularity; from?: string; to?: string },
): RevenueSummary {
  const totals = emptyTotals();
  const periods = new Map<string, RevenueTotals>();
  const skus = new Map<string, RevenueSku>();
  const currencies = new Set<string>();
  let unplaced = 0;

  for (const order of orders) {
    if (!order || typeof order.id !== 'string') continue;
    if (typeof order.currency === 'string' && order.currency) currencies.add(order.currency.toLowerCase());

    const anchorRaw = order.completed_at ?? order.created_at ?? null;
    const anchorMs = anchorRaw ? Date.parse(anchorRaw) : Number.NaN;
    let anchorDay: string | null = null;
    if (!Number.isNaN(anchorMs)) {
      anchorDay = new Date(anchorMs).toISOString().slice(0, 10);
      const inWindow = (!opts.from || anchorDay >= opts.from) && (!opts.to || anchorDay <= opts.to);
      if (!inWindow) continue; // outside the requested window entirely
    }

    const bucket: 'gross' | 'refunds' | 'chargebacks' | null = GROSS_STATUSES.has(order.status ?? '')
      ? 'gross'
      : REFUND_STATUSES.has(order.status ?? '')
        ? 'refunds'
        : CHARGEBACK_STATUSES.has(order.status ?? '')
          ? 'chargebacks'
          : null;

    let delta: RevenueTotals;
    let orderSkus: Map<string, RevenueSku>;
    if (bucket) {
      const attributed = attributeOrder(order, bucket);
      delta = attributed.totals;
      orderSkus = attributed.skus;
    } else {
      delta = emptyTotals();
      delta.orders_total = 1;
      delta.orders_other = 1;
      orderSkus = new Map();
    }

    addInto(totals, delta);
    if (Number.isNaN(anchorMs)) {
      if (bucket) unplaced += 1;
    } else {
      const key = periodKey(opts.granularity, anchorMs);
      const existing = periods.get(key) ?? emptyTotals();
      addInto(existing, delta);
      periods.set(key, existing);
    }

    for (const [productId, sku] of orderSkus) {
      const existing =
        skus.get(productId) ??
        { ...sku, units: 0, gross_minor: 0, refunds_minor: 0, chargebacks_minor: 0, net_minor: 0 };
      existing.units += sku.units;
      existing.gross_minor += sku.gross_minor;
      existing.refunds_minor += sku.refunds_minor;
      existing.chargebacks_minor += sku.chargebacks_minor;
      existing.net_minor = existing.gross_minor - existing.refunds_minor - existing.chargebacks_minor;
      if (!skus.has(productId)) existing.label = sku.label;
      skus.set(productId, existing);
    }
  }

  return {
    totals: withNet(totals),
    periods: [...periods.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([period, t]) => ({ period, ...withNet(t) })),
    skus: [...skus.values()].sort((a, b) => b.gross_minor - a.gross_minor),
    currencies: [...currencies].sort(),
    unplaced,
  };
}

/* ── The PayNow Management API fetch (bounded, never throws) ─────────────── */

const ORDERS_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const ORDERS_PAGE_LIMIT = 100; // the Management API's max limit

function paynowEnv(): { baseUrl: string; storeId: string; apiKey: string } {
  try {
    return {
      baseUrl: (env.paynow.baseUrl || '').replace(/\/+$/, ''),
      storeId: env.paynow.storeId || '',
      apiKey: env.paynow.apiKey || '',
    };
  } catch {
    const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
    return {
      baseUrl: (proc.PAYNOW_BASE_URL || 'https://api.paynow.gg').replace(/\/+$/, ''),
      storeId: proc.PAYNOW_STORE_ID || '',
      apiKey: proc.PAYNOW_API_KEY || '',
    };
  }
}

export type StoreOrdersResult =
  | { ok: true; orders: RevenueOrder[]; truncated: boolean }
  | { ok: false; reason: string };

/** One page of the store's orders, newest first. Never throws. */
export async function fetchStoreOrders(): Promise<StoreOrdersResult> {
  const { baseUrl, storeId, apiKey } = paynowEnv();
  if (!baseUrl || !storeId || !apiKey) return { ok: false, reason: 'paynow_not_configured' };
  try {
    const res = await fetch(`${baseUrl}/v1/stores/${storeId}/orders?limit=${ORDERS_PAGE_LIMIT}&asc=false`, {
      headers: {
        Accept: 'application/json',
        Authorization: `APIKey ${apiKey}`,
        'x-paynow-store-id': storeId,
      },
      signal: AbortSignal.timeout(ORDERS_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reason: `paynow_api_status_${res.status}` };
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_RESPONSE_BYTES) return { ok: false, reason: 'response_too_large' };
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) return { ok: false, reason: 'response_too_large' };
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      return { ok: false, reason: 'unexpected_content_type' };
    }
    if (!Array.isArray(parsed)) return { ok: false, reason: 'unexpected_shape' };
    return { ok: true, orders: parsed as RevenueOrder[], truncated: parsed.length >= ORDERS_PAGE_LIMIT };
  } catch (err) {
    logger.warn({ err: String(err) }, 'revenue summary: store orders fetch failed');
    return { ok: false, reason: err instanceof Error && err.name === 'TimeoutError' ? 'paynow_api_timeout' : 'paynow_api_error' };
  }
}

/* ── The D1 half: what IS stored (no amounts — stated, not hidden) ───────── */

export interface D1LedgerBlock {
  amounts_stored: false;
  note: string;
  orders: number;
  lines: number;
  by_status: Record<string, number>;
  by_sku: Array<{ product_id: string; sku_label: string | null; lines: number; orders: number }>;
}

export async function loadD1LedgerBlock(): Promise<D1LedgerBlock> {
  const res = await getD1()
    .prepare(
      `SELECT order_id, product_id, sku_label, status
         FROM store_delivery_ledger`,
    )
    .all<{ order_id: string; product_id: string; sku_label: string | null; status: string }>();
  const rows = res.results ?? [];
  const byStatus: Record<string, number> = {};
  const skuOrders = new Map<string, { product_id: string; sku_label: string | null; lines: number; orders: Set<string> }>();
  const orderIds = new Set<string>();
  for (const r of rows) {
    orderIds.add(r.order_id);
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    const key = `${r.product_id}|${r.sku_label ?? ''}`;
    const sku = skuOrders.get(key) ?? { product_id: r.product_id, sku_label: r.sku_label, lines: 0, orders: new Set<string>() };
    sku.lines += 1;
    sku.orders.add(r.order_id);
    skuOrders.set(key, sku);
  }
  return {
    amounts_stored: false,
    note:
      'No D1 table carries monetary amounts or payment statuses (inspected: paynow_subscriptions, paynow_order_dispatches, store_delivery_ledger). Money comes from the PayNow Management API when it answers; this block is what IS stored.',
    orders: orderIds.size,
    lines: rows.length,
    by_status: byStatus,
    by_sku: [...skuOrders.values()]
      .map((s) => ({ product_id: s.product_id, sku_label: s.sku_label, lines: s.lines, orders: s.orders.size }))
      .sort((a, b) => b.lines - a.lines),
  };
}

/* ── The payload the route serves ────────────────────────────────────────── */

export interface RevenueSummaryPayload {
  granularity: RevenueGranularity;
  from: string | null;
  to: string | null;
  money: {
    available: boolean;
    source: 'paynow_management_api';
    amount_basis: 'minor_units';
    unavailable_reason?: string;
    truncated?: boolean;
  } & (
    | { available: true; summary: RevenueSummary }
    | { available: false; summary: null }
  );
  d1_ledger: D1LedgerBlock;
}

/**
 * Build the whole payload. The D1 block is served even when the PayNow API
 * fails — a dashboard half-load beats an error page, and the missing half is
 * NAMED (money.available=false + reason), never zero-filled.
 */
export async function buildRevenueSummary(opts: {
  granularity: RevenueGranularity;
  from?: string;
  to?: string;
}): Promise<RevenueSummaryPayload> {
  const ledger = await loadD1LedgerBlock();
  const orders = await fetchStoreOrders();
  if (orders.ok) {
    const summary = summarizeRevenue(orders.orders, opts);
    return {
      granularity: opts.granularity,
      from: opts.from ?? null,
      to: opts.to ?? null,
      money: {
        available: true,
        source: 'paynow_management_api',
        amount_basis: 'minor_units',
        truncated: orders.truncated || undefined,
        summary,
      },
      d1_ledger: ledger,
    };
  }
  return {
    granularity: opts.granularity,
    from: opts.from ?? null,
    to: opts.to ?? null,
    money: {
      available: false,
      unavailable_reason: orders.reason,
      source: 'paynow_management_api',
      amount_basis: 'minor_units',
      summary: null,
    },
    d1_ledger: ledger,
  };
}
