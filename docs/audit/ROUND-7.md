# Round 7 — Findings (backend)

Seventh strict pass over `imperium-backend`, at `5af33cb` (`master`).
Code unchanged (all commits since Round 1 are docs-only). This round covered
the expansion leftovers, Discord internals, security test gaps, a credential
census, and SSE/wiring remainders.

Rounds 1–6: `FINDINGS.md` (B-01…B-08), `ROUND-2.md` (B-09, B-10),
`ROUND-3.md` (B-11…B-17), `ROUND-4.md` (B-18…B-25), `ROUND-5.md` (B-26…B-34),
`ROUND-6.md` (B-35…B-42). This file: **B-43…B-50**.

| ID | Sev | Finding |
|---|---|---|
| B-43 | High | Staff-only SWR endpoints served as `Cache-Control: public` |
| B-44 | High | Discord `/profile` `/balance` `/stats` expose private currencies for arbitrary targets |
| B-45 | Medium | `POST /api/lfg/posts` lets any bot-token holder post as any Minecraft name |
| B-46 | Medium | Legion card cache key normalized but DB lookup not — cache deception |
| B-47 | High | Four of six most security-critical paths have zero route-level tests |
| B-48 | Medium | `/api/v2/member` accepts 5–25-digit `discord_id`, canonical schema requires 17–20 |
| B-49 | High | v2 session sub-app never runs `attachUser` — every linked-gated v2 route always 401s |
| B-50 | Medium | Standing-rule violation: `sharedSnapshot` promises once-per-tick, implements once-per-overlap |

---

## B-43 · High · Staff data cached as `public` (no `Vary`, CDN-cacheable)

`src/api/expansion/cache.ts:156-160` sets `public, max-age=60,
stale-while-revalidate=300` unconditionally in `buildResponse()` — including
bot-gated staff views `economy.ts:147` (`/drift-alerts`: drift magnitudes),
`adminViews.ts:64` (`/admin/liveops`), `:129` (`/admin/contraband/sweeps`:
targets/verdicts/staff, festival ledger). Upstream caches key by URL with no
`Vary: Authorization`, no `private`. Sibling `adminViews.ts:268`
(`/admin/player-tools`) does it right (`private, no-store`). Not B-19 (auth) or
B-24 (SSE caps) — this is response cacheability.

**Fix:** `swrJson(c, key, fetcher, {visibility})` defaulting public; staff
callers pass private + skip `edgePut`; test asserting `Cache-Control` on
`/drift-alerts` and `/admin/liveops`.

---

## B-44 · High · Bot publishes premium balances for arbitrary targets (web: PRIVATE)

