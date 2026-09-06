# Round 8 — Red-team, hazards, new findings (backend)

Eighth strict pass over `imperium-backend`, at `450ceb8` (`master`).
Code unchanged (all commits since Round 1 are docs-only). This round red-teamed
four top criticals (with numbers), mapped seven fix-interaction hazards, and
filed 4 new findings.

Rounds 1–7: `FINDINGS.md` (B-01…B-08), `ROUND-2.md` (B-09, B-10),
`ROUND-3.md` (B-11…B-17), `ROUND-4.md` (B-18…B-25), `ROUND-5.md` (B-26…B-34),
`ROUND-6.md` (B-35…B-42), `ROUND-7.md` (B-43…B-50). This file: **B-51…B-54 +
verdicts + hazards**.

| ID | Sev | Finding |
|---|---|---|
| B-51 | Medium | `/auth/exchange` shares the webcode limiter namespace — guesses burn OAuth budget (self-DoS) |
| B-52 | Medium | `consumeLoginCode` GET+DEL non-atomic — single-use violated under concurrency |
| B-53 | Low | Backend `verifyCommand` retains the v1 fallback + dead code (P-20 backend half) |
| B-54 | Low | Weak UUID-shape regexes on v2 ticket/moderation/ledger paths admit garbage |

---

## B-51 · Medium · Exchange shares the brute-force limiter (self-DoS)

One `webcodeRateLimit` instance (`'webcode'` prefix, `routes.ts:214`) serves
both `POST /auth/webcode/verify` (`:336`) and `POST /auth/exchange` (`:393`,
unauthenticated capability redeem, 60 s TTL): same D1 key
`webcode:<ip>:<window>`, same resolver. 8 fat-fingered guesses exhaust that
IP's exchange budget for 5 min → backend-completed OAuth callback unredeemable
(user bounced to login). Conflates a bot-gated brute-force bound with an
unauthenticated handoff.

**Fix:** separate instances/prefixes (`webcode` vs `exchange`), distinct budgets.

## B-52 · Medium · Login-code single-use violated under concurrency

`redis.ts:375-378` (`GET` then separate `DEL`; misses return pre-`DEL` by
design). Two concurrent consumes of one correct code both `GET` before either
`DEL`s → two sessions from one code. Same non-atomic class as B-15/B-18, new
site. Also bounds B-26 rotation per code.

**Fix:** Lua compare-del (or `GETDEL`) + per-code attempt counter
(`INCR login_attempts:<code> EX 900`, burn after 5 fails).

## B-53 · Low · Backend keeps the v1 fallback + dead code

`redis.ts:173-194` tries v2, then v1 (`:184-185` returns), leaving `:186-193`
unreachable. P-20 filed only the plugin side; the envelope-only accept lives
here too.

**Fix:** delete the v1 branch + dead code with P-20 (audit verify-callers
first — no sender emits v1, see hazard (a)).

## B-54 · Low · Length-range UUID regexes admit garbage

`tickets.ts:44` (`^[0-9a-f-]{32,36}$`i), `moderation.ts:26`,
`adminPanel.ts:162` (`^[0-9a-fA-F-]{32,36}$`) — 36 dashes or unstructured
32–35-char runs pass; B-48's cache-fill/enumeration pattern on new lines.
Distinct from B-06 (delegated header + profile query) and B-48 (`discord_id`).

**Fix:** reuse `mcUuidSchema` (accept dashed/undashed + case, normalize).

---

## Red-team verdicts (with numbers)

