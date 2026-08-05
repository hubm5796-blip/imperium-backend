-- paynow_subscriptions: webhook-fed cache of each player's active donor
-- subscription. Backend-only -- the plugin never reads or writes this table
-- (verified before migrating off Postgres), so D1 is safe here.
CREATE TABLE IF NOT EXISTS paynow_subscriptions (
  uuid            TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  product_id      TEXT NOT NULL,
  status          TEXT NOT NULL,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
