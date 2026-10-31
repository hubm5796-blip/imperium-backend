/**
 * Boot-time D1 migration auto-apply (Lane D, 2026-10-31).
 *
 * The D1 migrations in migrations/ were authored over months but nothing in
 * the deploy path ever ran `wrangler d1 migrations apply` — deploys are
 * git-push autobuilds. Each module grew its own lazy CREATE TABLE IF NOT
 * EXISTS (the D02 deliveryLedger / D07 actionLog pattern), which worked
 * per-table but left the migrations/ directory as documentation only:
 * nothing proved the files and the running schema converged. This module
 * closes that gap at boot:
 *
 *   1. ensureBootMigrations() runs once per isolate from src/worker.ts
 *      (fetch + scheduled, via ctx.waitUntil — never on the request path).
 *   2. It probes sqlite_master for every mounted object, applies what is
 *      missing (idempotent DDL only — CREATE ... IF NOT EXISTS, plus
 *      ALTER ... ADD COLUMN with the duplicate-column swallow the
 *      changelog store uses), and lists un-applied / failed migrations
 *      LOUDLY in the boot log.
 *   3. src/test/migrations-drift.test.ts is the DRIFT PIN: it fails if a
 *      file exists in migrations/ that this manifest does not mirror
 *      byte-for-byte, or if any statement is not idempotent DDL. A new
 *      migration file MUST be added here in the same commit.
 *
 * Failure doctrine (mirrors deliveryLedger/actionLog): a failed ensure logs
 * loudly and never crashes the isolate — request paths keep their own lazy
 * ensures as the safety net behind this one.
 */
import { getD1 } from './pool.js';
import { logger } from '../utils/logger.js';

/** One migrations/ file, mirrored for the boot applier. */
export interface BootMigration {
  /** migrations/ file this entry mirrors — the drift-pin test fails if the directory and this list diverge. */
  file: string;
  /** DDL exactly as the .sql file (LF, byte-for-byte). Idempotent only: CREATE ... IF NOT EXISTS or ALTER ... ADD COLUMN. */
  sql: string;
}

/**
 * Every migration mounted at boot, in filename order (the wrangler order).
 * Order matters exactly once: d1_0009 ALTERs the table d1_0005 creates.
 */
