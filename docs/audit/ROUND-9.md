# Round 9 — Dependencies, config surface (backend)

Ninth strict pass over `imperium-backend`, at `d5d9913` (`master`).
Only code change since Round 1: `d5d9913` (B-09 fix, verified below).
This round screened dependencies for known CVEs, reviewed the full config
surface, and closed two slivers.

Rounds 1–8: `FINDINGS.md` (B-01…B-08), `ROUND-2.md` (B-09, B-10),
`ROUND-3.md` (B-11…B-17), `ROUND-4.md` (B-18…B-25), `ROUND-5.md` (B-26…B-34),
`ROUND-6.md` (B-35…B-42), `ROUND-7.md` (B-43…B-50), `ROUND-8.md` (B-51…B-54).
This file: **B-55, B-56 + verdicts**.

| ID | Sev | Finding |
|---|---|---|
| B-55 | Medium | `getLeaderboardPage` playtime fallback joins `player_names` to itself — tautology fans out rows |
| B-56 | Low | No `observability` block — cron reports only via `console.*`, nothing pages on queue death |

---

## B-55 · Medium · Self-join tautology in playtime fallback

`src/db/pool.ts:1235-1238` (`ON pl.uuid = pl.uuid` — always true) vs the
correct form twice in the same file (`:677-679`, `:1084`:
`ON pl.uuid = pn.uuid`). Every playtime row fans out against near-all name
rows in the Postgres fallback path; page contents + `nextCursor` garbage.
Masked today (game-MySQL usually wins; `gameQuery` swallows fallback errors
per B-11) — bites exactly when the fallback is needed.

**Fix:** `ON pl.uuid = pn.uuid` + fallback-path unit test (2 players, row count).

## B-56 · Low · Cron has no paging path

`wrangler.jsonc` (full file) has no `observability`/logpush; `worker.ts:122-133`
ends the scheduled pass in `console.log`/`console.error` with no webhook leg,
though `STAFF_ALERT_WEBHOOK_URL` exists for app errors. The cron owns
money-adjacent delivery (webhook drain ≤20 POSTs, tailer, sweep, audit,
rollup). A sick Hyperdrive (cf. the 08-29 pool rebuild) fails silently to
anyone not tailing logs.

**Fix:** enable `observability` (+ log-based alert); route cron-report failures
through the staff-alert path.

---

## Dependency verdicts: zero confirmed-applicable vulns

`npm audit --omit=dev` unrunnable here (no node in shell) — manual websearch
verification per lib, pinned versions from `package-lock.json`: hono 4.13.5 ==
patched (3 advisories fixed IN it; Workers-exempt anyway); discord-interactions
4.4.0 clean; no Upstash/drizzle in tree (bespoke sockets + raw pg —
premise N/A); jose 6.2.10 clean (disputed 6.0.10 claim only; usage HS256 +
fail-closed ≥32 secret); zod 3.25.76 clean; pg 8.23.0 no HIGH/CRITICAL
confirmed; mysql2 3.24.2 postdates all fixes (Node-dev/pool + one-shot only);
cookie 1.1.1 includes fix; nanoid 5.1.16 == fixed release (callers use secure
fixed-size anyway); undici 8.9.0 == patched (keep the override); dotenv,
hono-node-server, zod-validator, discord-api-types clean. Tree notably
well-pinned (hono/undici/nanoid sit exactly on security-fix releases).

## Config review: clean (no new live values)

`wrangler.jsonc` (91 lines): vars hold only public values (URLs, client/store
IDs, Ed25519 pubkey, ports, flags); sole live secret remains the Hyperdrive
password (C1, re-added on the 08-29 rebuild); least-privilege bindings (no
Queues — D1+cron by design); `* * * * *` capped (≤20 POSTs, isolated legs);
`nodejs_compat`, compat date, absent `routes` (documented CNAME reasoning) all
sane. Gap → B-56 only. `env.ts` fail-closed defaults verified (JWT ≥32,
BOT/PAYNOW required in prod, empty vote-keys → 404, TRUST_PROXY false,
bridge/alerts empty → disabled). `.gitignore` covers every secret filename
referenced in code (`.env`, `.dev.vars*`); only secret-file read is `.env`.
`migrate-tables.cjs` (2nd password copy = C1), `rebuild-currency-balances.cjs`
(B-35) — known, not refiled.

## Fix verification: B-09 FIXED by `d5d9913` (exemplary)

Cancel-path failures now 500 (unresolvable-customer + cancel-write throw;
upsert idempotent so retries safe); activation/renewal deliberately stay 200
(correct asymmetry — those recur and self-heal); `MAX_CACHE_AGE` 45 d via the
previously-unread `updated_at` (`isSubscriptionCacheStale`, fail-stale on
null/unparseable); read path falls through to live PayNow when stale.
Message matches diff exactly; 4 tests claimed fail-pre/pass-post, suite
324/324, tsc clean (claimed, not re-run here). B-09 is CLOSED — first audit
finding verified fixed. (No reconciliation job — staleness fall-through covers
the requirement differently; acceptable.)

## Coverage notes

PayNow/Aureus sliver: `src/services/paynow.ts` does NOT exist (only the D1
migration + `src/paynow/{client,constants,webhookVerify}.ts`) — bC16/bC19
remediation targets on the old path are stale; live code has donor-only
calls + 14 product IDs; Aureus is internal-webshop (plugin-side grant,
backend enqueues signed `web_queue`). Plugin dispatcher gap is C-19. `db/*`
TLS notes documented tradeoffs; `redisSocket` honors `REDIS_TLS`; `sqlite`
read-only. `checkout.test.ts` inline copies match `constants.ts` today (drift
hazard already B-47). NOT covered: `npm audit` proper (no node); `pg` CVE
lookup (search 429s); full test sweep; cross-repo seams; live verification.
