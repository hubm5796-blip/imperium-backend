/**
 * S2-D02 — the store delivery ledger.
 *
 * "Did this purchase deliver?" used to be unanswerable without manual
 * inspection (the one order in the store's history was bought into a catalog
 * whose donor perks did not deliver at all — finding M-01). This module is
 * the durable record:
 *
 *   queued    — a fulfillment line was dispatched onto the Redis bus
 *               (status 'pending' until the bus confirms execution)
 *   executed  — the plugin accepted + ran the command (status 'delivered')
 *   failed    — the dispatch was rejected or threw (status 'failed'; the
 *               webhook 500s so PayNow retries, and a retry re-queues the
 *               line back to 'pending' via the upsert)
 *   stale     — pending for more than STALE_AFTER_MS (S2-D03's sweeper
 *               persists it; the reader ALSO computes it from queued_at so a
 *               never-executing command is visible as stale between sweeps)
 *
 * Granularity: one row per (order_id, line_key) — the same grain as
 * paynow_order_dispatches, so identical cart lines never collide (B-57).
 * GET /admin/deliveries groups lines back into per-order/per-product items
 * shaped per docs/season-2/API-CONTRACTS-S2.md.
 *
 * Failure discipline (mirrors db/actionLog.ts): a ledger write failure NEVER
 * fails or blocks the fulfillment that produced it — it is logged loudly
 * instead. A missing ledger row is a visibility gap, not a delivery failure.
 */