`src/bot/commands/profile.ts:19-22` (same `balance.ts`, `stats.ts`):
`getTargetUserOption(interaction) ?? interaction.user.id` + non-ephemeral
`deferReply()`; `embeds.ts:87-94` renders `Aureus`/`Auctoritas`. The web privacy
contract is explicit (`publicProfiles.ts:79-81`: "Aureus and auctoritas are
PRIVATE and intentionally absent"). Any guild member runs `/profile @victim` →
whole channel sees premium balances. IDOR-by-Discord-ID: no self-check, no
ephemeral, no redaction. Round-4 "verified good: public profiles exclude
aureus/auctoritas" never examined the bot path — the wider exposure.

**Fix:** self-only currency fields (rank/stats may keep targets); else ephemeral
+ strip `aureus`/`auctoritas` for non-self; mirror `PublicProfile` as allowlist.

---

## B-45 · Medium · LFG board impersonation via unsigned display field

`src/api/expansion/community.ts:56-68` — `username` caller-asserted
(`mcUsernameSchema` shape only), no link lookup, no `discordId ↔ username`
match; comment (`:64-68`) claims "`username` is the linked Minecraft name
(resolved by the worker)" — code trusts the claim verbatim. Under B-13's model
anyone impersonates any player on the in-game LFG board (plugin surfaces the
name as party leader). Distinct from B-23 (Discord speak-as-server) and B-27
(command strings) — `community.ts:195`/`webshop.ts:160` show the repo knows the
bot-may-target-any-uuid rule; here it hits an unverified display identity.

**Fix:** resolve `username` server-side from `discord_links` by `discordId`
(`memberRoles.ts` pattern); ignore/reject mismatches; or require the delegated
service token.

---

## B-46 · Medium · Legion cache key/query casing disagreement

`legions.ts:29` caches `legion:card:${name.toLowerCase()}:v1` but `:51` queries
`WHERE l.name = $1` with raw `name`. `LegioI` vs `legioi` share one entry but
query different keys: case-sensitive collation serves the wrong card (owner/
motd/bank/roster) for 60 s + 5 min stale + 24 h bridge; case-insensitive merely
redundant. No `trim()` either (spaces pass `LEGION_NAME_PATTERN` → junk keys).
New lines, not B-37 (ranking/units).

**Fix:** normalize once (`LOWER(l.name)=$1` with lowered key, or 400 on
non-canonical); `trim()` pre-validation.

---

## B-47 · High · Zero route tests on webhook ingest, checkout allowlist, ticket caps, webcode bound

`src/test/*.ts` (16 files): staff RBAC gates **covered**
(`audit-attribution.test.ts:35-108` incl. exempt path) and bot-token 401s
**covered** (`expansion-community`, `member-roles` asserts) — but PayNow
webhook verify+ingest = **ZERO** (`webhooks/paynow|verifyPaynow` no hits; only
outbound emit/deliver tests), checkout validation = **ZERO** (no
`app.request('/api/store/checkout')`; `checkout.test.ts:9-10` concedes "can't
import the real module"), ticket caps = **ZERO** (`TICKET_LIMIT` no hits),
webcode bound = **ZERO**. So C-15 replay, C-16 order black hole, B-09 desync,
B-14, B-18/B-30, B-26 can all regress silently.

**Fix:** four route tests via `createApp` + mocked query/PayNow/Redis (bad-sig
→ 401 + replayed-id handling; unknown `productId` → 400; third open ticket →
429; 9th guess → 429); un-skip by importing real `constants.ts` with stubbed env.

---

## B-48 · Medium · `discord_id` validation width mismatch + cache-fill surface

`memberRoles.ts:37` (`/^\d{5,25}$/`) vs canonical `schemas.ts:59`
(`/^\d{17,20}$/`); LFG uses the strict schema, this route doesn't. 5–16-digit
IDs (never real snowflakes) still cost a DB join + Redis entry each
(`member_summary:${discordId}`, `:41-43`) — enumeration/cache-fill under B-13;
success de-anonymizes the Discord↔Minecraft link (uuid/username/rank/prestige/
donor+expiry). Round-6 called this endpoint "targeted-read correct" — width
wasn't checked.

**Fix:** use `discordIdSchema`; per-target rate cap alongside the IP bucket.

---

## B-49 · High · v2 sub-app missing `attachUser` — linked-gated v2 routes always 401

`app.ts:99-101` mounts `v2Api` with cors/secureHeaders/rateLimitV2/logger only —
no `attachUser`; `v2/index.ts:22-38` adds none. But `keys.ts:22`
(`requireLinked`), `gallery.ts:143`, `guides.ts:103,133`,
`guideComments.ts:56,96` all require `c.var.user`/`c.var.mcUuid`, set only by
`attachUser` (`middleware/auth.ts:21-43`, applied at `routes.ts:90` for
expansion residents only). `gates.requireSelfOrDelegated`'s session branch
(`gates.ts:57`) is equally dead → `storeOrders.ts:27` session path dead too
(key/delegated paths work). The whole v2 UGC + key-management plane unreachable
with a real browser session — always 401/403 — with zero session-v2 tests
(`api-v2-contract.test.ts`: ping/leaderboards/openapi, all public). Round-5's
"no unintentionally-unauthenticated route" checked the wrong direction.

**Fix:** `v2Api.use('*', attachUser)` (or `app.use('/api/v2/*', attachUser)`
pre-mounts); one session test per gated v2 route (`api-expansion.test.ts`
`sessionCookie` pattern).

---

## B-50 · Medium · Standing-rule violation: snapshot dedupe is overlap-only, not per-tick

**Promise** (`sse/poller.ts:53-57`): "at most once per tick regardless of how
many connections ask (in-flight promise dedupe)". **Code** (`:58-72`): dedupe
is only the concurrent `inFlight` promise; sequential connections per tick
window (the normal case — each `await sleep(500)` then pulls) each fire full
upstream queries (`season` = 2× Postgres, `economy` = `SUM`, `events` =
MAX/range). N connections ≈ N queries per interval. No last-fetched check —
the scalability rationale fails under the exact load it was built for.

**Fix:** `lastFetchAt` per topic; serve cached snapshot when within
`def.intervalMs`; keep `inFlight` for thundering-herd; add the sequential
sibling to the concurrent test.

---

## Credential census (appendix — no new live secret; relevant rows re-verified)

`src/`, `wrangler.jsonc`, `.env.example`, `migrations/`, `*.cjs`;
`password|secret|token|webhook|discord.com/api|channelId|jdbc:|supabase|
hyperdrive|api[_-]?key` + 17–20-digit runs; fixtures excluded, prior
dispositions honored. Result: Supabase pooler password (`wrangler.jsonc:24`,
`migrate-tables.cjs:22-24` — C1, still present, rotate both); MySQL+Supabase
fallbacks (`rebuild-currency-balances.cjs` — B-35, still present); Discord
client ID / Ed25519 pubkey / PayNow store + 16 product IDs (public by design);
`dms.ts:191` fallback channel (operationally sensitive, covered by B-23 fix);
owner handle (public); endpoint strings/names only (no values); `db/*`,
`env.ts`, `worker.ts` read bindings from env (correct); `.env.example`
placeholders; D1 migration DDL-only; no hardcoded secret *values* in `src/`
outside tests; `.env` untracked/gitignored, not committed (do not commit;
ensure rotation runbook). Full per-location table retained in working notes.

## Coverage notes

**Verified good (not re-filed):** `roles/sync.ts` touches only donor+prestige
`managedRoleIds` (officer/admin structurally untouchable); `notify/scheduler.ts`
mention discipline correct (B-23 hole is bridge/DM-enqueue, not scheduler);
moderation staff commands all via backend LuckPerms `requireStaff` (vs `/ticket`'s
role trust, B-40); vote key length guard + 401/404 tests; shop SKU/quantity
tests; artifact-name traversal tests.
**NOT covered:** live Worker posture (dashboard secrets/TLS/pool, live
preflight, real IDs); plugin-side LFG/`legion` parsing + `web_queue`
verification + price re-validation (B-27 hardening unverified cross-repo);
`shopCatalog.ts` rate economics + dungeon/player aggregates beyond auth/shape.
