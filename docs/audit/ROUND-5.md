# Round 5 — Findings (backend)

Fifth strict pass over `imperium-backend`, at `a7f09ed` (`master`).
Code unchanged (all commits since Round 1 are docs-only). This round covered
the routes remainder, the deploy surface, and trust boundaries — plus dedupe
against C14…C15 (filed in `docs/AUDIT_GLM_COMPLAINTS.md` while this pass ran).

Rounds 1–4: `FINDINGS.md` (B-01…B-08), `ROUND-2.md` (B-09, B-10),
`ROUND-3.md` (B-11…B-17), `ROUND-4.md` (B-18…B-25). This file: **B-26…B-34**.

| ID | Sev | Finding |
|---|---|---|
| B-26 | High | `X-Original-Client-IP` trusted for rate-limit bucketing on shared-token auth — defeats the webcode brute-force bound |
| B-27 | Medium | Legion `DISPATCH_COMMAND` strings from user input with length-only checks |
| B-28 | Medium | `GET /player/lookup` username→UUID oracle for any session, with Mojang fallback + registry writes |
| B-29 | High | v1 `/admin/player` and `/admin/server/status` skip the staff role gates siblings enforce |
| B-30 | Medium | `POST /referrals/create`: promised rank-V check doesn't exist; already-referred guard unbacked — standing-rule violation |
| B-31 | Medium | `GET /refcode/mine`: `Math.random` codes + `ON CONFLICT DO NOTHING` with unconditional success |
| B-32 | Low | Webhook `:id/test` fans `test.ping` to **all** subscribers, not `:id` |
| B-33 | Low | Public gallery list reflects D1 error text into `error.details` |
| B-34 | Low | UGC controls inconsistent: guides publish immediately with no quota |

---

## B-26 · High · Webcode rate bucket keyed on spoofable header (X-07 backend half)

**Evidence:** `src/api/routes.ts:214-225` — `webcodeRateLimit` (8 attempts/5 min)
uses caller `X-Original-Client-IP` as bucket key whenever `requireBotAuth(c)`
passes; `POST /auth/webcode/verify` (`:336-355`) accepts 6-digit codes
(`:348`), consumes single-use, signs a `mc_code` JWT for the victim uuid
(`:366-371`); wrong guesses cost nothing (`redis.ts:375-378` returns before
`DEL` on miss). Anyone holding `BOT_API_TOKEN` (B-13's threat model) names a
fresh IP per request → unbounded guesses → consume a victim's code → session as
that player. Rot: `env.ts:24-26` documents `trustProxy` as "The rate limiter
reads this"; `rateLimit.ts:55-62` / `rateLimitV2.ts:109-113` never read it (dead
var; edge-safe only because Cloudflare strips `cf-connecting-ip` — the webcode
path re-opens the hole one layer up).

**Fix:** bucket by `sha256(botToken)` + code-independent key, or always
`cf-connecting-ip`; honor `TRUST_PROXY` in all resolvers or delete it.

---

## B-27 · Medium · Legion command strings from user input, length-only checks

**Evidence:** `src/api/routes.ts:2452-2453` (`legion create ${name}`, length
3–20 only — spaces/extra tokens pass) and `:2487-2488` (`legion invite
${username}`, presence-only, no charset check). Transport sound (v2 body-bound
HMAC); purely a plugin-parse injection surface, plugin handling unseen from
here — filed as hardening. (`legion leave`, fixed string, fine.)

**Fix:** allowlist names / `mcUsernameSchema`; better, structured
`{subcommand, args[]}` joined plugin-side.

---

## B-28 · Medium · Lookup oracle + unsolicited registry writes from low-privilege path

**Evidence:** `src/api/routes.ts:1934-1948` — any login (link NOT required)
resolves arbitrary usernames (404-vs-200 oracle); `src/db/pool.ts:364-393`:
on `player_names` miss, fetches Mojang then PlayerDB for **any** Java username
and `INSERT`s into the shared registry the plugin treats as authoritative-ish.
Enumeration + attacker-chosen outbound fetches + writes from a low-privilege path.

**Fix:** require linked-or-bot; `mcUsernameSchema`; don't cache
externally-resolved rows from this path (or gate caching on bot auth); tighter
per-route limiter.

---

## B-29 · High · v1 admin reads skip staff gates (B-19's v1 remainder, new lines)