import { getD1 } from './pool.js';
import { logger } from '../utils/logger.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS store_delivery_ledger (
  order_id         TEXT NOT NULL,
  line_key         TEXT NOT NULL,
  pretty_id        TEXT,
  customer_name    TEXT,
  customer_uuid    TEXT,
  product_id       TEXT NOT NULL,
  sku_label        TEXT,
  command          TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  queued_at        INTEGER NOT NULL,
  executed_at      INTEGER,
  failed_reason    TEXT,
  grant_verified_at INTEGER,
  grant_evidence   TEXT,
  alerted_at       INTEGER,
  resolved_at      INTEGER,
  updated_at       INTEGER NOT NULL,
  PRIMARY KEY (order_id, line_key)
)`;

const SCHEMA_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_sdl_status_queued ON store_delivery_ledger (status, queued_at)',
  'CREATE INDEX IF NOT EXISTS idx_sdl_product ON store_delivery_ledger (product_id)',
];

/** A queued-beyond-24h line is STALE (the S2-D03 breach threshold). */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export type DeliveryStatus = 'pending' | 'delivered' | 'failed' | 'stale';

/** One ledger line, as stored (dates as epoch ms / null). */
export interface DeliveryLineRow {
  order_id: string;
  line_key: string;
  pretty_id: string | null;
  customer_name: string | null;
  customer_uuid: string | null;
  product_id: string;
  sku_label: string | null;
  command: string;
  status: string;
  queued_at: number;
  executed_at: number | null;
  failed_reason: string | null;
  grant_verified_at: number | null;
  grant_evidence: string | null;
  alerted_at: number | null;
  resolved_at: number | null;
  updated_at: number;
}

/** Lazy CREATE TABLE IF NOT EXISTS (once per isolate — the actionLog pattern). */
let schemaEnsured = false;
async function ensureSchema(): Promise<void> {
  if (schemaEnsured) return;
  const d1 = getD1();
  await d1.prepare(SCHEMA).run();
  for (const idx of SCHEMA_INDEXES) {
    await d1.prepare(idx).run();
  }
  schemaEnsured = true;
}

/** Test hook — the next ensureSchema runs for real again (fresh-db tests). */
export function __resetDeliveryLedgerSchemaForTests(): void {
  schemaEnsured = false;
}

/** Column whitelist for patch-based updates (never interpolate caller keys). */
const UPDATEABLE = new Set([
  'status',
  'executed_at',
  'failed_reason',
  'grant_verified_at',
  'grant_evidence',
  'alerted_at',
  'resolved_at',
  'updated_at',
]);

function nowMs(): number {
  return Date.now();
}

export interface QueuedDeliveryLine {
  orderId: string;
  lineKey: string;
  prettyId?: string | null;
  customerName?: string | null;
  customerUuid?: string | null;
  productId: string;
  skuLabel?: string | null;
  /** The dispatch descriptor as sent ("TYPE {json payload}"). */
  command: string;
  /** Backdated queue time for seeded/migrated rows; defaults to now. */
  queuedAt?: number;
}

/**
 * Record a line QUEUED for dispatch. Upsert: a PayNow retry of a previously
 * failed line re-queues it (status back to 'pending', failure reason cleared)
 * without touching alert/grant bookkeeping.
 * NEVER throws — a ledger blip must not fail a real delivery.
 */
export async function ledgerLineQueued(entry: QueuedDeliveryLine): Promise<void> {
  try {
    await ensureSchema();
    const ts = nowMs();
    await getD1()
      .prepare(
        `INSERT INTO store_delivery_ledger
           (order_id, line_key, pretty_id, customer_name, customer_uuid, product_id, sku_label,
            command, status, queued_at, executed_at, failed_reason, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, ?)
         ON CONFLICT (order_id, line_key) DO UPDATE SET
           status = 'pending',
           executed_at = NULL,
           failed_reason = NULL,
           updated_at = excluded.updated_at`,
      )
      .bind(
        entry.orderId,
        entry.lineKey,
        entry.prettyId ?? null,
        entry.customerName ?? null,
        entry.customerUuid ?? null,
        entry.productId,
        entry.skuLabel ?? null,
        entry.command.slice(0, 2000),
        entry.queuedAt ?? ts,
        ts,
      )
      .run();
  } catch (err) {
    logger.error({ err: String(err), orderId: entry.orderId, lineKey: entry.lineKey }, 'delivery ledger: queued write failed');
  }
}

/** Generic patch update — WHERE order_id [+ line_key]. NEVER throws. */
async function patchLines(
  where: { orderId: string; lineKey?: string },
  patch: Partial<Pick<DeliveryLineRow, 'status' | 'executed_at' | 'failed_reason' | 'grant_verified_at' | 'grant_evidence' | 'alerted_at' | 'resolved_at' | 'updated_at'>>,
): Promise<void> {
  try {
    await ensureSchema();
    const cols = Object.keys(patch).filter((k): k is string => UPDATEABLE.has(k));
    if (cols.length === 0) return;
    const setSql = cols.map((c) => `${c} = ?`).join(', ');
    const params: unknown[] = cols.map((c) => (patch as Record<string, unknown>)[c]);
    let sql = `UPDATE store_delivery_ledger SET ${setSql} WHERE order_id = ?`;
    params.push(where.orderId);
    if (where.lineKey !== undefined) {
      sql += ' AND line_key = ?';
      params.push(where.lineKey);
    }
    await getD1()
      .prepare(sql)
      .bind(...params)
      .run();
  } catch (err) {
    logger.error({ err: String(err), orderId: where.orderId }, 'delivery ledger: update failed');
  }
}

/** The plugin confirmed the command executed. */
export async function ledgerLineExecuted(orderId: string, lineKey: string, executedAt: number = nowMs()): Promise<void> {
  await patchLines({ orderId, lineKey }, { status: 'delivered', executed_at: executedAt, updated_at: nowMs() });
}

/** The dispatch was rejected / threw (PayNow will retry — a retry re-queues). */
export async function ledgerLineFailed(orderId: string, lineKey: string, reason: string): Promise<void> {
  await patchLines({ orderId, lineKey }, { status: 'failed', failed_reason: reason.slice(0, 500), updated_at: nowMs() });
}

/** S2-D03 dedupe bookkeeping: the breach alert went out for this line. */
export async function ledgerLineAlerted(orderId: string, lineKey: string, at: number = nowMs()): Promise<void> {
  await patchLines({ orderId, lineKey }, { alerted_at: at, updated_at: nowMs() });
}

/** S2-D03 recovery: the resolve notice went out for this line. */
export async function ledgerLineResolved(orderId: string, lineKey: string, at: number = nowMs()): Promise<void> {
  await patchLines({ orderId, lineKey }, { resolved_at: at, updated_at: nowMs() });
}

/** Persist the stale transition so status filters see it between reads. */
export async function ledgerLineMarkedStale(orderId: string, lineKey: string): Promise<void> {
  await patchLines({ orderId, lineKey }, { status: 'stale', updated_at: nowMs() });
}

/**
 * Record a verified in-game grant for a whole order (the contract's
 * grant_verified_at / grant_evidence). Callers: the future reverify endpoint
 * once an in-game verifier exists; idempotent (first write wins unless
 * cleared).
 */
export async function ledgerOrderGrantVerified(orderId: string, evidence: unknown, at: number = nowMs()): Promise<void> {
  await patchLines(
    { orderId },
    {
      grant_verified_at: at,
      grant_evidence: typeof evidence === 'string' ? evidence.slice(0, 500) : JSON.stringify(evidence).slice(0, 500),
      updated_at: nowMs(),
    },
  );
}

/**
 * All ledger lines, newest-queued first. Bounded: deliveries are low-volume
 * (the store's entire history is a handful of orders); the 2000-line cap is
 * the safety valve, filtering + grouping + pagination happen in JS so the
 * computed-stale semantics stay in ONE place.
 * Throws only when D1 itself is down (callers decide the HTTP failure mode).
 */
export async function listAllDeliveryLines(): Promise<DeliveryLineRow[]> {
  await ensureSchema();
  const { results } = await getD1()
    .prepare(
      `SELECT order_id, line_key, pretty_id, customer_name, customer_uuid, product_id, sku_label,
              command, status, queued_at, executed_at, failed_reason,
              grant_verified_at, grant_evidence, alerted_at, resolved_at, updated_at
         FROM store_delivery_ledger
        ORDER BY queued_at DESC, order_id DESC, line_key DESC
        LIMIT 2000`,
    )
    .all<DeliveryLineRow>();
  return results ?? [];
}

/** Effective status of a stored line — pending past the 24h mark reads stale. */
export function effectiveStatus(row: Pick<DeliveryLineRow, 'status' | 'queued_at'>, now: number = nowMs()): DeliveryStatus {
  if (row.status === 'pending' && now - row.queued_at >= STALE_AFTER_MS) return 'stale';
  if (row.status === 'pending' || row.status === 'delivered' || row.status === 'failed' || row.status === 'stale') {
    return row.status;
  }
  return 'pending';
}
