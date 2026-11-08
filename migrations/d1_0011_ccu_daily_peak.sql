-- ccu_daily_peak (S2-G02): the concurrent-player peak series backing
-- /api/v2/growth/snapshot.json's ccu_peak_7d. One row per UTC day, written by
-- the every-minute bot cron leg (src/analytics/ccu.ts sampleCcuPeak) as a
-- single atomic running-MAX upsert over the live count chain the status page
-- reads. Backend-only (D1) — the plugin never reads or writes this table.
--
--   peak       the day's highest ANSWERED sample (MAX upsert, never reset).
--   samples    how many ticks answered this day — a peak of 40 off 3 samples
--              and one off 1,400 are different honesty statements, and the
--              diagnostic keeps them distinguishable without leaking anything.
--   updated_at ms epoch of the last fold, for staleness reads.
--
-- No day is fabricated: a day where every source failed simply has no row, so
-- a 7-day MAX over an unmeasured window reads NULL, never 0-as-guess.
-- `day` is TEXT PRIMARY KEY — in SQLite that is the seek index for both the
-- 7-day window read (day >= ?) and the prune (day < ?), so no extra index.
CREATE TABLE IF NOT EXISTS ccu_daily_peak (
  day        TEXT PRIMARY KEY,
  peak       INTEGER NOT NULL,
  samples    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
