-- Season 2 Lane D analytics instrumentation (S2-D05 + S2-D07).
-- Backend-only (D1) — the plugin never reads or writes these tables.

-- economy_daily_row (S2-D05): the STORED daily economy row. One row per UTC
-- day, written once by the analytics cron leg (aggregating the just-finished
-- day from the game MySQL: currency_balances + economy_transactions), so
-- history exists even on quiet days — the absence of history is why a 0.971
-- gini was a discovery rather than a trend.
--
--   total_supply        SUM(balance) over denarius holders, whole units.
--   holder_count        rows counted (denominator context for gini/top1).
--   gini / top1_share   distribution of the per-holder balances (0..1).
--   issued_total        day's faucet issuance (absolute denarius).
--   drained_total       day's sink drain (absolute magnitude, positive).
--   issuance_by_faucet  JSON { "service:action": absolute_amount } — the
--                       plugin EconomyService reason strings. Shares that sum
--                       to 1 are derived on read; raw amounts are stored so
--                       the rolling 7-day windows are exact.
--   drain_by_sink       JSON { "service:action": absolute_amount }.
--   net_delta_abs       issued_total - drained_total (signed, whole units).
--   net_delta           net_delta_abs / previous day's total_supply (the
--                       contract's ratio; 0 on the first stored day). The
--                       S2-D06 weekly alert divides the rolling 7-day abs
--                       sum by the supply before the window.
--
-- Breach flags (gini > 0.85, weekly net delta > +15%, any faucet > 25% of
-- issuance) are NOT stored: every one of them is computable from consecutive
-- rows (S2-D06 consumes them; the /admin/economy/snapshot reader marks them).
CREATE TABLE IF NOT EXISTS economy_daily_row (
  day                TEXT PRIMARY KEY,
  total_supply       INTEGER NOT NULL,
  holder_count       INTEGER NOT NULL,
  gini               REAL NOT NULL,
  top1_share         REAL NOT NULL,
  issued_total       INTEGER NOT NULL,
  drained_total      INTEGER NOT NULL,
  issuance_by_faucet TEXT NOT NULL,
  drain_by_sink      TEXT NOT NULL,
  net_delta_abs      INTEGER NOT NULL,
  net_delta          REAL NOT NULL,
  computed_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_edr_day ON economy_daily_row (day);

-- retention_player_seen (S2-D07): per-account instrumentation. The analytics
-- cron leg folds the game MySQL's player_stats (last_join/last_quit/
-- join_count), player_ranks (rank_level), player_playtime (total_secs) and
-- onboarding_state (first_seen) into one row per player, refreshed daily.
--
--   source  join attribution. The agreed value is `source` with 'direct' as
--           the never-null default — Lane E's S2-E09 wires the real
--           attribution frontend half later; until then every synced row is
--           'direct'. Never NULL (an unattributed join is 'direct').
CREATE TABLE IF NOT EXISTS retention_player_seen (
  uuid              TEXT PRIMARY KEY,
  first_seen_ms     INTEGER NOT NULL,
  last_seen_ms      INTEGER NOT NULL,
  session_count     INTEGER NOT NULL DEFAULT 0,
  total_playtime_s  INTEGER NOT NULL DEFAULT 0,
  rank_level        INTEGER NOT NULL DEFAULT 1,
  source            TEXT NOT NULL DEFAULT 'direct',
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rps_first_seen ON retention_player_seen (first_seen_ms);
CREATE INDEX IF NOT EXISTS idx_rps_source ON retention_player_seen (source);

-- retention_player_days (S2-D07): per-player UTC presence days — the
-- d1/d7/d30 denominator basis. One row per (uuid, day) the player was
-- ACTIVE. Feed today: DISTINCT economy_transactions days folded daily by the
-- analytics leg (every player earns within minutes of joining, so an economy
-- day is a presence day); when the plugin reports real join/quit sessions
-- onto the bus, the same leg folds those too and the definition upgrades
-- without a schema change.
CREATE TABLE IF NOT EXISTS retention_player_days (
  uuid TEXT NOT NULL,
  day  TEXT NOT NULL,
  PRIMARY KEY (uuid, day)
);
CREATE INDEX IF NOT EXISTS idx_rpd_day ON retention_player_days (day);
