# Round 10 — Fix verification 2 + new findings (backend)

Tenth strict pass over `imperium-backend`, at `f52e1cb` (`master`).
Code changes since Round 9: `8d47be7` (fulfillment), `71d2d0a` (referral).
This file: **B-57…B-59** + fix verdicts + complaint accuracy + test status.

Rounds 1–9: `FINDINGS.md` (B-01…B-08), `ROUND-2.md` (B-09, B-10),
`ROUND-3.md` (B-11…B-17), `ROUND-4.md` (B-18…B-25), `ROUND-5.md` (B-26…B-34),
`ROUND-6.md` (B-35…B-42), `ROUND-7.md` (B-43…B-50), `ROUND-8.md` (B-51…B-54),
`ROUND-9.md` (B-55, B-56). This file: **B-57…B-59**.

| ID | Sev | Finding |
|---|---|---|
| B-57 | Medium | Fulfillment `lineKey` collides for duplicate lines — second identical line silently skipped |
| B-58 | Medium | Referral one-per-lifetime is check-then-insert; backstop fails on legacy dupes |
| B-59 | Low | Empty order (`lines: []`) fulfills as `ok` with `dispatched:0` |

---

## B-57 · Medium · Duplicate cart lines silently dropped (with C26: no way to buy 2 of anything)

`fulfillment.ts:315` (`order_id,line_key` with `lineKey =
productId:quantity:targetUuid`, no line index): two identical lines claim the
same key; the second `claimOrderLine` sees `changes=0` → `skippedDuplicate`,
never dispatched. Combined with C26 (quantity ignored) there is **no correct
way to buy 2 of the same thing today**.

**Fix:** `lineKey` with line index (or full-line-JSON hash) + regression test
(two identical lines → `dispatched:2`).

## B-58 · Medium · One-per-lifetime guard is app-level until the backstop lands

`routes.ts:2711` (`SELECT … WHERE redeemer_uuid=$1`) then `:2720-2728` CTE
insert — no transaction, no `ON CONFLICT DO NOTHING`. The
`UNIQUE(redeemer_uuid)` in `migrate-tables.cjs:154` is `IF NOT EXISTS` **and**
fails on already-farmed legacy dupes (comment admits it): on a farmed DB the
guard stays app-level-only and concurrent redeems both pass and both insert.

**Fix:** make the insert the guard (`INSERT … ON CONFLICT (redeemer_uuid) DO
NOTHING RETURNING`, 400 on `rowCount=0`); dedupe legacy rows (keep earliest),
re-run migration; concurrent-redeem test.

## B-59 · Low · Empty orders fulfill as `ok`

`fulfillment.ts:293-348`: no `lines.length===0` guard; unknown-only/empty
orders return `{ok, dispatched:0}` → webhook `200` — PayNow treats a possibly
malformed order as delivered.

**Fix:** `lines.length===0` → error (500/alert) so malformed OrderDTOs surface.

---

## Fix verdicts

- **`8d47be7` (B-C16+B-C19 fulfillment) — PARTIAL.** Message matches diff (new
  `fulfillment.ts` 349 lines + webhook case + `getPaynowCustomer` + D1
  migration + 377-line tests, no scope creep). Event names: all three spellings
  normalize (`ON_ORDER_COMPLETED`/`OnOrderCompleted`/`order.completed` ✓);
  `body` vs `data` dual-read correct. Buyer resolution real (embedded →
  mapping → Management API + cache-back); dispatch signed with 6 s bound;
  unresolvable/gift-failures → 500 (correct asymmetry); unknown products skip
  with 200 (correct); idempotency two-layered (D1 claim + `PurchaseRegistry`
  on `transaction_id`). Tests exist and pin the right shapes (20 order + 7 B-09
  tests; mock boundaries sound). **Gaps: C26** (quantity parsed/clamped/baked
  into `lineKey` but never into the dispatched amount — 3× pack under-delivers
  3×) **+ B-57** above. Caveats: `STORE_PURCHASE_AUREUS` vs C16's
  `CRAFTINGSTORE_PURCHASE` naming + `CRATE_KEY_PRODUCTS` empty map (crate half
  not deliverable today) + tier-case pinned-but-unverified — cross-repo checks
  needed plugin-side.
- **`71d2d0a` (B-C18 referral) — PARTIAL, honest.** One-per-lifetime (query +
  message + DB backstop), deliberately no IP/playtime guards — rationale
  correct at this layer (`X-Mc-Uuid` under shared token; `cf-connecting-ip` is
  the server). bC18 limb 1 (multi-code) FIXED; limbs 2 (sybil alts) + 3 (instant
  payout, no Rank-V check) OPEN; tests assert the right things (fail pre-fix).
  Plus B-58 above.

## Complaint accuracy (C25–28)

- **C25 (storeAuth guest block) — ACCURATE, extends C20** (different branch:
  C20 = 401/403 session path; C25 = 400 bot path, never reads
  `body.guestUsername`). Keep.
- **C26 (quantity dropped) — ACCURATE, regression from `8d47be7`**, no prior
  B-ID. Keep (drives B-57's pairing).
- **C27 (mysqlWire `?`/escaping) — DUPLICATE of C2** (verbatim; ROUND-3 already
  re-verified NOT FIXED latent). Fix once.
- **C28 (sub fallback) — DUPLICATE of C23** (same missing-fallback root; only
  new bit is "`resolveCustomerUuid` exists but unwired to subs"). Note: "cancel
  500 retries indefinitely" framing overstates — that 500 is the intended B-09
  design (idempotent upsert beats strand-active-forever).

## Test status: NOT runnable here (deps absent — do not mistake for green)

Node exists (`v24.16.0`) but not in `PATH`; `node_modules/.bin` has
`tsc/tsx/wrangler` but **no `vitest`** (`node_modules/vitest` absent) so suites
cannot execute; `tsc --noEmit` yields 69× environmental errors (`Cannot find
module 'vitest'`, `mysql2/promise`) — zero point at fulfillment/routes logic,
but commit-claimed "317/317" + "324/324" + "tsc clean" are **unverifiable in
this checkout, not disproven**. Run `npm install` (restores dev deps) or
trust CI; prepend `C:\Program Files\nodejs` to PATH first.

## Coverage notes

Read: B-01…B-56 dispositions, C14…C28 texts, both fix diffs, live webhook/
storeAuth/cart/redeem sections, `fulfillment.ts`, `constants.ts` (B-C17 fix
present: 10 packs + 6 upgrades + `isOneTimeStoreProduct`), `mysqlWire.ts`,
`pool.ts:260-307`, `migrate-tables.cjs`, both new test files. NOT covered:
live PayNow payload shapes; plugin handler contract (tier-case, crate quantity);
frontend guest-header claim; `npm audit`/CVE re-check; suite execution
(blocked); B-09 reconciliation-job question (staleness fall-through accepted).
