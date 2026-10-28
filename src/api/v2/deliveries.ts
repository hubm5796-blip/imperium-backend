/**
 * S2-D02 — GET /api/v2/admin/deliveries: the delivery ledger reader.
 *
 * Shape per docs/season-2/API-CONTRACTS-S2.md: one item per (order, product)
 * with the commands-as-issued array and the parallel executed_at array.
 * `grant_verified_at` is the field that matters — executed_at set while
 * grant_verified_at is null means "the command ran and we have NOT proven the
 * player got the thing" (the M-01 failure mode).
 *
 * Gated by the S2-D01 fail-closed staff RBAC (helper+). Status semantics:
 * a pending line queued more than 24h ago reads 'stale' even before the
 * S2-D03 sweeper persists the transition — silence is never health.
 */
import { Hono } from 'hono';
import {
  effectiveStatus,
  listAllDeliveryLines,
  type DeliveryLineRow,
} from '../../db/deliveryLedger.js';
import { requireStaffRole } from '../../middleware/gates.js';
import { readRateLimit } from '../../middleware/rateLimit.js';
import { logger } from '../../utils/logger.js';
import type { AppContextVariables } from '../../types/index.js';

type ApiEnv = { Variables: AppContextVariables };

export const deliveriesV2 = new Hono<ApiEnv>();

const STATUSES = new Set(['pending', 'delivered', 'stale', 'failed']);
/** Group items per page; the line scan is bounded upstream (2000 lines). */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Item shape per the S2 contract (docs/season-2/API-CONTRACTS-S2.md). */
interface DeliveryItem {
  order_id: string;
  line_keys: string[];
  pretty_id: string | null;
  customer: { name: string | null; uuid: string | null };
  product_id: string;
  sku_label: string | null;
  commands_issued: string[];
  executed_at: (string | null)[];
  grant_verified_at: string | null;
  grant_evidence: unknown;
  status: string;
}

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function groupItem(orderId: string, productId: string, lines: DeliveryLineRow[], now: number): DeliveryItem {
  const first = lines[0]!;
  // Worst-of wins: a failed line marks the group failed; otherwise any line
  // still pending past 24h marks it stale; delivered only when ALL executed.
  const statuses = lines.map((l) => effectiveStatus(l, now));
  let status: string = 'delivered';
  if (statuses.includes('failed')) status = 'failed';
  else if (statuses.includes('stale')) status = 'stale';
  else if (statuses.includes('pending')) status = 'pending';

  const sorted = [...lines].sort((a, b) => a.line_key.localeCompare(b.line_key, undefined, { numeric: true }));
  const verified = sorted.find((l) => l.grant_verified_at !== null) ?? null;
  let evidence: unknown = null;
  if (verified?.grant_evidence) {
    try {
      evidence = JSON.parse(verified.grant_evidence);
    } catch {
      evidence = verified.grant_evidence;
    }
  }
  return {
    order_id: orderId,
    line_keys: sorted.map((l) => l.line_key),
    pretty_id: sorted.map((l) => l.pretty_id).find((p) => p !== null) ?? null,
    customer: {
      name: sorted.map((l) => l.customer_name).find((n) => n !== null) ?? null,
      uuid: sorted.map((l) => l.customer_uuid).find((u) => u !== null) ?? null,
    },
    product_id: productId,
    sku_label: first.sku_label,
    commands_issued: sorted.map((l) => l.command),
    executed_at: sorted.map((l) => isoOrNull(l.executed_at)),
    grant_verified_at: isoOrNull(verified?.grant_verified_at ?? null),
    grant_evidence: evidence,
    status,
  };
}

/** Base64url offset cursor ({v:1,o}) — deliveries are append-mostly, so a
 *  keyset over a grouped read would be stable only at line granularity. */
function encodeOffset(offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, o: offset }), 'utf8').toString('base64url');
}

function decodeOffset(raw: string | undefined): number | 'invalid' {
  if (!raw) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { v?: number; o?: number };
    if (parsed.v !== 1 || typeof parsed.o !== 'number' || !Number.isInteger(parsed.o) || parsed.o < 0) return 'invalid';
    return parsed.o;
  } catch {
    return 'invalid';
  }
}

deliveriesV2.get('/admin/deliveries', readRateLimit, requireStaffRole('helper'), async (c) => {
  const status = c.req.query('status');
  if (status !== undefined && !STATUSES.has(status)) {
    return c.json({ error: `Invalid status '${status}'`, allowed: [...STATUSES] }, 400);
  }
  const productId = c.req.query('product_id') || undefined;

  // from/to accept ISO dates or epoch ms; they bound the queue time.
  const fromRaw = c.req.query('from');
  const toRaw = c.req.query('to');
  let fromMs: number | undefined;
  let toMs: number | undefined;
  if (fromRaw) {
    fromMs = /^\d+$/.test(fromRaw) ? Number(fromRaw) : Date.parse(fromRaw);
    if (Number.isNaN(fromMs)) return c.json({ error: "Invalid 'from' (ISO date or epoch ms)" }, 400);
  }
  if (toRaw) {
    toMs = /^\d+$/.test(toRaw) ? Number(toRaw) : Date.parse(toRaw);
    if (Number.isNaN(toMs)) return c.json({ error: "Invalid 'to' (ISO date or epoch ms)" }, 400);
  }

  const limitRaw = Number.parseInt(c.req.query('limit') ?? '', 10);
  const limit = Number.isNaN(limitRaw) ? DEFAULT_LIMIT : Math.min(MAX_LIMIT, Math.max(1, limitRaw));
  const cursor = decodeOffset(c.req.query('cursor'));
  if (cursor === 'invalid') {
    return c.json({ error: 'Invalid cursor' }, 400);
  }

  const now = Date.now();
  try {
    const lines = await listAllDeliveryLines();
    const filtered = lines.filter((l) => {
      if (productId && l.product_id !== productId) return false;
      if (fromMs !== undefined && l.queued_at < fromMs) return false;
      if (toMs !== undefined && l.queued_at > toMs) return false;
      if (status) {
        const eff = effectiveStatus(l, now);
        if (eff !== status) return false;
      }
      return true;
    });

    // Group lines into (order_id, product_id) items, newest-queued first.
    const groups = new Map<string, DeliveryLineRow[]>();
    for (const l of filtered) {
      const key = `${l.order_id}|${l.product_id}`;
      const bucket = groups.get(key);
      if (bucket) bucket.push(l);
      else groups.set(key, [l]);
    }
    // A group's sort key is its NEWEST line (matches the line-level ordering).
    const items = [...groups.entries()]
      .map(([key, ls]) => {
        const sep = key.indexOf('|');
        return {
          item: groupItem(key.slice(0, sep), key.slice(sep + 1), ls, now),
          newest: Math.max(...ls.map((l) => l.queued_at)),
        };
      })
      .sort((a, b) => b.newest - a.newest);

    const page = items.slice(cursor, cursor + limit);
    const nextCursor = cursor + limit < items.length ? encodeOffset(cursor + limit) : null;
    return c.json({ items: page.map((e) => e.item), next_cursor: nextCursor });
  } catch (err) {
    logger.error({ err: String(err) }, 'admin deliveries: ledger read failed');
    return c.json({ error: 'Delivery ledger unavailable' }, 503);
  }
});