**(a) B-01 — CONFIRMED as privilege-escalation-after-leak; NOT unauthenticated RCE.**
Gate bypass byte-identical (`:191-193` unmapped→`panel-service`/admin,
`:196-199` unconditional true; all three role gates pass on `X-Bot-Token`
alone; named-helper gets *less* than bare token; X-04 zero staff headers,
proxies send bot-token + admin-uuid + body actor). But `BOT_API_TOKEN` is NOT
outsider-obtainable from repo posture: never in client bundles (no
`NEXT_PUBLIC_` prefix, 13 server-only files), never logged (zero token/header
log hits; only claimed *names*), never reflected (static 401s; sole exception
B-33 reflects driver text, not headers), not in repo (gitignored `.env`,
dashboard-Secret comment only, placeholders + `test-bot-token` in tests),
missing-token fails closed (header omitted → 401, no default). Remaining
exfiltration: Cloudflare dashboard readers, bot-host shell, frontend-server
compromise, holder re-sharing (one secret shared by bot + proxies + cron —
wide holder set). *Threat-model text should say "token holder", not "outsider."*

**(b) X-07/B-26 webcode brute force — PRACTICAL for token holders (numbers).**
10⁶ space (incl. `000000`), 8/5-min aligned windows, 900 s TTL, GET-then-DEL
(misses free), bot gate *after* limiter, raw `X-Original-Client-IP` bucket key.
Math: 24 nominal (32 max) guesses/lifetime → 500k avg needs ≈20,834 buckets
(free header strings); 556 rps fits one lifetime (50 conn × 200 ms ≈ 250 rps →
22.5%/code → 53% in 3 codes); D1 is an **accelerator**, not a brake (556
writes/s → contention → catch fails **open**). Without the token:
`cf-connecting-ip` unspoofable → 24 guesses → 0.0024%/code. Cheapest fix:
bucket by `sha256(botToken)` (24 guesses TOTAL per proxy) + per-code burn +
generic errors + split exchange limiter (B-51).

**(c) B-49 — CONFIRMED, scoped: 9 linked-gated endpoints + storeOrders session path.**
`app.ts:99-101` mounts `v2Api` without `attachUser`; `v2/index.ts:22-38` adds
none; only writer of `c.var.user` is `attachUser` (`routes.ts:90` covers
expansion only — `v2Api` is a *sibling*, inherits nothing);
`requireSelfOrDelegated` session branch reads null. Bot-gated v2
(ticketsV2/moderationV2/adminPanelV2/dm/changelog/member) WORKS; expansion
`/api/v2/*` residents DO get `attachUser`. Zero session-v2 tests.

**(d) B-20 — CONFIRMED, still zero consumers.** Full-`src` grep: definition +
types + storage + create/list logging + doc claim + authenticate-only test.
Zero route imports, zero 403 tests; `requireSelfOrDelegated` resolves any
`ownerUuid` key scopeless.

---

## Fix hazards (sequencing constraints — read before landing the Phase 1–5 fixes)

**(a) Deleting v1 fallback (P-20) — SAFE on the command bus now; don't touch `web_queue`.**
Backend sender already v2-only (`redis.ts:201-227`, always body-bound `:212`;
optional-`body` `:155-161` exists only for the verify fallback `:173-185`).
Either deploy order safe for the Redis bus — but delete the backend v1 accept
(`:184-185`) in the SAME change (plus dead `:186-193`), and do NOT touch the
`web_queue` HMAC (`expansion/webqueue.ts:40-53`, intentional `v1|…` pipe,
pinned by tests) — that breaks vote/shop fulfillment.

**(b) Removing the exemption (B-01) — breaks punish/broadcast/reload unless X-04 first.**
Exempt-path reliants (bot-token-only, zero `X-Staff-*`): all frontend admin
proxies + bot/cron `apiClient` (punish, lookup, history, permissions, sweep).
Killing the exemption solo 403s panel AND bot mutators. X-04 solo is a no-op
(short-circuit). **Naive-fix trap:** deleting only the `:198` early-return
while keeping `:192` (`fallback→'admin'`, rank 3) leaves the bypass intact —
both lines atomically, fallback to lowest privilege.