export const BOOT_MIGRATIONS: readonly BootMigration[] = [
  {
    file: "d1_0001_paynow_subscriptions.sql",
    sql: "-- paynow_subscriptions: webhook-fed cache of each player's active donor\n-- subscription. Backend-only -- the plugin never reads or writes this table\n-- (verified before migrating off Postgres), so D1 is safe here.\nCREATE TABLE IF NOT EXISTS paynow_subscriptions (\n  uuid            TEXT PRIMARY KEY,\n  subscription_id TEXT NOT NULL,\n  product_id      TEXT NOT NULL,\n  status          TEXT NOT NULL,\n  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))\n);",
  },
  {
    file: "d1_0002_paynow_order_dispatches.sql",
    sql: "-- paynow_order_dispatches: per-line idempotency ledger for PayNow order\n-- fulfillment (B-C16). Backend-only -- the plugin never reads or writes this\n-- table (its own PurchaseRegistry is the in-game dedupe), so D1 is safe here,\n-- same as paynow_subscriptions.\n--\n-- One row per (order_id, line_key) where line_key is\n-- '<lineIndex>:<productId>:<quantity>:<recipientUuid>' -- the line INDEX keeps\n-- two identical cart lines from colliding on one key (B-57). Stable across\n-- webhook retries (the payload's line order is stable per delivery).\n-- ON CONFLICT DO NOTHING + meta.changes is the insert-or-ignore claim: the\n-- first delivery of a line inserts (changes=1, dispatch proceeds); PayNow\n-- webhook retries hit the conflict (changes=0, dispatch skipped).\nCREATE TABLE IF NOT EXISTS paynow_order_dispatches (\n  order_id   TEXT NOT NULL,\n  line_key   TEXT NOT NULL,\n  command    TEXT NOT NULL,\n  created_at TEXT NOT NULL DEFAULT (datetime('now')),\n  PRIMARY KEY (order_id, line_key)\n);",
  },
  {
    file: "d1_0003_client_crash_reports.sql",
    sql: "-- client_crash_reports: launcher crash-report intake (Imperium-MC/imperium-backend#3).\n-- Backend-only -- the plugin never reads this table, so D1 is safe here, same\n-- as the paynow tables. Written by POST /api/v2/client/crash-report (anonymous,\n-- 5/hour/IP), read by the staff-gated GET /api/v2/client/crash-report(s).\n--\n-- The launcher owns no user token (it can crash before sign-in), so rows are\n-- attributed to an HMAC prefix of the client IP (ip_hash), never the raw IP.\n-- created_at is ms epoch (the gallery/queue convention) so the list sorts by\n-- insertion order with a single index.\n--\n-- The route ALSO ensures this schema lazily (CREATE TABLE IF NOT EXISTS on\n-- first use) because deploys are git-push autobuilds and nothing runs\n-- `wrangler d1 migrations apply` -- this file documents the canonical shape.\nCREATE TABLE IF NOT EXISTS client_crash_reports (\n  id               TEXT PRIMARY KEY,      -- 16 hex chars (randomBytes(8))\n  created_at       INTEGER NOT NULL,\n  ip_hash          TEXT NOT NULL,         -- HMAC-SHA256(ip)[:16], keyed by JWT_SECRET\n  launcher         TEXT NOT NULL,         -- e.g. \"imperium-launcher\"\n  launcher_version TEXT NOT NULL,\n  client_version   TEXT,                  -- nullable: crash may predate version resolution\n  mc_version       TEXT,                  -- nullable: same\n  platform         TEXT NOT NULL,         -- e.g. \"windows-x64\", \"linux\"\n  cause            TEXT NOT NULL,         -- short triage string (<= 200 chars)\n  mod              TEXT,                  -- suspected mod, when the launcher names one\n  log_tail         TEXT NOT NULL,         -- hard-truncated to 32 KB server-side\n  crash_report     TEXT                   -- hard-truncated to 64 KB server-side\n);\nCREATE INDEX IF NOT EXISTS idx_client_crash_reports_created ON client_crash_reports(created_at DESC);\nCREATE INDEX IF NOT EXISTS idx_client_crash_reports_cause ON client_crash_reports(cause);",
  },
  {
    file: "d1_0004_delivery_ledger.sql",
    sql: "-- store_delivery_ledger (S2-D02): the answer to \"did this purchase deliver?\".\n--\n-- One row per dispatched fulfillment LINE (order_id + line_key — the same\n-- grain as paynow_order_dispatches, so identical cart lines never collide).\n-- Status vocabulary (the queue spec): pending (queued, not yet confirmed\n-- executed) / delivered (the bus command was accepted+executed) / failed\n-- (dispatch rejected or threw) / stale (pending for more than 24h — set by\n-- the S2-D03 sweep, and computed on read so silence is never mistaken for\n-- health between sweeps).\n--\n-- grant_verified_at / grant_evidence stay NULL until an in-game grant\n-- verifier exists (the contract's reverify endpoint): a row with executed_at\n-- set and grant_verified_at NULL means \"the command ran and we have NOT yet\n-- proven the player got the thing\" — the M-01 failure mode this ledger\n-- exists to surface.\n--\n-- Backend-only (D1) — the plugin never reads or writes this table.\nCREATE TABLE IF NOT EXISTS store_delivery_ledger (\n  order_id         TEXT NOT NULL,\n  line_key         TEXT NOT NULL,\n  pretty_id        TEXT,\n  customer_name    TEXT,\n  customer_uuid    TEXT,\n  product_id       TEXT NOT NULL,\n  sku_label        TEXT,\n  command          TEXT NOT NULL,\n  status           TEXT NOT NULL DEFAULT 'pending',\n  queued_at        INTEGER NOT NULL,\n  executed_at      INTEGER,\n  failed_reason    TEXT,\n  grant_verified_at INTEGER,\n  grant_evidence   TEXT,\n  alerted_at       INTEGER,\n  resolved_at      INTEGER,\n  updated_at       INTEGER NOT NULL,\n  PRIMARY KEY (order_id, line_key)\n);\nCREATE INDEX IF NOT EXISTS idx_sdl_status_queued ON store_delivery_ledger (status, queued_at);\nCREATE INDEX IF NOT EXISTS idx_sdl_product ON store_delivery_ledger (product_id);",
  },
  {
    file: "d1_0005_changelog_entries.sql",
    sql: "-- changelog_entry: the ONE changelog store (Romanica-MC/romanica-frontend#9).\n-- Backend-only D1. Holds every changelog entry regardless of origin:\n--   - the website's curated updates (imported once by\n--     scripts/import-site-changelog.mts; each site slug is preserved as the\n--     row id so /changelog/<slug> permalinks survive the site's switch to\n--     this API),\n--   - Discord-posted server changelogs (POST /api/v2/changelog/post\n--     dual-writes here; product 'server'),\n--   - GitHub release syncs (POST /api/v2/changelog/release upserts here,\n--     stamped synced_at, deterministic id `<product>-<version>`).\n--\n-- The product vocabulary (server|client|launcher|website|pack) lives ONLY in\n-- src/changelog/types.ts (CHANGELOG_PRODUCTS) — this table is its storage,\n-- not its definition.\n--\n-- Migration, not break: the pre-#9 store (changelog_post, see\n-- src/db/changelogStore.ts) is backfilled into this table by\n-- ensureChangelogEntrySchema() (src/changelog/store.ts) with\n-- `seed-<slug>` ids mapped to `<slug>`; changelog_post itself is kept\n-- write-only for history and the legacy prune lever.\n--\n-- The route ALSO ensures this schema lazily (CREATE TABLE IF NOT EXISTS on\n-- first use) because deploys are git-push autobuilds and nothing runs\n-- `wrangler d1 migrations apply` -- this file documents the canonical shape.\nCREATE TABLE IF NOT EXISTS changelog_entry (\n  id        TEXT PRIMARY KEY,      -- site slug (curated), `<product>-<version>` (release sync), `post-<rand>` (Discord post)\n  date      INTEGER NOT NULL,      -- publication/release date, ms epoch\n  product   TEXT NOT NULL,         -- 'server' | 'client' | 'launcher' | 'website' | 'pack' (vocabulary: src/changelog/types.ts)\n  version   TEXT,                  -- e.g. \"0.2.7\", \"0.2.0-beta.24\"; NULL for unversioned entries\n  title     TEXT NOT NULL,\n  summary   TEXT NOT NULL,         -- one-line lead\n  body      TEXT NOT NULL DEFAULT '{}', -- JSON ChangelogBody: keyChanges/action/tags/readHref (curated), sections/changes (Discord), markdown (releases)\n  links     TEXT NOT NULL DEFAULT '{}', -- JSON { release?, pr?, issue? }\n  related   TEXT NOT NULL DEFAULT '[]', -- JSON [id, ...]\n  synced_at INTEGER                -- ms epoch of the last release sync; NULL = curated/hand-posted\n);\nCREATE INDEX IF NOT EXISTS idx_changelog_entry_date ON changelog_entry(date DESC, id DESC);\nCREATE INDEX IF NOT EXISTS idx_changelog_entry_product ON changelog_entry(product, date DESC, id DESC);",
  },
  {
    file: "d1_0006_analytics.sql",
    sql: "-- Season 2 Lane D analytics instrumentation (S2-D05 + S2-D07).\n-- Backend-only (D1) — the plugin never reads or writes these tables.\n\n-- economy_daily_row (S2-D05): the STORED daily economy row. One row per UTC\n-- day, written once by the analytics cron leg (aggregating the just-finished\n-- day from the game MySQL: currency_balances + economy_transactions), so\n-- history exists even on quiet days — the absence of history is why a 0.971\n-- gini was a discovery rather than a trend.\n--\n--   total_supply        SUM(balance) over denarius holders, whole units.\n--   holder_count        rows counted (denominator context for gini/top1).\n--   gini / top1_share   distribution of the per-holder balances (0..1).\n--   issued_total        day's faucet issuance (absolute denarius).\n--   drained_total       day's sink drain (absolute magnitude, positive).\n--   issuance_by_faucet  JSON { \"service:action\": absolute_amount } — the\n--                       plugin EconomyService reason strings. Shares that sum\n--                       to 1 are derived on read; raw amounts are stored so\n--                       the rolling 7-day windows are exact.\n--   drain_by_sink       JSON { \"service:action\": absolute_amount }.\n--   net_delta_abs       issued_total - drained_total (signed, whole units).\n--   net_delta           net_delta_abs / previous day's total_supply (the\n--                       contract's ratio; 0 on the first stored day). The\n--                       S2-D06 weekly alert divides the rolling 7-day abs\n--                       sum by the supply before the window.\n--\n-- Breach flags (gini > 0.85, weekly net delta > +15%, any faucet > 25% of\n-- issuance) are NOT stored: every one of them is computable from consecutive\n-- rows (S2-D06 consumes them; the /admin/economy/snapshot reader marks them).\nCREATE TABLE IF NOT EXISTS economy_daily_row (\n  day                TEXT PRIMARY KEY,\n  total_supply       INTEGER NOT NULL,\n  holder_count       INTEGER NOT NULL,\n  gini               REAL NOT NULL,\n  top1_share         REAL NOT NULL,\n  issued_total       INTEGER NOT NULL,\n  drained_total      INTEGER NOT NULL,\n  issuance_by_faucet TEXT NOT NULL,\n  drain_by_sink      TEXT NOT NULL,\n  net_delta_abs      INTEGER NOT NULL,\n  net_delta          REAL NOT NULL,\n  computed_at        TEXT NOT NULL DEFAULT (datetime('now'))\n);\nCREATE INDEX IF NOT EXISTS idx_edr_day ON economy_daily_row (day);\n\n-- retention_player_seen (S2-D07): per-account instrumentation. The analytics\n-- cron leg folds the game MySQL's player_stats (last_join/last_quit/\n-- join_count), player_ranks (rank_level), player_playtime (total_secs) and\n-- onboarding_state (first_seen) into one row per player, refreshed daily.\n--\n--   source  join attribution. The agreed value is `source` with 'direct' as\n--           the never-null default — Lane E's S2-E09 wires the real\n--           attribution frontend half later; until then every synced row is\n--           'direct'. Never NULL (an unattributed join is 'direct').\nCREATE TABLE IF NOT EXISTS retention_player_seen (\n  uuid              TEXT PRIMARY KEY,\n  first_seen_ms     INTEGER NOT NULL,\n  last_seen_ms      INTEGER NOT NULL,\n  session_count     INTEGER NOT NULL DEFAULT 0,\n  total_playtime_s  INTEGER NOT NULL DEFAULT 0,\n  rank_level        INTEGER NOT NULL DEFAULT 1,\n  source            TEXT NOT NULL DEFAULT 'direct',\n  updated_at        INTEGER NOT NULL\n);\nCREATE INDEX IF NOT EXISTS idx_rps_first_seen ON retention_player_seen (first_seen_ms);\nCREATE INDEX IF NOT EXISTS idx_rps_source ON retention_player_seen (source);\n\n-- retention_player_days (S2-D07): per-player UTC presence days — the\n-- d1/d7/d30 denominator basis. One row per (uuid, day) the player was\n-- ACTIVE. Feed today: DISTINCT economy_transactions days folded daily by the\n-- analytics leg (every player earns within minutes of joining, so an economy\n-- day is a presence day); when the plugin reports real join/quit sessions\n-- onto the bus, the same leg folds those too and the definition upgrades\n-- without a schema change.\nCREATE TABLE IF NOT EXISTS retention_player_days (\n  uuid TEXT NOT NULL,\n  day  TEXT NOT NULL,\n  PRIMARY KEY (uuid, day)\n);\nCREATE INDEX IF NOT EXISTS idx_rpd_day ON retention_player_days (day);",
  },
  {
    file: "d1_0007_economy_breach_state.sql",
    sql: "-- Season 2 Lane D — S2-D06 economy breach alerting state.\n-- Backend-only (D1) — the plugin never reads or writes this table.\n--\n-- economy_breach_state: ONE row per breach key, for the durable dedupe the\n-- S2-D06 packet requires (\"one alert per breach window, resolve on recovery\").\n-- An in-memory dedupe would re-alert on every deploy/restart — the loop the\n-- packet forbids — so the window state lives here, exactly like the delivery\n-- ledger's alerted_at column does for S2-D03.\n--\n-- Breach keys (closed set + the faucet registry's open tail):\n--   'gini'                 day gini > 0.85\n--   'net_delta'            rolling 7-day net supply delta > +15%\n--   'faucet:<reason>'      one faucet > 25% of issuance in the rolling\n--                          7-day window (one row per offending reason, so\n--                          two overtuned faucets alert independently)\n--\n-- Window lifecycle:\n--   breach starts -> breach alert posted once -> alerted_at set\n--   metric recovers -> resolve posted once -> resolved_at set\n--   breach returns -> resolved_at cleared, a NEW window alerts again\n-- A row with alerted_at set and resolved_at NULL is an OPEN, already-alerted\n-- window: the dedupe that stops the loop. A row with alerted_at NULL is an\n-- armed-but-silent window (the webhook was never configured while it was\n-- breaching) — arming STAFF_ALERT_WEBHOOK_URL later alerts it exactly once.\nCREATE TABLE IF NOT EXISTS economy_breach_state (\n  breach_key  TEXT PRIMARY KEY,\n  breached_at INTEGER,\n  alerted_at  INTEGER,\n  last_value  REAL,\n  resolved_at INTEGER,\n  updated_at  INTEGER NOT NULL\n);",
  },
  {
    file: "d1_0007_session_revocations.sql",
    sql: "-- Season 2 S2-D04 (backend half; frontend counterpart S2-E04) — the session\n-- revocation list. Backend-only (D1) — the plugin never reads or writes this.\n--\n-- Session JWTs live 7 days and were, until this table, unkillable: clearing\n-- the auth cookie deletes the browser's copy, but the token itself still\n-- verifies until exp. Revocation is keyed two ways:\n--\n--   jti:<token-id>  ONE specific token. Every newly signed session carries a\n--                   jti claim since this deploy (signJwt); legacy tokens have\n--                   none and can only be caught by the uuid key below.\n--   uuid:<identity> EVERY session for an identity (discordId or mcUuid) that\n--                   was ISSUED BEFORE the revocation. New logins after the\n--                   revoke are unaffected — their iat is past the horizon —\n--                   so this is a forced-logout, not a login ban.\n--\n-- expires_at_ms is the purge horizon: past it, every token a row could still\n-- reject is dead by its own exp, so the row is deletable without re-opening\n-- any session (jti rows: now + 7d >= any token carrying that jti; uuid rows:\n-- now + 7d >= the exp of every pre-revoke token).\nCREATE TABLE IF NOT EXISTS session_revocations (\n  revocation_key   TEXT PRIMARY KEY,\n  kind             TEXT NOT NULL CHECK (kind IN ('jti', 'uuid')),\n  issued_before_ms INTEGER,\n  expires_at_ms    INTEGER NOT NULL,\n  revoked_by       TEXT,\n  reason           TEXT,\n  revoked_at_ms    INTEGER NOT NULL\n);\nCREATE INDEX IF NOT EXISTS idx_sr_expires ON session_revocations (expires_at_ms);",
  },
  {
    file: "d1_0008_attribution.sql",
    sql: "-- S2-E09 (Lane D backend half) — attribution plumbing: the connect-intent\n-- store and the one-shot per-player claim. D1 only; the plugin never reads\n-- these tables (its half is player_stats.join_source, Ask 2 of the request\n-- file). Contract: docs/season-2/requests/S2-E09.md + the Attribution\n-- section of docs/season-2/API-CONTRACTS-S2.md.\n--\n-- attribution_intent: one row per salted visitor-IP hash — the source tag\n-- that IP last acted on (a copy-IP click on a tagged landing). sha256(ip +\n-- server secret); the RAW IP is never persisted. Latest intent wins (the\n-- newest copy action is the one that produced the join); rows live 48h and\n-- are pruned on every write. The salt is a STATIC worker secret\n-- (ATTRIBUTION_SALT; rotating it would break matching across the window).\n--\n-- attribution_claim: one row per player uuid — the source resolved at that\n-- player's FIRST join (POST /api/v2/attribution/claim). One-shot per uuid:\n-- first attribution wins, re-joins never re-attribute. Persisted so the\n-- one-shot holds across restarts.\n\nCREATE TABLE IF NOT EXISTS attribution_intent (\n  ip_hash TEXT PRIMARY KEY,\n  source  TEXT NOT NULL,\n  ts      INTEGER NOT NULL\n);\n\nCREATE TABLE IF NOT EXISTS attribution_claim (\n  uuid       TEXT PRIMARY KEY,\n  source     TEXT NOT NULL,\n  claimed_at INTEGER NOT NULL\n);",
  },
  {
    file: "d1_0009_changelog_category.sql",
    sql: "-- S2-L10 (per-entry embeds): the entry category column.\n--\n-- changelog_entry.category is NULL on every legacy row (site-curated imports,\n-- Discord post dual-writes, GitHub release syncs written before this packet);\n-- the site renders legacy rows with the area chip only (already implemented\n-- and test-pinned frontend-side). New rows carry one of the five closed\n-- categories (fix|new|improvement|announcement|correction — the vocabulary\n-- lives in src/changelog/types.ts CHANGELOG_CATEGORY_IDS, mirrored from the\n-- frontend src/lib/changelog.ts).\n--\n-- As with d1_0005: deploys are git-push autobuilds and nothing runs\n-- `wrangler d1 migrations apply` — the store's lazy ensure\n-- (ensureChangelogEntrySchema in src/changelog/store.ts) applies the same\n-- ALTER guarded on duplicate-column (the dm_queue claimed_at pattern), and\n-- fresh D1s get the column straight from the CREATE TABLE. This file\n-- documents the canonical shape for anyone applying migrations by hand.\nALTER TABLE changelog_entry ADD COLUMN category TEXT;",
  },
  {
    file: "d1_0010_retention_churn.sql",
    sql: "-- S2-C13 (churn-reason grouping, Option A — the D1 fold): the daily-folded\n-- churn store behind GET /api/v2/admin/retention/churn-reasons.\n--\n-- Source of truth: the game MySQL's churn_reason_events (one row per session\n-- end, written by the plugin's PlayerQuitEvent listener with the LAST\n-- meaningful event's type — death | permission_denied | purchase_failed |\n-- econ_refused | none, additive-only). The analytics cron leg folds it into\n-- this table once per day with a 30-day lookback.\n--\n--   id      the source table's AUTO_INCREMENT id — the idempotency key\n--           (INSERT OR IGNORE), so a re-fold never double-counts and late\n--           arrivals converge on the next pass.\n--   day     UTC day of session_end_at (the DB clock's date, as folded).\n--   reason  the last_event_type value, stored VERBATIM. The vocabulary is\n--           closed plugin-side but additive: an unknown value from a newer\n--           plugin passes through as data (the S2-E09 rule) — never a 500.\n--\n-- Privacy: player_uuid is deliberately NOT folded. The plugin registers its\n-- table ANONYMIZE-side; (day, reason) is exactly what that anonymization\n-- preserves, so nothing player-identifying lands in D1.\n--\n-- As with d1_0006: the retention module's lazy ensure applies the same DDL\n-- (deploys are git-push autobuilds; nothing runs wrangler migrations) — this\n-- file documents the canonical shape.\nCREATE TABLE IF NOT EXISTS retention_churn_reasons (\n  id     INTEGER PRIMARY KEY,\n  day    TEXT NOT NULL,\n  reason TEXT NOT NULL\n);\nCREATE INDEX IF NOT EXISTS idx_rcr_day ON retention_churn_reasons (day);",
  },
];

