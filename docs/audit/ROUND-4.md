# Round 4 — Findings (backend)

Fourth strict pass over `imperium-backend`, at `d242948` (`master`).
Code unchanged (all commits since Round 1 are docs-only). This round covered
the v2/expansion route remainder, the bot, the PayNow client, API-key scopes,
the SSE stream, and the rate limiter — plus a dedupe review against the
concurrent session's C8…C13 (filed in `docs/AUDIT_GLM_COMPLAINTS.md` while this
pass ran).

Rounds 1–3: `FINDINGS.md` (B-01…B-08), `ROUND-2.md` (B-09, B-10),
`ROUND-3.md` (B-11…B-17). This file: **B-18…B-25**.

| ID | Sev | Finding |
|---|---|---|
| B-18 | Medium | v2 ticket lifecycle: 2-open cap evadable and racy; cron writes invented `stale` status; sweep truncates at 100; orphan threads |
| B-19 | High | v2/expansion admin reads are shared-token-only vs their own staff-gate comment; unbounded PII enumeration |
| B-20 | High | API-key scopes decorative: `requireScope` has zero route consumers |
| B-21 | Medium | PayNow client: unguarded `JSON.parse`, no timeout, unmapped products fall through inconsistently both directions |
| B-22 | Medium | Bot mod-confirm: no rank re-check (TOCTOU), predictable nonce, silent post-recycle drop, timer leak |
| B-23 | Medium | Shared-token authority lets caller content speak as the server on Discord (changelog, DMs, bridge) |
| B-24 | Medium | SSE stream uncapped with per-isolate replay semantics contradicting resumability |
| B-25 | Medium | Standing-rule violation: `rateLimitV2` reintroduces the in-memory limiter its own doc says was fixed |

---

## B-18 · Medium · v2 ticket lifecycle holes (extends B-16, not a re-file)

**Evidence:** `src/api/v2/tickets.ts:50-56` (cap counts only `status='open'`,
but PATCH accepts any string — B-16), `:63-68` (check-then-insert, no
`ON CONFLICT`/partial unique index), `:96-99` (`LIMIT 100`), `:117-130`
(PATCH), `src/bot/cron.ts:125-157` (thread created+posted at `:125-131` before
`patchTicketV2` at `:136`; sweep writes invented `'stale'` at `:150`).

1. Cap evasion: PATCH any ticket to an invented status and the 2-open cap stops
   counting it. 2. Race: two concurrent POSTs both seeing count 1 both insert.
   3. Sweep truncation: >100 open tickets, the rest never auto-close. 4. Orphan
   threads: patch failure after thread creation leaves a live staff-visible
   thread with no row link.

**Fix:** enum-validate `status`; enforce the cap in DB (partial unique index /
counter table / conditional insert); patch-first-or-delete-thread; paginate sweep.

---

## B-19 · High · v2/expansion admin reads: staff-gate comment, shared-token enforcement

**Evidence:** `src/api/v2/adminPanel.ts:9-11` (comment: "Staff-gated (helper for
reads…)") vs `:24-27` (`botTokenMatches` only). Same shape: `moderation.ts:19-22`,
`tickets.ts:24-27`, `dmApi`/`changelogApi`. No staff header, role, identity, or
audit write anywhere. Caller filters verbatim (`check`/`uuid`/`since` `:39-51`
— `uuid` unvalidated here, though the ledger route at `:162` does validate;
`actor`/`action` `:119-126`). Responses carry anticheat feed (`player_uuid` +
name + check + VL `:64-73`), audit actor/target/details (`:139-146`), ticket
uuid/username/subject/thread (`tickets.ts:97-102`). B-01's shape in a new place —
and weaker (B-01 at least *has* gates to bypass; these never had any).

**Fix:** real staff principal (role ≥ helper reads, ≥ mod ledger/history/tickets,
reusing `resolveStaffActor`/`staffActorHasRole`); validate `uuid` on every
filter; log admin-read access with resolved actor.

---

