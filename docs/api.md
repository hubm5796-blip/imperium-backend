# ImperiumMC Backend API Reference

The API is served at `https://api.imperiummc.net` (Hono on Cloudflare Workers,
source `src/api/routes.ts` + `src/api/expansion/`). All bodies are JSON.

Auth model (existing, unchanged):

- **Session cookie** (`imperium_session`, JWT): established by Discord OAuth or
  the in-game `/webcode` flow. `requireAuth` = valid session;
  `requireLinked` = session with a linked Minecraft account.
- **Bot token** (`X-Bot-Token` == `BOT_API_TOKEN`): trusted-server auth used by
  the Discord bot and the frontend's edge proxy, sometimes combined with
  `X-Mc-Uuid` for targeted player reads.
- **Per-site key** (`X-Vote-Key` == per-site value from `VOTE_CALLBACK_KEYS`):
  vote-site callbacks (new, see below).

Rate limits (per client IP, sliding window — `X-RateLimit-Limit` /
`X-RateLimit-Remaining` / `Retry-After` headers): global 60/min on everything;
new expansion route classes: reads 60/min (`read`), writes 10/min (`write`),
shop orders 5/min (`shop`).

## Route table

### Existing surface (summary — see `src/api/routes.ts` for detail)

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/auth/discord` `/callback` `/me`, POST `/logout` `/exchange` `/webcode/verify` | mixed | OAuth + session handoff |
| GET | `/api/player/profile` | session (self) or bot (+`?uuid=`/`?discord_id=`) | 15s Redis cache |
| GET | `/api/player/{balances,stats,transactions,skills,factions,parkour,achievements,cosmetics,quests,legion,crates,lookup,permissions}` | session-linked / bot | personal reads |
| GET | `/api/leaderboards/{parkour/:course,elo,waves}` | anonymous | parkour/elo/waves boards |
| GET | `/api/server/{status,features}` | anonymous | |
| POST | `/api/link/{initiate,confirm}`, DELETE `/api/link` | session / bot | |
| GET/POST | `/api/store/*` | storeAuth (bot+`X-Mc-Uuid` or session) | PayNow checkout |
| POST | `/api/webhooks/paynow` | PayNow HMAC signature | |
| POST | `/api/action/sellall`, `/api/admin/*` | session / bot | Redis command bus |
| GET/POST | `/api/tickets*`, `/api/referrals/*`, `/api/marketplace/*`, `/api/legion/{create,leave,invite}`, `/api/refcode/*` | bot / session | |

### 12a expansion (this doc's focus)

| Method | Path | Auth | Rate | Cache | Source |
|---|---|---|---|---|---|
| GET | `/api/leaderboards/:board` | anonymous | read 60/min | SWR 60s/5m | board-specific (below) |
| GET | `/api/players/:uuid/codex` | session, **self only** | read 60/min | none; ETag | `player_story`, `enchant_stats` |
| GET | `/api/players/:uuid/fleet` | session, **self only** | read 60/min | none | `robot_data` |
| GET | `/api/dungeons/:id/stats` | session (caller) | read 60/min | none | `player_dungeon_stats`, `dungeon_lockouts` |
| GET | `/api/seasons/current` | anonymous | read 60/min | SWR 60s/5m | `seasonal_data`, `events_calendar`, `festivals` |
| GET | `/api/seasons/hall/:id` | anonymous | read 60/min | SWR 60s/5m | `season_hall` |
| GET | `/api/economy/flow-summary?window=24h\|7d` | anonymous | read 60/min | SWR 60s/5m | `economy_flow_hourly` → fallback `economy_transactions` |
| GET | `/api/economy/drift-alerts` | bot token | read 60/min | SWR 60s/5m | `economy_drift_alerts` (specced) |
| GET | `/api/legions/:id` | anonymous | read 60/min | SWR 60s/5m | `legions`, `legion_members`, `legion_bank`, `legion_upgrade_levels`, `legion_war_records` |
| POST | `/api/vote/:site` | `X-Vote-Key` per-site secret | write 10/min | none | → `web_queue` |
| GET | `/api/vote/status?uuid=` | session (self) / bot (+`?uuid=`) | read 60/min | none | `web_queue`, `vote_claims` |
| GET | `/api/shop/catalog` | anonymous | read 60/min | SWR 60s/5m | static catalog (`src/api/expansion/shopCatalog.ts`) |
| POST | `/api/shop/order` | session, linked | shop 5/min | none | → `web_queue` |
| GET | `/api/shop/orders?uuid=&limit=` | session (self) / bot (+`?uuid=`) | read 60/min | none | `web_queue` |
| GET | `/api/bounties/top?limit=` | anonymous | read 60/min | SWR 60s/5m | `pvp_bounty_board` (LIVE, Phase 9c) |
| POST | `/api/lfg/posts` | bot token | write 10/min | none | → `lfg_posts` (plugin polls) |
| GET | `/api/events/feed?since=` | bot token | read 60/min | none | `web_events` (plugin writes) |
| GET | `/api/admin/liveops` | bot token | read 60/min | SWR 60s/5m | `events_calendar_overrides` (specced), `festival_fund_ledger` (LIVE) |
| GET | `/api/admin/contraband/sweeps?limit=` | bot token | read 60/min | SWR 60s/5m | `contraband_sweeps` (specced) |
| GET | `/api/admin/player-tools?uuid=` | bot token | read 60/min | none | `economy_transactions` (LIVE), `dungeon_lockouts`, `pity_counters` (specced) |

The bot-token rows are consumed by the Discord worker (`imperium-discord`) and
the frontend's server-side admin proxies (which enforce Discord role gates
before forwarding); the backend treats `X-Bot-Token` == `BOT_API_TOKEN` as the
trust anchor for those, same as the pre-existing `/api/admin/server/status`.

SWR-cached responses carry `Cache-Control: public, max-age=60,
stale-while-revalidate=300` plus an `X-Cache` diagnostic header
(`EDGE | HIT | MISS | STALE | STALE-ERROR`). Personal endpoints carry
`Cache-Control: private, no-store`.

## Endpoint detail

### GET /api/leaderboards/:board

`board` = `denarius | blocks | prestige | playtime | rank | legion | koth | colosseum`.
Query: `?limit=20` (1-100). Response for player boards:

```json
{ "type": "rank", "entries": [
  { "rank": 1, "uuid": "...", "username": "Player", "value": 87, "secondary": 45, "rankName": "LXXXVII" }
] }
```

- `rank` → `player_ranks` (value = rank_level, secondary = progress). LIVE.
- `legion` → entry shape `{ rank, name, displayName, level, xp, members }` from
  `legions` + member counts. LIVE.
- `koth` / `colosseum` → `{ rank, uuid, username, value }` from
  `leaderboard_stats` (period `ALL_TIME`), categories `KOTH_WINS` /
  `COLOSSEUM_POINTS`. **Plugin must record these categories for live data.**

### GET /api/players/:uuid/codex — self only (403 for anyone else)

```json
{
  "uuid": "…",
  "lore":   { "chapters": [{ "chapterId": "ch01", "blockProgress": 120 }] },
  "enchants": { "distinct": 12, "totalProcs": 340211, "byEnchant": [{ "enchantId": "veneer", "procs": 90011 }] }
}
```

`ETag` header (sha256 prefix); send `If-None-Match` → `304` when unchanged.
Sources: `player_story` (lore chapters), `enchant_stats` (procs). LIVE tables.
(The plan doc specced a `lore_collection` table; `player_story` already holds
chapter progress, so the codex reads it instead.)

### GET /api/players/:uuid/fleet — self only

```json
{
  "uuid": "…",
  "robots": [{ "robotType": "miner", "count": 3, "level": 7, "active": true, "lastCollection": 1739000000000, "updatedAt": "…" }],
  "summary": { "distinctTypes": 2, "totalRobots": 5, "activeTypes": 1, "totalLevels": 18 }
}
```

Source: `robot_data` (AutomataManager). LIVE.

### GET /api/dungeons/:id/stats — session; stats are the CALLER's

`id` = dungeon slug (`^[a-z0-9_-]{1,64}$`).

```json
{ "uuid": "…", "dungeonId": "cloaca_maxima", "available": true, "clears": 12, "bestTimeMs": 184223, "lastClearAt": "…", "lockedUntil": null }
```

`available:false` means the stats tables don't exist yet (zero-state response).
**Tables for the plugin to create:**

```sql
CREATE TABLE player_dungeon_stats (
  uuid VARCHAR(36) NOT NULL,
  dungeon_id VARCHAR(64) NOT NULL,
  total_clears INT NOT NULL DEFAULT 0,
  best_time_ms BIGINT,
  last_clear_at TIMESTAMPTZ,
  PRIMARY KEY (uuid, dungeon_id)
);
CREATE TABLE dungeon_lockouts (
  uuid VARCHAR(36) NOT NULL,
  dungeon_id VARCHAR(64) NOT NULL,
  locked_until TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (uuid, dungeon_id)
);
```

### GET /api/seasons/current

```json
{
  "season": { "seasonId": "s3", "name": "Aeternum", "startsAt": "…", "endsAt": "…", "economyReset": false },
  "calendar":  { "available": true, "events":  [{ "id": 1, "name": "Feast of Minerva", "kind": "festival", "startsAt": "…", "endsAt": "…" }] },
  "festivals": { "available": true, "live":    [{ "id": 3, "name": "Crate Festival", "startsAt": "…", "endsAt": "…" }] },
  "events":  [{ "id": 4, "type": "war", "name": "Legion War", "startsAt": "…" },
              { "id": 5, "type": "colosseum", "name": "Colosseum Cup", "startsAt": "…", "signupDeadline": "…" }],
  "festival": { "id": 3, "name": "Crate Festival", "active": true, "endsAt": "…" }
}
```

`season` from `seasonal_data` (LIVE; `null` when no active season). `calendar`
= next-7-days events; `festivals` = live right now. `events` + `festival` are
the 12c Discord-worker sections: `events` is the calendar filtered to
`kind IN ('war','colosseum')` (the two kinds the bot schedules notifications
for — war 30/5-min muster warnings, colosseum signup-deadline reminders; the
deadline comes from `events_calendar.payload->>'signup_deadline'`), and
`festival` is the single live festival or `null`. **Tables for the plugin:**

```sql
CREATE TABLE events_calendar (
  id BIGSERIAL PRIMARY KEY,          -- plugin dialect-equivalent autoincrement
  name VARCHAR(128) NOT NULL,
  kind VARCHAR(32) NOT NULL,         -- 'festival' | 'koth' | 'sale' | ...
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  payload JSONB
);
CREATE TABLE festivals (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT FALSE,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL
);
```

Until those exist the sections degrade to `available:false, []`.

### GET /api/seasons/hall/:id

`id` = season id (`^[A-Za-z0-9_-]{1,32}$`, matches `seasonal_data.season_id`).

```json
{ "seasonId": "s2", "available": true, "entries": [
  { "category": "blocks", "rank": 1, "uuid": "…", "username": "Player", "value": 8123456 }
] }
```

**Table for the plugin:**

```sql
CREATE TABLE season_hall (
  season_id VARCHAR(32) NOT NULL,
  category VARCHAR(32) NOT NULL,
  rank INT NOT NULL,
  uuid VARCHAR(36) NOT NULL,
  value BIGINT NOT NULL,
  PRIMARY KEY (season_id, category, rank)
);
```

### GET /api/economy/flow-summary — PUBLIC-SAFE

Shares only — never absolute amounts, never per-player rows.

```json
{
  "window": "24h",
  "source": "economy_transactions",
  "faucet": [{ "reason": "service:minesell", "share": 0.4231 }, { "reason": "service:vote", "share": 0.1902 }],
  "faucetOtherShare": 0.0311,
  "sink":   [{ "reason": "service:upgrade", "share": 0.6650 }],
  "sinkOtherShare": 0.0409
}
```

`share` = fraction of the direction's total volume (4dp); reasons under 0.5%
collapse into `*OtherShare`. Preferred source is `economy_flow_hourly`
(pre-aggregated); while that table doesn't exist the endpoint aggregates
`economy_transactions` for the window (LIVE data today). **Optional plugin
table:**

```sql
CREATE TABLE economy_flow_hourly (
  bucket_hour TIMESTAMPTZ NOT NULL,
  reason VARCHAR(100) NOT NULL,
  direction VARCHAR(6) NOT NULL CHECK (direction IN ('faucet','sink')),
  amount BIGINT NOT NULL,
  PRIMARY KEY (bucket_hour, reason, direction)
);
```

### GET /api/legions/:id — public card

`:id` = legion NAME. 404 when unknown; SWR-cached.

```json
{
  "name": "LegioI", "displayName": "Legio I Italia", "level": 6, "xp": 120450,
  "motd": "…", "createdAt": "2026-01-04", "memberCount": 23, "maxMembers": 30,
  "ownerUuid": "…", "ownerName": "Caesar", "bankBalance": 45000,
  "perks": [{ "upgradeId": "vault", "level": 2 }],
  "warRecord": { "wins": 4, "losses": 1 },
  "members": [{ "uuid": "…", "username": "Titus", "role": "OFFICER" }]
}
```

`warRecord` is `null` until the plugin creates `legion_war_records`:

```sql
CREATE TABLE legion_war_records (
  legion_name VARCHAR(64) PRIMARY KEY,
  wins INT NOT NULL DEFAULT 0,
  losses INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Everything else reads live plugin tables.

### POST /api/vote/:site — vote callback → `web_queue`

Vote sites POST here after a successful vote. Configure one shared key per
site in the Workers secret `VOTE_CALLBACK_KEYS` (`"site1:key1,site2:key2"`,
same convention as `PAYNOW_WEBHOOK_SECRETS`; `wrangler secret put
VOTE_CALLBACK_KEYS`). The request must carry header `X-Vote-Key: <key>`.

Request:

```json
{ "username": "Player", "uuid": "a25a17ce-bca1-4894-92c9-00d7ab5b7875", "timestamp": 1739500000, "payload": {} }
```

At least one of `uuid` (dashed/undashed MC UUID) or `username` (3-16 chars,
optional Bedrock `.` prefix) is required; everything else optional. Zod-validated.

Responses: `202 {ok, queued, id, requestId}` · `400` validation ·
`401` bad key · `404` unknown site · `429` rate limit (10/min) ·
`503` queue unavailable (vote site should retry).

The plugin dedups per (uuid, site, day) through its existing `vote_claims`
mechanism, so vote-site retries are safe.

### GET /api/shop/catalog

```json
{ "currency": "denarius", "note": "…", "items": [
  { "sku": "aureus_100", "kind": "aureus", "name": "100 AUREUS", "description": "…", "price": 5000, "grant": { "aureus": 100 } }
] }
```

Catalog is code (`src/api/expansion/shopCatalog.ts`); crate ids must match the
plugin's `crates.yml`. Prices are display Denarius units; the plugin re-validates.

### POST /api/shop/order — session, linked

```json
// request
{ "sku": "key_vote_5", "quantity": 1 }
// 202 response
{ "ok": true, "queued": true, "id": 42, "requestId": "V1StGXR8_Z5jdHi6B", "sku": "key_vote_5", "quantity": 1, "totalPrice": 7500, "currency": "denarius" }
```

`quantity` 1-10 (defaults 1). `404` unknown SKU. Rate limit 5/min.

**Grant model:** the plugin's queue consumer re-validates the price, withdraws
`totalPrice` Denarius, and grants — AUREUS packs via
`EconomyService.depositPremium` (the single premium path; the AUREUS wall is
never bypassed), crate keys via CrateService — with flow-log reason `web:shop`.
Insufficient funds → mark the row `failed`.

### GET /api/vote/status?uuid= — pending vote rewards

Session (no `uuid`, self) or bot token (+`?uuid=`). `private, no-store`.

```json
{ "uuid": "…", "available": true, "pending": [{ "site": "planetminecraft", "queuedAt": "…" }], "totalVotes": 12 }
```

`pending` = `web_queue` rows with `kind='vote'`, `status='pending'` (queued by
the vote callback, granted in-game moments later). `totalVotes` counts
`vote_claims` for the player and is **absent** (not 0) until that plugin table
exists. Degrade: `available:false, pending:[]` when the queue is unreachable.

### GET /api/shop/orders?uuid=&limit= — order history

Session (self) or bot token (+`?uuid=`). `private, no-store`.

```json
{ "uuid": "…", "orders": [
  { "id": "7", "requestId": "V1StGXR8_Z5jdHi6B", "sku": "key_vote_5", "quantity": 2,
    "totalPrice": 15000, "currency": "denarius", "status": "done", "createdAt": "…", "processedAt": "…" }
] }
```

Orders are the player's `web_queue` rows (`kind='shop_order'`), newest first;
`status` is the queue row status (`pending` → `done`/`failed`/`skipped` once
the plugin settles it). Totals come from the signed-order payload, re-derived
from the catalog when missing. `503` when the queue table errors.

### GET /api/bounties/top?limit= — pooled bounty board (public)

```json
{ "available": true, "entries": [
  { "rank": 1, "target": "Caesar", "amount": 500000, "placers": 3 }
] }
```

Reads the LIVE Phase 9c table `pvp_bounty_board` (BountyBoardService): OPEN
rows grouped by `target_uuid`, `amount` = pool total, `placers` = distinct
placers, names via `player_names`. Only `state='OPEN'` rows are ever exposed.
Degrade: `{available:false, entries:[]}` when the table isn't deployed.

### POST /api/lfg/posts — Discord → in-game LFG board

Bot token. Body (Zod):

```json
{ "dungeon": "cloaca_maxima", "note": "need healer", "discordId": "999000111222333444", "username": "Caesar" }
```

`dungeon` is a lowercase slug (`^[a-z0-9_-]{1,64}$`), `note` ≤140 chars
optional, `username` is the linked Minecraft name (the worker resolves it from
its `account_links` table before calling). `202 {ok, postId, expiresAt}`
where `expiresAt` = now + 15 min (the in-game LFG post lifetime). `400`
validation, `401` bad token, `503` when the `lfg_posts` table isn't deployed
(worker shows its "not live yet" card).

### GET /api/events/feed?since=ISO — personal events (bot token)

```json
{ "available": true, "events": [
  { "id": "2", "type": "war_result", "uuid": "a25a17ce-…", "message": "Legio I victorious", "at": "…" }
] }
```

The worker's notification cron polls this every minute with
`?since=<last sweep>`. Types allowlisted to `contract_fulfilled |
war_result | season_milestone`; `since` is clamped to at most 1h back (a stuck
caller can't force an unbounded scan). Degrade: `{available:false, events:[]}`
until the plugin's producer lands.

### GET /api/economy/drift-alerts — staff drift inbox (bot token)

```json
{ "available": true, "alerts": [
  { "id": "1", "detectedAt": "…", "metric": "faucet:minesell", "direction": "up", "magnitudePct": 12.5, "status": "open", "summary": "…" }
] }
```

Last 7 days from `economy_drift_alerts` (specced — see plugin contract below).
Degrade: `{available:false, alerts:[]}`.

### GET /api/admin/liveops — calendar overrides + festival fund (bot token)

```json
{ "available": true,
  "overrides":   [{ "id": "3", "at": "…", "actor": "Caesar", "action": "skip", "target": "KOTH: Citadel", "note": "patch night" }],
  "festivalLedger": [{ "id": "…", "at": "…", "entry": "CREDIT — lottery:2026-08-14 (by system)", "amount": 12500 }] }
```

`festivalLedger` reads the LIVE `festival_fund_ledger` table (rake in / event
payouts out); `overrides` reads `events_calendar_overrides` (specced). Each
section degrades independently; `available` is true when either is live.

### GET /api/admin/contraband/sweeps?limit= — sweeper log (bot token)

```json
{ "available": true,
  "sweeps": [{ "id": "1", "at": "…", "target": "Brutus", "items": 3, "verdict": "confiscated", "action": "stripped", "staff": null }],
  "verdictStats": [{ "verdict": "confiscated", "count": 5 }] }
```

Reads `contraband_sweeps` (specced — the in-game ContrabandSweeper currently
logs to the console only; landing this table wires the staff view). Degrade:
all empty + `available:false`.

### GET /api/admin/player-tools?uuid= — read-only staff lookup (bot token)

```json
{ "uuid": "…", "available": true, "player": {
  "uuid": "…",
  "flowTail":  [{ "at": "…", "reason": "service:minesell", "amount": 1500, "currency": "denarius" }],
  "lockouts":  [{ "id": "cloaca_maxima", "type": "dungeon", "reason": "Dungeon lockout — cloaca_maxima", "expiresAt": "…", "active": true }],
  "pity":      [{ "id": "cosmic_storm", "rolls": 40, "threshold": 100 }] } }
```

`flowTail` is the LIVE `economy_transactions` ledger (display units); lockouts
read `dungeon_lockouts`; pity reads `pity_counters` (specced). Headline
balances/rank come from the existing `/api/player/profile` (the frontend
merges the two). Mutating actions deliberately do NOT exist here.

### Additions to existing endpoints

- `GET /api/server/status` now includes `players: string[]` — best-effort
  online-name list from `online_players` (public, mirrors the in-game tab
  list; ≤100). Absent table → empty array.
- `GET /api/player/profile` now includes `legion: string | null` (from
  `legion_members`/`legions`) and `kothRecord: "N wins" | null` (from
  `leaderboard_stats` category `KOTH_WINS`, ALL_TIME) — both cached in the
  same 15s envelope.

## The `web_queue` table + HMAC scheme

A durable queue in the shared Supabase Postgres. Backend INSERTs; the plugin
polls (~every 5s), claims, verifies, grants, and marks the row. The backend
never updates a row after insert.

```sql
CREATE TABLE web_queue (
  id BIGSERIAL PRIMARY KEY,                    -- plugin: ConnectionPool.pkAutoInc()
  request_id VARCHAR(32) NOT NULL UNIQUE,      -- backend-generated id (nanoid)
  kind VARCHAR(32) NOT NULL,                   -- 'vote' | 'shop_order'
  uuid VARCHAR(36),                            -- target player when known
  username VARCHAR(64),                        -- fallback identity (vote by name)
  site VARCHAR(64),                            -- vote site slug (kind='vote')
  sku VARCHAR(64),                             -- shop SKU (kind='shop_order')
  quantity INT NOT NULL DEFAULT 1,
  payload JSONB NOT NULL DEFAULT '{}',         -- extra context (NOT signed)
  status VARCHAR(16) NOT NULL DEFAULT 'pending',  -- pending | done | failed | skipped
  signature TEXT NOT NULL,                     -- hex HMAC-SHA256 (below)
  created_at TIMESTAMPTZ NOT NULL,             -- = to_timestamp(<createdAtSec>)
  processed_at TIMESTAMPTZ
);
CREATE INDEX idx_web_queue_pending ON web_queue (id) WHERE status = 'pending';
```

### Signature (the plugin MUST verify before granting)

```
message   = "v1|" + kind + "|" + request_id + "|" + (uuid ?? "")
          + "|" + (username ?? "") + "|" + (site ?? "") + "|" + (sku ?? "")
          + "|" + quantity + "|" + <created_at as unix SECONDS>
signature = lowercaseHex( HMAC-SHA256( WEBPANEL_HMAC_SECRET, message ) )
```

- Every message component is a plain `web_queue` column, so the plugin
  recomputes the signature from the row it just read and rejects mismatches —
  hand-edited or forged rows can never grant anything.
- `WEBPANEL_HMAC_SECRET` is the same Workers secret the plugin already shares
  for the Redis command bus (`env.webpanelHmacSecret` / plugin
  `IMPERIUMMC_HMAC_SECRET` or `webpanel.hmac-secret`). No new secret.
- Freshness: rows are written with the backend's clock; the plugin SHOULD
  discard (mark `skipped`) rows older than 24h.
- `payload` is context only (vote site payload / shop grant details) and is
  not part of the signature — the plugin must re-derive pricing/grants from
  `kind`/`sku`/`quantity`, which ARE signed.

### Plugin poll loop (contract)

```sql
-- claim: SELECT ... WHERE status='pending' ORDER BY id LIMIT 20
-- verify: recompute signature; reject mismatch (mark 'skipped')
-- grant: vote → existing vote flow (vote_claims dedup); shop_order → withdraw + grant
-- settle: UPDATE web_queue SET status='done'|'failed', processed_at=NOW() WHERE id=?
```

Flow-log reasons: `web:vote` (votes), `web:shop` (shop orders).

## Environment (new keys)

| Key | Where | Purpose |
|---|---|---|
| `VOTE_CALLBACK_KEYS` | Workers secret (`wrangler secret put`), optional | `site:key` comma pairs; gates POST /api/vote/:site. Empty/missing → all vote callbacks 404 (safe default). |
| `WEBPANEL_HMAC_SECRET` | existing Workers secret | Now also signs `web_queue` rows (same value as the command bus). |

## Consolidated plugin-side contract

Everything the PLUGIN must implement for the web ecosystem (backend + panel +
Discord worker) to finish wiring. Items 1–3 are the web_queue consumer and the
two producer surfaces; item 4 lists the read-only tables the new staff views
expect. None of this blocks deploys — every consumer degrades gracefully —
but each item lights up real features the moment it lands.

### 1. `web_queue` consumer (votes + shop orders) — REQUIRED, signed

Poll `web_queue` every ~5s (reuse the existing JDBC pool; prepared statements
only — see the schema + HMAC scheme above):

```sql
-- claim
SELECT id, request_id, kind, uuid, username, site, sku, quantity, payload, signature,
       EXTRACT(EPOCH FROM created_at)::bigint AS created_sec
  FROM web_queue WHERE status = 'pending' ORDER BY id LIMIT 20;
-- verify: recompute HMAC-SHA256(WEBPANEL_HMAC_SECRET, message) where
--   message = "v1|" + kind + "|" + request_id + "|" + COALESCE(uuid,'') + "|" +
--             COALESCE(username,'') + "|" + COALESCE(site,'') + "|" +
--             COALESCE(sku,'') + "|" + quantity + "|" + created_sec
--   (lowercase hex; mismatch → UPDATE ... SET status='skipped', processed_at=NOW())
-- rows older than 24h → 'skipped'
-- grant:
--   kind='vote'       → existing vote flow (vote_claims dedup per uuid+site+day)
--   kind='shop_order' → re-validate price from the catalog config, withdraw totalPrice
--                       Denarius, grant (AUREUS via EconomyService.depositPremium —
--                       never CurrencyManager — crate keys via CrateService)
-- settle:
UPDATE web_queue SET status='done'|'failed', processed_at=NOW() WHERE id=?;
```

Flow-log reasons: `web:vote`, `web:shop`.

### 2. LFG board bridge — poll `lfg_posts` (written by the Discord worker)

The worker's `/lfg` command inserts rows; the plugin surfaces them in-game:

```sql
CREATE TABLE lfg_posts (
  id BIGSERIAL PRIMARY KEY,             -- ConnectionPool.pkAutoInc()
  dungeon_id VARCHAR(64) NOT NULL,      -- dungeon slug
  note VARCHAR(140),
  discord_id VARCHAR(20) NOT NULL,      -- placer's Discord snowflake
  username VARCHAR(64) NOT NULL,        -- linked Minecraft name (displayed in-game)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,      -- backend sets now()+15 min (matches LfgService)
  delivered_at TIMESTAMPTZ              -- plugin sets this when the post is on the board
);
CREATE INDEX idx_lfg_posts_undelivered ON lfg_posts (id) WHERE delivered_at IS NULL;
```

Plugin poll loop (~every 5s): select rows `WHERE delivered_at IS NULL AND
expires_at > NOW()`, validate `dungeon_id` against the dungeon registry
(unknown → mark delivered + ignore), post to the in-game LFG board with
`username` as the leader display name, fire the existing
`LfgPostCreatedEvent(postId = id.toString(), dungeonId, leaderName = username,
leaderUuid = <resolved-or-NIL>, mode, slotsTotal, slotsFree)` for hooks, then
`UPDATE lfg_posts SET delivered_at = NOW() WHERE id = ?`. Expired-but-
undelivered rows should also be marked delivered (housekeeping). Web posts are
display-only board entries — they never move currency, so no signature is
required; the backend rate-limits writes (10/min/IP) and the worker requires a
linked account.

### 3. Producers: events feed + calendar (worker reads, plugin writes)

**`web_events`** — append-only personal-event log the worker's DM cron polls
via `GET /api/events/feed?since=`:

```sql
CREATE TABLE web_events (
  id BIGSERIAL PRIMARY KEY,
  event_type VARCHAR(32) NOT NULL,      -- 'contract_fulfilled' | 'war_result' | 'season_milestone'
  uuid VARCHAR(36) NOT NULL,            -- the affected player
  message VARCHAR(200) NOT NULL,        -- DM-ready, player-facing text
  at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_web_events_at ON web_events (at);
```

Insert one row at: contract fulfilment (ContractsService), legion war
resolution (KOTH/war service — one row per legion member), season milestone
(SeasonService rollover). Purge rows older than 7d.

**`events_calendar`** (already specced above) gains one convention: rows with
`kind='war'` or `'colosseum'` feed the bot's notification scheduler; a
colosseum row should carry `payload = {"signup_deadline": "<ISO>"}` so the
signup-deadline reminder fires. `festivals.active=TRUE` + current timestamps
drive the festival banner + omen pings.

### 4. Read-only tables the staff views expect (degrade until present)

| Table | Feeds | Notes |
|---|---|---|
| `events_calendar_overrides` `(id pk, actor, action, target, note, at)` | `/api/admin/liveops` override log | Write a row whenever staff start/skip an event. |
| `festival_fund_ledger` | `/api/admin/liveops` fund ledger | **ALREADY LIVE** (FestivalFundLedger) — no action. |
| `contraband_sweeps` `(id pk, swept_at, target_uuid, target_name, items, verdict, action, staff)` | `/api/admin/contraband/sweeps` | The sweeper currently console-logs only; INSERT one row per sweep verdict. |
| `economy_drift_alerts` `(id pk, detected_at, metric, direction, magnitude_pct, status, summary)` | `/api/economy/drift-alerts` | The economy monitor writes a row when a faucet/sink share drifts past threshold; staff ack/resolve in-game. |
| `pity_counters` `(uuid, counter_id, rolls, threshold, pk(uuid, counter_id))` | `/api/admin/player-tools` pity panel | Export from the crate/pickaxe pity trackers. |
| `vote_claims` | `/api/vote/status` lifetime total | If the existing vote-dedup table has a different name, either alias it or expose a counting view named `vote_claims(uuid)`. |
| `pvp_bounty_board` | `/api/bounties/top` | **ALREADY LIVE** (BountyBoardService, Phase 9c) — keep `state` values as-is; only `OPEN` is read. |
| `player_dungeon_stats`, `dungeon_lockouts`, `season_hall`, `economy_flow_hourly`, `legion_war_records` | personal dungeon stats, hall of fame, flow rollup, war records | Specced above; unchanged. |

Order of value: item 1 (unlocks vote + shop grants, both already taking
web-side writes), item 3's `web_events` (unlocks Discord DMs), item 2 (unlocks
`/lfg`), then the read-only tables as each subsystem is touched anyway.