/* ────────────────────────── statement handling ────────────────────────── */

/**
 * Split a .sql file into individual statements: strips `--` line comments
 * and block comments, honors quote states ('...', "...", [...], backticks,
 * including '' escapes), and cuts on top-level semicolons. Pure — the
 * applier, the drift-pin lint, and the tests all share this one truth.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      current += ch;
      i++;
      while (i < n) {
        current += sql[i]!;
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            current += sql[i + 1]!;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === '[') {
      current += ch;
      i++;
      while (i < n && sql[i] !== ']') {
        current += sql[i]!;
        i++;
      }
      if (i < n) {
        current += ']';
        i++;
      }
      continue;
    }
    if (ch === ';') {
      const stmt = current.trim();
      if (stmt) statements.push(stmt);
      current = '';
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

/** The schema objects one migration's statements guarantee. Derived from the
 *  split statements (never the raw text — comments quote SQL too). */
export interface MigrationObjects {
  tables: string[];
  indexes: string[];
  /** ALTER TABLE ... ADD COLUMN pairs (SQLite has no IF NOT EXISTS for these). */
  columns: Array<{ table: string; column: string }>;
}

export function migrationObjects(statements: string[]): MigrationObjects {
  const tables: string[] = [];
  const indexes: string[] = [];
  const columns: MigrationObjects['columns'] = [];
  for (const stmt of statements) {
    let m = /^CREATE TABLE IF NOT EXISTS\s+("?)([A-Za-z_]\w*)\1/i.exec(stmt);
    if (m) {
      tables.push(m[2]!);
      continue;
    }
    m = /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS\s+("?)([A-Za-z_]\w*)\1/i.exec(stmt);
    if (m) {
      indexes.push(m[2]!);
      continue;
    }
    m = /^ALTER TABLE\s+"?([A-Za-z_]\w*)"?\s+ADD COLUMN\s+"?([A-Za-z_]\w*)"?/i.exec(stmt);
    if (m) {
      columns.push({ table: m[1]!, column: m[2]! });
    }
  }
  return { tables, indexes, columns };
}

/* ─────────────────────────── the boot ensure ─────────────────────────── */

export interface BootMigrationFailure {
  file: string;
  statement: string;
  err: string;
}

export interface BootMigrationsReport {
  /** Files whose objects all existed before this boot — nothing was run. */
  present: string[];
  /** Files this boot applied (or re-affirmed via IF NOT EXISTS after a probe outage). */
  applied: string[];
  /** Non-empty = the pass is INCOMPLETE and this is logged at error level. */
  failed: BootMigrationFailure[];
  /** ALTERs answered "duplicate column name" — the already-deployed case. */
  skippedDuplicateColumn: string[];
  /** Set when the sqlite_master probe itself failed (D1 hiccup) — the pass
   *  then re-applies everything idempotently instead of skipping. */
  probeFailed?: string;
}

/** Does `SELECT <col> FROM <table> LIMIT 0` work? Vanilla SQL only — no
 *  PRAGMA dependency (D1's PRAGMA surface is not guaranteed). Table/column
 *  come from parsed DDL of mounted files, never user input. */
async function columnExists(d1: D1Database, table: string, column: string): Promise<boolean> {
  try {
    await d1.prepare(`SELECT ${column} FROM ${table} LIMIT 0`).run();
    return true;
  } catch {
    return false; // "no such column" / "no such table" — the apply fixes it
  }
}

async function applyBootMigrations(d1: D1Database): Promise<BootMigrationsReport> {
  const perFile = BOOT_MIGRATIONS.map((m) => {
    const statements = splitSqlStatements(m.sql);
    return { file: m.file, statements, objects: migrationObjects(statements) };
  });

  const allNames: string[] = [];
  for (const m of perFile) allNames.push(...m.objects.tables, ...m.objects.indexes);

  const report: BootMigrationsReport = { present: [], applied: [], failed: [], skippedDuplicateColumn: [] };

  let existing = new Set<string>();
  try {
    const placeholders = allNames.map(() => '?').join(', ');
    const rows = await d1
      .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table', 'index') AND name IN (${placeholders})`)
      .bind(...allNames)
      .all<{ name: string }>();
    existing = new Set((rows.results ?? []).map((r) => r.name));
  } catch (err) {
    report.probeFailed = String(err);
    logger.warn(
      { err: report.probeFailed },
      '[migrations] sqlite_master probe failed — re-applying every migration idempotently (IF NOT EXISTS / duplicate-column guarded)',
    );
  }

  for (const m of perFile) {
    let isPresent: boolean;
    if (report.probeFailed) {
      isPresent = false;
    } else {
      const objectsPresent = [...m.objects.tables, ...m.objects.indexes].every((name) => existing.has(name));
      const columnsPresent =
        m.objects.columns.length === 0 ||
        (await Promise.all(m.objects.columns.map((c) => columnExists(d1, c.table, c.column)))).every(Boolean);
      isPresent = objectsPresent && columnsPresent;
    }
    if (isPresent) {
      report.present.push(m.file);
      continue;
    }

    // The loud boot-log listing the owner directive asks for: every file that
    // was NOT applied when this isolate booted is named here before applying.
    logger.warn({ migration: m.file }, '[migrations] un-applied at boot — applying now');

    let fileApplied = true;
    for (const stmt of m.statements) {
      try {
        await d1.prepare(stmt).run();
      } catch (err) {
        if (/duplicate column/i.test(String(err)) && /^ALTER TABLE/i.test(stmt)) {
          // SQLite has no ADD COLUMN IF NOT EXISTS — "duplicate column name"
          // IS the idempotent success (the changelog store pattern).
          report.skippedDuplicateColumn.push(m.file);
          continue;
        }
        fileApplied = false;
        report.failed.push({ file: m.file, statement: stmt.slice(0, 120), err: String(err) });
        logger.error(
          { migration: m.file, err: String(err), statement: stmt.slice(0, 120) },
          '[migrations] APPLY FAILED — migration not fully applied',
        );
        break;
      }
    }
    if (!fileApplied) break; // abort the pass: later files may depend on this one's objects
    report.applied.push(m.file);
  }

  if (report.failed.length > 0) {
    logger.error(
      {
        applied: report.applied,
        presentCount: report.present.length,
        failed: report.failed.map((f) => f.file),
        note: 'pass aborted at first failure — remaining migrations deferred to the next boot',
      },
      '[migrations] INCOMPLETE — some mounted migrations are NOT applied',
    );
  } else if (report.applied.length > 0) {
    logger.info(
      { applied: report.applied, presentCount: report.present.length },
      '[migrations] boot ensure applied missing migrations',
    );
  } else {
    logger.info(
      { count: report.present.length },
      '[migrations] boot ensure: all mounted migrations already present',
    );
  }
  return report;
}

let bootPromise: Promise<BootMigrationsReport> | null = null;

/**
 * Run the migration ensure once per isolate (D07's lazy-ensure, hoisted to
 * boot). Never rejects — a migration failure logs loudly and returns a
 * report with `failed` populated; request paths keep their own lazy
 * ensures as the safety net behind this one.
 */
export function ensureBootMigrations(d1?: D1Database): Promise<BootMigrationsReport> {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => applyBootMigrations(d1 ?? getD1()))().catch((err: unknown) => {
    logger.error({ err: String(err) }, '[migrations] boot ensure crashed');
    return {
      present: [],
      applied: [],
      failed: [{ file: '(boot)', statement: '', err: String(err) }],
      skippedDuplicateColumn: [],
    } satisfies BootMigrationsReport;
  });
  return bootPromise;
}

/** Test hook — the next ensureBootMigrations runs for real again. */
export function __resetBootMigrationsForTests(): void {
  bootPromise = null;
}