## B-20 · High · API-key scopes decorative: `requireScope` has zero consumers

**Evidence:** `src/middleware/gates.ts:113-126` (definition),
`src/api/v2/openapi.ts:45-47` (claim "(scopes per key, enforced by
requireScope)"), repo-wide search: definition + comment only. The sole
`api_key` gate `requireSelfOrDelegated` (`:99-111`) sets `mcUuid` from *any* key
with `ownerUuid` (`:105-106`) without looking at `scopes`. A
`webhooks:manage`-only key reads `/api/v2/store/orders` like a `read:*` key.
Lifecycle tests pin authenticate-carries-scopes and revoke — never enforcement.

**Fix:** `requireScope('read:…')` on every `api_key`-accepting chain *before*
identity resolution + a 403-test for a scoped-out key; or delete scope UI/docs
until enforcement exists.

---

## B-21 · Medium · PayNow client: error-type confusion, no deadline, tier-mapping hole

**Evidence:** `src/paynow/client.ts:36-43` (`JSON.parse` on raw text — non-JSON
upstream errors throw `SyntaxError`, missing the `PaynowApiError` branches at
`routes.ts:1776-1778, 1858-1860, …`); `request()` has no `AbortSignal.timeout`
(C4 hang class, user-facing checkout/cancel await it inline);
`findTierBySubscriptionProductId` (`constants.ts:83-85`) returns null for
unmapped products and **nothing on the read path calls it** — live path renders
foreign/test products as `subscription: null` (`:1702-1705`) while the webhook
caches any `product_id` verbatim (`:2127, :2142`) and the cached read serves it
as active (`:1689-1696`): opposite answers per path (reachable today via
still-unvalidated checkout `:1835-1845`, B-14).

**Fix:** try/catch parse → `PaynowApiError(status, {raw})`; 8 s timeout;
allowlist `product_id` at webhook ingest AND cached read (unknown → absent +
unavailable-signal, never active tier).

---

## B-22 · Medium · Bot mod-confirm: TOCTOU + predictable nonce + silent drop + timer leak

