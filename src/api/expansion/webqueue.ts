// 12a expansion: the web_queue durable queue.
//
// POST endpoints that must cause an in-game effect (vote callbacks, shop
// orders) do NOT talk to the plugin directly (the Redis command bus is
// request/response and assumes a live plugin). Instead they INSERT one row per
// event into the `web_queue` Postgres table; the plugin polls it (~5s), claims
// pending rows, verifies the row signature, and performs the grant with
// flow-log reason `web:vote` / `web:shop`. The full schema + HMAC scheme is
// documented in docs/api.md — the two must stay in sync.
//
// Signature: every row is HMAC-SHA256 signed with WEBPANEL_HMAC_SECRET (the
// same Workers env secret the plugin already shares for the Redis command bus)
// over a canonical pipe-joined message of the row's stable fields, prefixed
// `v1`. The plugin recomputes the signature from the row it read and rejects
// mismatches — a forged or hand-edited queue row can never grant anything.
import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import { env } from '../../env.js';
import { query } from '../../db/pool.js';

export type WebQueueKind = 'vote' | 'shop_order';

/** Canonical-signature field order — MUST match docs/api.md and the plugin's consumer. */
export interface WebQueueSignFields {
  kind: WebQueueKind;
  /** Backend-generated unique id for this row (UNIQUE in web_queue). */
  requestId: string;
  uuid: string | null;
  username: string | null;
  site: string | null;
  sku: string | null;
  quantity: number;
  /** Unix seconds; also the value stored in created_at via to_timestamp(). */
  createdAtSec: number;
}

/**
 * Compute the row signature:
 *
 *   message  = "v1|" + kind + "|" + requestId + "|" + (uuid ?? "")
 *            + "|" + (username ?? "") + "|" + (site ?? "") + "|" + (sku ?? "")
 *            + "|" + quantity + "|" + createdAtSec
 *   signature = lowercase hex HMAC-SHA256(WEBPANEL_HMAC_SECRET, message)
 *
 * Every component is a plain row column (or exactly what was inserted for
 * created_at), so the plugin can reconstruct the message from the row alone.
 * Exported for the route tests to prove the wire format matches the doc.
 */
export function signWebQueueRow(fields: WebQueueSignFields): string {
  const message = [
    'v1',
    fields.kind,
    fields.requestId,
    fields.uuid ?? '',
    fields.username ?? '',
    fields.site ?? '',
    fields.sku ?? '',
    String(fields.quantity),
    String(fields.createdAtSec),
  ].join('|');
  return crypto.createHmac('sha256', env.webpanelHmacSecret).update(message).digest('hex');
}

export interface EnqueueInput {
  kind: WebQueueKind;
  uuid?: string | null;
  username?: string | null;
  /** Vote site slug (kind='vote'). */
  site?: string | null;
  /** Shop SKU (kind='shop_order'). */
  sku?: string | null;
  quantity?: number;
  /** Extra context stored in the row's payload JSONB (never part of the signature). */
  payload?: Record<string, unknown>;
}

/**
 * Insert one signed row into web_queue. Returns the row id + request_id.
 * Throws when the insert fails (missing table, DB down) — callers translate
 * that into a 503 so the vote site / shop client retries.
 */
export async function enqueueWebQueue(input: EnqueueInput): Promise<{ id: number; requestId: string }> {
  const requestId = nanoid(16);
  // created_at is derived from this exact value via to_timestamp($n) so the
  // plugin recomputes the same signature without clock-skew ambiguity.
  const createdAtSec = Math.floor(Date.now() / 1000);
  const quantity = input.quantity ?? 1;

  const signature = signWebQueueRow({
    kind: input.kind,
    requestId,
    uuid: input.uuid ?? null,
    username: input.username ?? null,
    site: input.site ?? null,
    sku: input.sku ?? null,
    quantity,
    createdAtSec,
  });

  const result = await query<{ id: number | string }>(
    `INSERT INTO web_queue
       (request_id, kind, uuid, username, site, sku, quantity, payload, status, signature, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'pending', $9, to_timestamp($10))
     RETURNING id`,
    [
      requestId,
      input.kind,
      input.uuid ?? null,
      input.username ?? null,
      input.site ?? null,
      input.sku ?? null,
      quantity,
      JSON.stringify(input.payload ?? {}),
      signature,
      createdAtSec,
    ],
  );

  return { id: Number(result.rows[0]?.id ?? 0), requestId };
}