**(c) Status enum (B-16/bC14) — breaks the sweep unless `stale` is in the union.**
Cron writes `'stale'` (`:150`); bC14's proposed `['open','responded','closed',
'pending']` omits it → every sweep patch 400s, result ignored (`:150-157`
posts "Closed", archives thread, increments counters anyway) → rows stay open,
re-swept forever. All status writers enumerated (v2 POST fixed, v2 PATCH
arbitrary, v1 POST default-dependent, v1 respond arbitrary, cron `stale`, bot
`closed`+`pending`, notes-author default). Decide `stale`-vs-`closed` first,
backfill rows, enforce on both PATCH surfaces together (B-18's cap counts only
`'open'` — same enum).

**(d) B-49 attachUser — enablement, no working-flow regression; land with frontend + CSRF + ordering.**
Nothing works via session today, so nothing breaks; what CHANGES: keys/gallery/
guides/comments/storeOrders flip 401 → 200/201/403. Constraints: frontend must
handle new 403/`linkRequired`/success (`GuideComments`, gallery
`credentials:include`, dashboard/orders); CSRF review (cookie-authed v2 mutators
lack `Origin` checks — contrast `storeAuth`); `rateLimitV2` runs before any
`attachUser` would (IP-only principal unless ordered first). No 401-as-logic
branches found.

**(e) UUID validation — normalize, don't reject (Bedrock/dot-names/undashed/uppercase are legit).**
`storeAuth` allows dot-names (`:1627-1628` — UUID-only kills Bedrock checkout);
`mcUuidSchema` accepts+normalizes dashed/undashed/any-case (strict canonical
400s legal expansion callers); `admin/player?query=` accepts uuid OR username
(UUID-only breaks lookup); frontend forwards verbatim (canonical from Java
UUIDs, but DB/edge may carry variants); Floodgate UUIDs pass canonical — only
`.name` identities need the username branch. Adopt `mcUuidSchema` per field,
keep dot-name + username branches explicit. Blanket canonical-only rejection
breaks Bedrock + lookup.

**(f) Scope enforcement — flag-day; publish the matrix first.**
No prod keys/seeds found; `keys.ts:44-46` requires ≥1 scope (no broad default);
sole gate resolves any `ownerUuid` key. Landing flips every over-broad reliance
200→403 at once, and **no scope→route map exists** — publish matrix +
audit/notify keys + per-route `requireScope` + 403 tests as one flag-day.

**(g) Throwing gameQuery — wrap callers first (or outages become 500s).**
Already degrading (safe): profile/balances/stats extras, leaderboards
rank/legion (frozen-mirror branch). Rely on `[]`-as-valid (throw → 500/503):
online-count `:1349`, username resolve `:1395`, transactions/count `:734-742`,
`pool.ts` fallbacks (caught into stale mirror — the cited swallow), generic
boards, `/server/status`. Flip turns frozen-mirror → hard 500, cards → crash.
Reconcile the `legion_members` column mismatch first (swallowed today, loud
500 after the flip), wrap every site with explicit degrade
(`available:false`/staleness), THEN flip.

## Coverage notes

Verified at HEAD (`450ceb8`, tree clean; `src/` unchanged since `eba7716`):
mount chains, principal logic, bot-auth/actor/role/webcode/exchange/storeAuth/
tickets/admin sections, sign/verify/send + consume, swallow + callers,
resolvers/principals, keys/openapi/tests, sweep/ticket/bot-client status writers,
admin/expansion gates, bridge send/healthz, gallery reflections,
wrangler/env/gitignore, frontend session/storeAuth/guard + proxies + shipped vars.
**NOT covered:** live Worker posture; plugin-side v1 state, `legion` parsing,
`web_queue` verifier, price re-validation; `migrate-tables.cjs` ticket-table
defaults (needed for the status-union); production traffic rates (feasibility
uses documented costs + fail-open logic, not load tests); P-11/P-13… re-verification
beyond P-20's bridge interaction.
