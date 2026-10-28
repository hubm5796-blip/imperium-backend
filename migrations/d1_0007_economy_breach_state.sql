-- Season 2 Lane D — S2-D06 economy breach alerting state.
-- Backend-only (D1) — the plugin never reads or writes this table.
--
-- economy_breach_state: ONE row per breach key, for the durable dedupe the
-- S2-D06 packet requires ("one alert per breach window, resolve on recovery").
-- An in-memory dedupe would re-alert on every deploy/restart — the loop the
-- packet forbids — so the window state lives here, exactly like the delivery
-- ledger's alerted_at column does for S2-D03.
--
-- Breach keys (closed set + the faucet registry's open tail):
--   'gini'                 day gini > 0.85
--   'net_delta'            rolling 7-day net supply delta > +15%
--   'faucet:<reason>'      one faucet > 25% of issuance in the rolling
--                          7-day window (one row per offending reason, so
--                          two overtuned faucets alert independently)
--
-- Window lifecycle:
--   breach starts -> breach alert posted once -> alerted_at set
--   metric recovers -> resolve posted once -> resolved_at set
--   breach returns -> resolved_at cleared, a NEW window alerts again
-- A row with alerted_at set and resolved_at NULL is an OPEN, already-alerted
-- window: the dedupe that stops the loop. A row with alerted_at NULL is an
-- armed-but-silent window (the webhook was never configured while it was
-- breaching) — arming STAFF_ALERT_WEBHOOK_URL later alerts it exactly once.
CREATE TABLE IF NOT EXISTS economy_breach_state (
  breach_key  TEXT PRIMARY KEY,
  breached_at INTEGER,
  alerted_at  INTEGER,
  last_value  REAL,
  resolved_at INTEGER,
  updated_at  INTEGER NOT NULL
);