**Evidence:** `src/bot/commands/moderation.ts:90-92` (`Math.random` nonce —
same predictable-PRNG class as P-18), `:32` (map), `:35-53` (consume re-verifies
linkage only — never `requireStaff()` again, though execute-time did at
`moderation.ts:94,101,216`; the record doesn't even store the required level);
`pendingConfirms` per-isolate `Map` — post-recycle/expiry confirm clicks hit
`:36-40`/`:42-45` (bare `deferUpdate`, user sees ack, nothing happens);
`interactions.ts:127-130` races `shim.firstAck` vs uncleared `setTimeout 2500`
(C9 pattern, new site).

**Fix:** store `{requiredLevel}`, re-`requireStaff` in consume; `crypto.randomUUID()`;
explanatory embed on missing/expired; `clearTimeout`/AbortSignal on the race.

---

## B-23 · Medium · Shared-token callers speak as the server on Discord

**Evidence:** `src/api/v2/dms.ts:181-186` (changelog post: shared-token gate,
caller `title/description/changes[]`, hardcoded fallback to owner's real channel
`:191`); `:119-156` (DM enqueue: any uuid → linked Discord, arbitrary
title/message, unvalidated `type`, per-IP-only rate limit — rotate targets, and
proxied traffic shares IPs); `:233-236` (queue drain `LIMIT 10` with no claim —
overlapping cron ticks double-deliver, Discord sends not idempotent);
`src/bot/bridge.ts:149-155` (envelope validated on `kind` string alone),
`:115-145` (no `allowed_mentions` — body can carry `@everyone`, only
`safeUsername` sanitized, sibling sender sets `parse: []`), `:188-197`
(unauthenticated `/healthz` with failure counters next to a gated send path).

**Fix:** staff/service principal for changelog + DM-enqueue; drop channel
fallback (503 when unconfigured); allowlist `type`, validate `uuid`, per-target
caps; atomic claim before send; per-kind envelope validation +
`allowed_mentions: {parse: []}`; gate `/healthz` or strip details.

---

## B-24 · Medium · SSE stream uncapped, per-isolate replay contradicts resumability

**Evidence:** `src/api/expansion/sse/stream.ts:131` (no auth, no readRateLimit —
contrast every neighbor), `:105-125` (10-min `sleep(500)` pump per connection,
no concurrent-connection cap); ring module-local (`poller.ts:40,97-102`, size 50),
cursor module-global first-positioned at `MAX(id)` (`:163-173`); `Last-Event-ID`
also via query string (`stream.ts:140`, seqs into URLs/logs). Reconnect on a
different isolate: different ring/cursor/seq — gaps or duplicates, no signal
(the file admits best-effort per-isolate at `poller.ts:11-14`). Inconsistent
disclosure model: SSE `events` strips `uuid` (`:185`) while REST exposes it
(`community.ts:168-179`), undocumented.

**Fix:** `readRateLimit` + per-IP concurrent-stream cap (`Retry-After` past N);
document best-effort resume + uuid-redaction (or stop redacting with reason);
header-only seq.

---

## B-25 · Medium · Standing-rule violation: `rateLimitV2` reintroduces the fixed in-memory limiter

**The promise** (`src/middleware/rateLimit.ts:8-18`): per-isolate Map was
"effectively no limit"; "This implementation uses the D1 binding … as the
shared counter store." **The code** (`src/middleware/rateLimitV2.ts:44`):
`const buckets = new Map<string, CostWindow>()` — per-isolate, the
documented-broken shape. Plus: budgets from `process.env` only (`:34-35`),
which `bot/cronConfig.ts:8-11` proves is the wrong source on Workers (always
240/480 deployed); `inferClass` (`:77-85`) misses `/api/v2/*` (SSE mounted via
`expansionApi.route('/v2', …)`) so newest surface falls to `std`; `principalOf`
(`:87-93`) collapses every machine caller to `'bot'` — one shared fairness
bucket across all integrations.

**Fix:** D1/KV-backed counters; bindings-first budget reads; prefix-match v2
paths; key machine bucket by token-hash prefix.

---

## Relation to concurrent C8…C13 (same-week, other session — no double-count)

- **bC11 (bridge RangeError DoS) ≈ B-17** (Round 3, same lines `bridge.ts:169-174`):
  same defect, two framings (DoS/500 vs oracle/alert-spam). Fix once — either
  remediation (length guard or SHA-256 pre-hash); keep B-17's alert-spam angle.
- **bC13 (D1 rate-limit contention) vs B-25:** same subsystem, different files
  (`rateLimit.ts` ACID-per-request vs `rateLimitV2.ts` in-memory regression).
  Fix together (native `RATE_LIMITER`/KV + D1 only where transactional need exists).
- **bC8 (`dbWriteBestEffort`)** extends B-11's cancel-path instance to the general
  pattern — noted, not re-filed. **bC9 (timer leaks):** B-22 cites it as a new
  instance, not a duplicate. **bC10 (storeOrders):** adjacent to B-20/B-21, no overlap.
- **bC12 (bridge event ceiling/avatar):** untouched by the B-series — open, keep.

## Coverage notes

**Verified good (recorded so they aren't re-litigated):** public profiles exclude
`aureus`/`auctoritas` by construction + tests; vote-callback keys per-site,
timing-safe, unknown-site 404; analytics rollup has **no HTTP surface**
(cron-only, fixed SQL — no injection point); `players.ts:35-44` `selfOnly` and
`dungeonsApi` identity-from-cookie are the correct pattern v2 session routes
should mirror; no secret *values* in log contexts (IDs only).
**NOT covered:** D1 migrations after 0001 / `migrate-bot-tables.cjs` (absent from
snapshot — lens unexecutable, not clean); Hyperdrive/TLS + live secret posture
(C1–C4 confirmed-not-fixed, nothing new to add); CORS preflight narrowness
(footgun for direct-browser callers, left unverified against live responses).
