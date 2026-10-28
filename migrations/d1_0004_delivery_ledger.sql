-- store_delivery_ledger (S2-D02): the answer to "did this purchase deliver?".
--
-- One row per dispatched fulfillment LINE (order_id + line_key — the same
-- grain as paynow_order_dispatches, so identical cart lines never collide).
-- Status vocabulary (the queue spec): pending (queued, not yet confirmed
-- executed) / delivered (the bus command was accepted+executed) / failed
-- (dispatch rejected or threw) / stale (pending for more than 24h — set by
-- the S2-D03 sweep, and computed on read so silence is never mistaken for
-- health between sweeps).
--
-- grant_verified_at / grant_evidence stay NULL until an in-game grant
-- verifier exists (the contract's reverify endpoint): a row with executed_at
-- set and grant_verified_at NULL means "the command ran and we have NOT yet
-- proven the player got the thing" — the M-01 failure mode this ledger
-- exists to surface.
--
-- Backend-only (D1) — the plugin never reads or writes this table.
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
);
CREATE INDEX IF NOT EXISTS idx_sdl_status_queued ON store_delivery_ledger (status, queued_at);
CREATE INDEX IF NOT EXISTS idx_sdl_product ON store_delivery_ledger (product_id);
