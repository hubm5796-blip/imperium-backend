# imperium-backend — Audit, 2026-09-05

Part of a cross-repo strict audit of the three ImperiumMC codebases.

**Audited at:** `eba7716` (`master`)

## In this directory

| File | Contents |
|---|---|
| [`FINDINGS.md`](FINDINGS.md) | B-01 … B-08, this repo's findings |
| [`ROUND-3.md`](ROUND-3.md) | P-13 … P-19 (plugin mirror) + B-11 … B-17, this repo's findings + re-verification |
| [`ROUND-4.md`](ROUND-4.md) | B-18 … B-25 (v2/expansion, bot, paynow, scopes, SSE, limiter) + C8…C13 dedupe |
| [`ROUND-5.md`](ROUND-5.md) | B-26 … B-34 (routes remainder, deploy surface, trust boundaries) + C14…C15 dedupe |
| [`ROUND-6.md`](ROUND-6.md) | B-35 … B-42 (scripts, expansion, cron, Discord, wiring, sweep) |
| [`CROSS-REPO.md`](CROSS-REPO.md) | X-01 … X-04, the seams with the plugin and frontend |

The full audit — executive summary, plugin and frontend findings, methodology,
and the GLM handoff prompt — lives in the plugin repo at
`ImperiumMC-Plugin/docs/audit/`.

## The one that matters

**B-01 (Critical): the staff role gates do not restrict anything.**
`staffActorHasRole` returns `true` unconditionally for the actor
`'panel-service'` (`src/api/routes.ts:198`), and `resolveStaffActor` resolves
*any* unmapped bot token to exactly that name (`:191`). So a caller presenting
only `X-Bot-Token` satisfies every role gate — punish, broadcast, and live
config reload.

The privilege model is also inverted: presenting valid staff credentials grants
*less* access than presenting none. And per X-04, the frontend never sends the
staff headers at all, so this is not a dormant code path — it is the only path
in production.

Fix B-01 and X-04 together, X-04 first. See `FINDINGS.md` for why.

## Round 3

A third pass ([`ROUND-3.md`](ROUND-3.md)) mirrored the plugin P-13 … P-19 here
and appended this repo's own depth pass: **B-11 … B-17** (game-MySQL pool,
tickets, checkout, bot bridge) + re-verification. Headliners: B-11 (the pool
swallows every DB failure into `[]`), B-12 (tickets readable/answerable by any
player), B-13 (`X-Mc-Uuid` accepted on ~15 routes). B-01/B-02/B-03 still
present; the plaintext DB password is still in `wrangler.jsonc` (plus a second
copy in `migrate-tables.cjs`). The ordered fix queue for all rounds lives in
the plugin repo at `ImperiumMC-Plugin/docs/audit/09-FIX-PROMPT-GLM-5.3-FLASH.md`.

## Round 4

A fourth pass ([`ROUND-4.md`](ROUND-4.md)) covered the v2/expansion remainder,
the bot, the PayNow client, API-key scopes, the SSE stream, and the limiter:
**B-18 … B-25**, with dedupe against the concurrent C8…C13 (bC11≈B-17, same
defect — fix once). Headliners: B-19 (admin reads are shared-token-only),
B-20 (`requireScope` has zero consumers), B-25 (the limiter reintroduces the
exact in-memory shape its own doc says was fixed).

## Round 6

A sixth pass ([`ROUND-6.md`](ROUND-6.md)) covered the one-shot scripts, the
expansion remainder, cron legs, Discord-side commands, v2 wiring, and a
last-chance routes sweep: **B-35 … B-42**. Headliners: B-35 (third password
copy + live MySQL password in a one-shot script), B-36 (rebuild wipes balances
with no guard), B-39 (cron legs duplicate/skip without overlap guards).

## Round 5

A fifth pass ([`ROUND-5.md`](ROUND-5.md)) covered the routes remainder, the
deploy surface, and trust boundaries: **B-26 … B-34**, with dedupe against
C14…C15 (bC14 extends B-16's enum prescription to v1-respond; bC15 companions
B-10 on a different protocol). Headliners: B-26 (webcode rate bucket keyed on
spoofable header), B-29 (v1 admin reads skip staff gates), B-30 (referral
eligibility check doesn't exist — designated standing-rule violation).

## State at time of audit

- `tsc --noEmit` — clean
- `vitest run` — 16 files, 143 tests, 143 passed
- No hardcoded secrets, no SQL injection found

The findings are about logic that compiles and passes its tests but does not do
what its own comments say it does.
