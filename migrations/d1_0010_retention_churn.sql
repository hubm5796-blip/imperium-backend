-- S2-C13 (churn-reason grouping, Option A — the D1 fold): the daily-folded
-- churn store behind GET /api/v2/admin/retention/churn-reasons.
--
-- Source of truth: the game MySQL's churn_reason_events (one row per session
-- end, written by the plugin's PlayerQuitEvent listener with the LAST
-- meaningful event's type — death | permission_denied | purchase_failed |
-- econ_refused | none, additive-only). The analytics cron leg folds it into
-- this table once per day with a 30-day lookback.
--
--   id      the source table's AUTO_INCREMENT id — the idempotency key
--           (INSERT OR IGNORE), so a re-fold never double-counts and late
--           arrivals converge on the next pass.
--   day     UTC day of session_end_at (the DB clock's date, as folded).
--   reason  the last_event_type value, stored VERBATIM. The vocabulary is
--           closed plugin-side but additive: an unknown value from a newer
--           plugin passes through as data (the S2-E09 rule) — never a 500.
--
-- Privacy: player_uuid is deliberately NOT folded. The plugin registers its
-- table ANONYMIZE-side; (day, reason) is exactly what that anonymization
-- preserves, so nothing player-identifying lands in D1.
--
-- As with d1_0006: the retention module's lazy ensure applies the same DDL
-- (deploys are git-push autobuilds; nothing runs wrangler migrations) — this
-- file documents the canonical shape.
CREATE TABLE IF NOT EXISTS retention_churn_reasons (
  id     INTEGER PRIMARY KEY,
  day    TEXT NOT NULL,
  reason TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rcr_day ON retention_churn_reasons (day);