**Evidence:** `src/api/routes.ts:921-924` (`GET /admin/player`, full profile +
balances `:957-970`) and `:882-885` (`GET /admin/server/status`, up to 100
online uuid+username rows `:898-906`) — both `requireBotAuth`-only vs
punish/broadcast/reload's `resolveStaffActor`/`staffActorHasRole`
(`:1014-1018, :1058-1062, :1085-1089`). Shared-token holders dump ranks,
balances, stats, live roster — no role distinction, no audit actor beyond
`panel-service`. (Also inherits B-28's oracle via `:932-936`.)

**Fix:** same `staffActorHasRole` gates (helper+ reads); validate `query` shape
pre-Mojang-fallback.

---

## B-30 · Medium · Referral eligibility check doesn't exist — standing-rule violation

**The promise** (`src/api/routes.ts:2343-2344`): "Check if the referred player
already has a rank higher than I (rank V = prestige 5+)… prevents referring
established players just for the reward." **The code:** straight to `INSERT` —
no rank/prestige query anywhere; established-player farming works. Second
defect (`:2336-2351`): already-referred guard is `SELECT` → `INSERT`, but schema
backs only `UNIQUE(referrer_uuid, referred_uuid)` (`migrate-tables.cjs:104-109`)
— racing referrers both pass, both insert.

**Fix:** implement the eligibility read (or delete the comment); partial unique
index on `referred_uuid` (or compare-and-insert), conflict → 409.

---

## B-31 · Medium · Refcode: predictable codes + swallowed collisions

**Evidence:** `src/api/routes.ts:2512-2523` — 6-char codes from `Math.random`
(same predictable-PRNG class as P-18/B-22; repo already has `generateLinkCode`
with `crypto.randomBytes`, `redis.ts:391-398`); `code` has a `UNIQUE` index
(`migrate-tables.cjs:125-128`) but the loop retries only on *thrown* errors —
collision swallowed by `DO NOTHING`, route still returns the colliding code as
the caller's own (two players "own" one code; redeem attributes to the other row).

**Fix:** `crypto.randomBytes` selection; `INSERT … RETURNING`, retry on zero rows.

---

## B-32 · Low · Webhook test fans out to all subscribers

**Evidence:** `src/api/expansion/webhookAdmin.ts:83-91` — looks up `:id`, checks
`active`, then `emit({type: 'test.ping', …})`; `emit` (`deliver.ts:55-62`) fans
to every active subscriber. "Test this subscriber" spams all endpoints
(internal-only today); a green test says nothing about `:id`.

**Fix:** single delivery row for `:id`, not `emit`.

---

## B-33 · Low · Gallery error reflection (sole response-leak exception)

**Evidence:** `src/api/v2/gallery.ts:113` (and `:137`) — unauthenticated list
route reflects D1/driver message into `error.details` (`respond.ts:33-35`
serialises it). `app.onError` generic + log-contexts clean (re-verified) — this
is the one exception; driver text can carry table/SQL fragments.

**Fix:** drop the fourth arg on public routes (log it instead).

---

## B-34 · Low · Guides publish immediately with no quota (UGC asymmetry)

**Evidence:** guides create (`guides.ts:103-131`) — `status='published'` on
insert, 50 kB body, no per-author quota/cooldown beyond the shared 10/min IP
bucket vs gallery (`gallery.ts:156-169`: 3/day + pending-until-approve) and
comments (`guideComments.ts:75-81`: 1/30 s/player/guide). Instant-public spam/
defacement; repo already chose stricter twice for sibling UGC.

**Fix:** mirror comments (per-author cooldown); consider `pending` for first-post
authors.

---

## Relation to concurrent C14…C15 (same-week — no double-count)

- **bC14 (ticket author/status/rowCount)** extends B-16's enum prescription to a
  second site (v1-respond) and adds two new angles (missing author insert,
  rowCount check). Complementary — fix together with B-16/B-18.
- **bC15 (PayNow webhook replay nonces)** companions B-10 on a different protocol
  (webhook vs admin-register). No overlap; both open.

## Coverage notes

**Verified good:** v2 `keys.ts` lifecycle (validates, one-time plaintext, redacted
list, owner-scoped revoke — B-20 stands as the keys finding); webhookVerify
enforcement complete (raw-body → verify → parse, 5-min skew, multi-secret,
fail-closed; vote callbacks per-site keys; Discord `verifyKey`); no
unintentionally-unauthenticated route (mixed/public surface deliberate per
comments); `secureHeaders()` defaults (HSTS/nosniff/SAMEORIGIN/CORP/COOP, no CSP
— acceptable for JSON API); CORS fails closed for direct-browser callers;
log contexts carry IDs only; `wrangler.jsonc` remaining vars non-secret;
`worker.ts` exports fetch+scheduled only (cron per-leg isolated; ticket-sweep
bare await ugly-but-not-crash-capable — declined); `migrate-tables.cjs` no
destructive statements (second password copy + `ssl.rejectUnauthorized:false`
already flagged/noted).
**NOT covered:** `rebuild-currency-balances.cjs`, `migrate-bot-tables.cjs`;
expansion `economy/legions/seasons/leaderboards/publicProfiles/memberRoles/
aiGallery/cache` + SSE internals beyond R4 (spot-checked); v2 `index/openapi`
wiring; live traffic (secrets, TLS, preflight, bot internals).
