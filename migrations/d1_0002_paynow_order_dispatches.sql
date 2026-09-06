-- paynow_order_dispatches: per-line idempotency ledger for PayNow order
-- fulfillment (B-C16). Backend-only -- the plugin never reads or writes this
-- table (its own PurchaseRegistry is the in-game dedupe), so D1 is safe here,
-- same as paynow_subscriptions.
--
-- One row per (order_id, line_key) where line_key is
-- '<productId>:<quantity>:<recipientUuid>' -- stable across webhook retries.
-- ON CONFLICT DO NOTHING + meta.changes is the insert-or-ignore claim: the
-- first delivery of a line inserts (changes=1, dispatch proceeds); PayNow
-- webhook retries hit the conflict (changes=0, dispatch skipped).
CREATE TABLE IF NOT EXISTS paynow_order_dispatches (
  order_id   TEXT NOT NULL,
  line_key   TEXT NOT NULL,
  command    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (order_id, line_key)
);
