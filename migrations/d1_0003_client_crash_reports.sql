-- client_crash_reports: launcher crash-report intake (Imperium-MC/imperium-backend#3).
-- Backend-only -- the plugin never reads this table, so D1 is safe here, same
-- as the paynow tables. Written by POST /api/v2/client/crash-report (anonymous,
-- 5/hour/IP), read by the staff-gated GET /api/v2/client/crash-report(s).
--
-- The launcher owns no user token (it can crash before sign-in), so rows are
-- attributed to an HMAC prefix of the client IP (ip_hash), never the raw IP.
-- created_at is ms epoch (the gallery/queue convention) so the list sorts by
-- insertion order with a single index.
--
-- The route ALSO ensures this schema lazily (CREATE TABLE IF NOT EXISTS on
-- first use) because deploys are git-push autobuilds and nothing runs
-- `wrangler d1 migrations apply` -- this file documents the canonical shape.
CREATE TABLE IF NOT EXISTS client_crash_reports (
  id               TEXT PRIMARY KEY,      -- 16 hex chars (randomBytes(8))
  created_at       INTEGER NOT NULL,
  ip_hash          TEXT NOT NULL,         -- HMAC-SHA256(ip)[:16], keyed by JWT_SECRET
  launcher         TEXT NOT NULL,         -- e.g. "imperium-launcher"
  launcher_version TEXT NOT NULL,
  client_version   TEXT,                  -- nullable: crash may predate version resolution
  mc_version       TEXT,                  -- nullable: same
  platform         TEXT NOT NULL,         -- e.g. "windows-x64", "linux"
  cause            TEXT NOT NULL,         -- short triage string (<= 200 chars)
  mod              TEXT,                  -- suspected mod, when the launcher names one
  log_tail         TEXT NOT NULL,         -- hard-truncated to 32 KB server-side
  crash_report     TEXT                   -- hard-truncated to 64 KB server-side
);
CREATE INDEX IF NOT EXISTS idx_client_crash_reports_created ON client_crash_reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_client_crash_reports_cause ON client_crash_reports(cause);
