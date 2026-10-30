-- S2-E09 (Lane D backend half) — attribution plumbing: the connect-intent
-- store and the one-shot per-player claim. D1 only; the plugin never reads
-- these tables (its half is player_stats.join_source, Ask 2 of the request
-- file). Contract: docs/season-2/requests/S2-E09.md + the Attribution
-- section of docs/season-2/API-CONTRACTS-S2.md.
--
-- attribution_intent: one row per salted visitor-IP hash — the source tag
-- that IP last acted on (a copy-IP click on a tagged landing). sha256(ip +
-- server secret); the RAW IP is never persisted. Latest intent wins (the
-- newest copy action is the one that produced the join); rows live 48h and
-- are pruned on every write. The salt is a STATIC worker secret
-- (ATTRIBUTION_SALT; rotating it would break matching across the window).
--
-- attribution_claim: one row per player uuid — the source resolved at that
-- player's FIRST join (POST /api/v2/attribution/claim). One-shot per uuid:
-- first attribution wins, re-joins never re-attribute. Persisted so the
-- one-shot holds across restarts.

CREATE TABLE IF NOT EXISTS attribution_intent (
  ip_hash TEXT PRIMARY KEY,
  source  TEXT NOT NULL,
  ts      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS attribution_claim (
  uuid       TEXT PRIMARY KEY,
  source     TEXT NOT NULL,
  claimed_at INTEGER NOT NULL
);
