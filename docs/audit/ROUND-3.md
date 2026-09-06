# Round 3 — Findings

Third pass, covering the remaining uncovered areas: database migrations, the
currency persistence layer, crates, the auction house, and the async anticheat
engine.

Same commits as rounds 1 and 2: plugin `234f89b`, backend `eba7716`, frontend
`8fccb2a`.

**This round corrects a round-1 finding.** P-04 ("currency is a `Double`") was
right about the symptom and wrong about the shape of the problem. See P-13,
which supersedes it.

| ID | Sev | Repo | Finding |
|---|---|---|---|
| P-13 | High | plugin | `Double` API over integer storage; every value is rounded at the DB boundary |
| P-14 | High | plugin | Migration V28 irreversibly divided 5 tables by 100, rewriting audit history |
| P-15 | Medium | plugin | The crate "Luck Permissions" feature is mathematically a no-op |
| P-16 | Medium | plugin | Auction buy-now debits outside the deciding transaction; refund is fire-and-forget |
| P-17 | Medium | plugin | Anticheat VL accumulation is a non-atomic read-modify-write from async threads |
| P-18 | Low | plugin | Crate rewards drawn from a predictable 48-bit LCG |
| P-19 | Low | plugin | Money column type varies by install age; a dead balance table is still maintained |
| B-11 | High | backend | `gameQuery` swallows every DB failure into `[]` — outages render as "no data" |
| B-12 | High | backend | `GET /api/tickets` returns *all* tickets to *any* player; `POST respond` lets any player answer as staff |
| B-13 | High | backend | ~15 v1 routes accept arbitrary `X-Mc-Uuid` under the shared bot token |
| B-14 | Medium | backend | `POST /api/store/checkout` passes client `productId` + `subscription` flag with no allowlist |
| B-15 | Medium | backend | Guide vote score spans 4 non-atomic statements vs the "same statement" comment |
| B-16 | Medium | backend | v2 ticket PATCH accepts arbitrary `status`/`priority`/`satisfaction`; note author defaults to `'staff'` |
| B-17 | Low | backend | Bridge Bearer compare skips the length guard → 500 + staff alert instead of 401 |

---

## P-13 · High · A `Double` API over integer storage, rounded at every DB boundary

**Supersedes P-04.** Round 1 reported "currency is a `Double`" from
`CurrencyManager`'s signatures. That is true in memory, but the storage layer is
integer, and the mismatch between them is the actual defect.

**Evidence:** `src/main/java/net/imperiummc/managers/CurrencyManager.kt:1121-1123`

```kotlin
private fun toMinorUnits(amount: Double): Long = (amount * MINOR_UNITS_PER_UNIT).roundToLong().coerceAtLeast(0L)
private fun fromMinorUnits(minor: Long): Double = minor / MINOR_UNITS_PER_UNIT.toDouble()
```

and `:1551`:

```kotlin
private const val MINOR_UNITS_PER_UNIT = 1.0
```

With the constant at `1.0`, `toMinorUnits` reduces to
`amount.roundToLong().coerceAtLeast(0L)`. The schema confirms the target
(`CurrencyManager.kt:103`, `SchemaInitializer.kt:27`):

```kotlin
column("balance BIGINT NOT NULL DEFAULT 0 CHECK(balance >= 0)")
// "balance is BIGINT WHOLE units (whole-unit storage since migration V28 …)"
```

So the public API accepts and returns fractional `Double` values, the cache
holds fractional `Double` values, and the database stores whole `BIGINT` units.
Every crossing rounds. Four consequences:

1. **All fractional currency is destroyed on persist, silently.** A cached
   balance of `1234.75` writes as `1235` and reads back as `1235.0`. The
   player's balance changes at save/load time with no error, no log, and no
   transaction.

2. **Sub-unit amounts round to zero or one — in both directions.** A payout of
   `0.4` persists as `0` (credit lost). A payout of `0.5` persists as `1` (money
   created). Across mining payouts with multipliers, boosters and enchant procs,
   this is systematic bidirectional drift, not a rounding nit.

3. **`coerceAtLeast(0L)` hides constraint violations.** The column already
   declares `CHECK(balance >= 0)`. Clamping in application code means a negative
   value — which should be a loud failure, since balances "cannot go negative"
   per `CLAUDE.md` — is silently written as `0` instead of raising. The clamp
   converts a detectable bug into permanent data loss.

4. **The audit trail is rounded with the same function**, so it cannot detect
   the drift it records. `:1422-1423` writes
   `toMinorUnits(tx.amount)` and `toMinorUnits(tx.newBalance)` into
   `currency_transactions`. The ledger therefore agrees with the corrupted
   balance, and reconciliation comparing the two will always find them
   consistent.

The names are now actively misleading. `toMinorUnits` does not convert to minor
units; it rounds. The comment at `:1546-1550` acknowledges this — "the helper
names survive as the DB-boundary rounding points only" — but every one of the
call sites reads as a unit conversion.

**Fix direction:** make the API integral end-to-end. `CurrencyManager`'s public
methods should take and return `Long` whole units, so the rounding decision
moves to the *callers* that actually produce fractional values (multipliers,
percentage taxes, prorated refunds) where it can be made explicitly and
consistently — round-half-even, or accumulate a remainder. Until then, at
minimum: rename the helpers to `roundToStorage`/`fromStorage`, and replace
`coerceAtLeast(0L)` with a thrown error, so the class of bug in (3) surfaces.

---

## P-14 · High · Migration V28 irreversibly divided five tables by 100, including audit history

**Evidence:** `src/main/java/net/imperiummc/database/DatabaseManager.kt`,
`applyMigrationV28`

```kotlin
val conversions = listOf(
   Triple("currency_balances",      "balance = ROUND(balance / 100.0)", "balance"),
   Triple("economy_transactions",   "amount = ROUND(amount / 100.0), balance_after = ROUND(balance_after / 100.0)", …),
   Triple("currency_transactions",  "amount = ROUND(amount / 100.0), new_balance = ROUND(new_balance / 100.0)", …),
   Triple("economy_logs",           "amount = ROUND(amount / 100.0), balance_before = ROUND(balance_before / 100.0), balance_after = ROUND(balance_after / 100.0)", …),
   Triple("player_balances",        "balance = ROUND(balance / 100.0)", "balance"),
)
…
val sql = "UPDATE $table SET $assignments"
```

An unconditional, lossy, irreversible `UPDATE` across every row of five tables.
Concerns, in order of severity:

**It rewrote the audit tables.** `economy_transactions`, `currency_transactions`
and `economy_logs` are the economic audit trail — the record of what actually
happened. This migration edited them in place. After V28 those tables no longer
describe the transactions that occurred; they describe those transactions
divided by 100 and rounded. An audit log that is retroactively editable to match
a new representation is not an audit log. If a dispute or a rollback ever needs
pre-V28 history, it no longer exists in the database.

**It is lossy with no verification.** `ROUND(x / 100.0)` discards the low two
digits. A balance of `1250` (12.50) becomes `13`. There is no pre-check that the
data is in fact in minor units, no row-level before/after capture, no computed
checksum of total money before and after, and no way to reverse it. The
migration logs a warning telling the operator to take a backup *as it runs* —
after which it is already too late.

**The guard is the schema-version marker alone.** If `insertSchemaVersion` were
ever to fail, or a database were restored from a backup taken before the version
row but after the UPDATE, the migration would run again and divide by 100 a
second time. The blast radius of a re-run is the entire economy.

To be fair to it: the migration is correctly wrapped in `executeWrite` (so it is
transactional), it skips absent tables, and it logs loudly. The problem is not
the mechanics — it is that a destructive one-way transform of financial and
audit data was performed with no captured evidence of the before state.

**Fix direction:** nothing can undo this now. Going forward: destructive value
migrations on money or audit tables should write the pre-migration values to a
retained shadow table (`economy_transactions_pre_v28`) rather than editing in
place, and should log a total-sum checksum before and after so the conversion is
verifiable after the fact. If a pre-V28 backup still exists, preserve it
deliberately — it is the only remaining copy of the real transaction history.

---

## P-15 · Medium · The crate "Luck Permissions" feature is mathematically a no-op

**Evidence:** `src/main/java/net/imperiummc/economy/CrateService.kt:2738-2749`

```kotlin
private fun weightedRandomWithLuck(pool: List<CrateReward>?, multiplier: Double): CrateReward? {
   if (pool.isNullOrEmpty()) return null
   if (multiplier <= 0.0) return weightedRandom(pool)
   val total = pool.stream().mapToDouble { it.chance() * multiplier }.sum()
   val roll = random.nextDouble() * total
   var cumulative = 0.0
   for (r in pool) {
      cumulative += r.chance() * multiplier
      if (roll <= cumulative) return r
   }
   return pool[pool.size - 1]
}
```

The doc comment above it states the intent:

> every reward's chance is scaled by `[multiplier]` BEFORE the cumulative roll,
> so a player holding a luck node sees proportionally higher odds for every
> reward

Scaling *every* weight by the same constant does not change a weighted
distribution. Writing `m` for the multiplier and `c_i` for each chance:

- `total = Σ(c_i · m) = m · Σc_i`
- `roll = rand() · m · Σc_i`
- `cumulative_k = m · Σ_{i≤k} c_i`
- so `roll ≤ cumulative_k` ⟺ `rand() · Σc_i ≤ Σ_{i≤k} c_i`

The `m` cancels exactly. **`weightedRandomWithLuck(pool, m)` returns the
identical distribution as `weightedRandom(pool)` for every `m > 0`.** The
parenthetical in the comment — "(1.0 = identical to weightedRandom)" — is
correct but understated: *all* values are identical to `weightedRandom`.

The feature is wired into the live roll path
(`:3781-3782` in `rollWithPity`), `luckMultiplier` resolves permission priority
correctly, and there are **no tests** for either function.

Current impact is latent: the shipped `crates.yml` defines no luck permissions,
so nothing exercises it today. It becomes a live problem the moment a crate is
configured with them — and since "luck permissions" in this genre are normally
attached to donor ranks or sold directly, the likely first use is a paid perk
that does nothing. That is the reason this is Medium rather than Low.

**Fix direction:** a uniform multiplier cannot express "better luck". Decide what
the feature means and implement that — e.g. scale only rewards above a rarity
threshold, or apply an exponent (`c_i ^ (1/m)`) which shifts mass toward rarer
outcomes. Then add a test asserting the distribution actually shifts: draw N
samples at `m = 1` and `m = 2` and assert the rare-reward frequency differs.
That test would have caught this immediately.

---

## P-16 · Medium · Auction buy-now debits the buyer outside the transaction that decides the sale

**Evidence:** `src/main/java/net/imperiummc/economy/AuctionService.kt:477-505`

The ordering is: debit the buyer, then run the compare-and-swap that decides
who actually won.

```kotlin
val withdrawn = economy.withdraw(buyer, row.currency, price, "auction:buy_now:$listingId").join()
…
conn.prepareStatement("UPDATE auction_listings SET status = 'SOLD_BUY_NOW' WHERE id = ? AND status = 'ACTIVE'")
…
if (soldUpdated == 0) {
   // Lost the CAS race against a concurrent buyer — the wallet debit commits on
   // a separate connection, so refund it explicitly.
   conn.rollback()
   economy.deposit(buyer, row.currency, price, "auction:buy_now_refund_cas:$listingId")
      .thenAccept { r ->
         if (!r) {
            plugin.getLogger().severe("[AuctionService] CRITICAL: CAS-loss buy-now refund FAILED for ${buyer.uniqueId} — $price ${row.currency.name} lost. Manual intervention required.")
         }
      }
```

Much of this file is careful — the CAS-before-claim-rows ordering is deliberate
and documented, and the subsequent re-read of the bid columns to avoid
double-refunding a stale bidder is a genuinely subtle fix done right. The defect
is narrower than "this code is wrong":

1. **The debit is not in the deciding transaction.** As the comment states, the
   wallet commits on a separate connection, so `conn.rollback()` does not undo
   it. Correctness depends on a compensating deposit rather than a rollback.

2. **The compensating refund is fire-and-forget.** `.thenAccept { }` is not
   awaited; `supplyAsync` returns `false` immediately. If the JVM stops in that
   window, the refund never runs and nothing anywhere records that it was owed.

3. **Its failure path is a log line.** The code correctly identifies the outcome
   — money lost, manual intervention required — and then does nothing further.
   There is no retry, no pending-refund row, no dead-letter queue. Remediation
   depends on someone reading `SEVERE` logs and reconstructing the amount.

4. **Every loser pays this risk.** Because the debit precedes the CAS, N
   concurrent buyers all debit and N−1 take the compensating path. Contention —
   exactly when a desirable listing is posted — maximises the number of
   compensating refunds, and each is an independent chance to lose money.

Note the interaction with P-11: `EconomyReconciliationJob` is one of the systems
that commit `68b2065` disabled, and it does not scan for failed compensating
refunds in any case (`grep -n "refund|orphan|compensat"` returns nothing). So
there is no backstop.

**Fix direction:** run the CAS first — it is a single cheap atomic UPDATE — and
debit only the winner. That removes the compensating path for every loser and
leaves at most one debit to reconcile. Where a compensating transaction is
genuinely unavoidable, write a `pending_refunds` row inside the same transaction
that fails, so a retry job can drain it.

---

## P-17 · Medium · Anticheat violation accumulation is a non-atomic read-modify-write

**Evidence:** `src/main/java/net/imperiummc/admin/async/AlertQueue.kt:179-184`

```kotlin
val oldVl = violationLevels.getOrDefault(uuid, 0.0)
var newVl = oldVl
if (allowAccum && oldVl >= 0.0) {
   newVl = oldVl + adjustedSeverity
   violationLevels[uuid] = newVl
```

`violationLevels` is a `ConcurrentHashMap`, but this is a read, then a compute,
then an unconditional overwrite — three separate operations with no atomicity
between them. The map being concurrent prevents corruption; it does not prevent
a lost update.

This matters here specifically because `AlertQueue` is the convergence point for
the *async* check pipeline. `admin/async/` runs its checks off the main thread
(`AsyncAntiCheatEngine`, `MovementSimulator`, and the Movement / Criticals /
Elytra / FastBreak / NoClip / NoSlow / Timer modules), and `CLAUDE.md` names
`AlertQueue.logViolation` as the single funnel every one of them uses. Two
checks flagging the same player concurrently will interleave, and one increment
is silently discarded.

The loss is biased toward the worst moment: concurrent flags on one player are
most likely during a burst — which is precisely when a real cheater is being
detected and when VL should be crossing a threshold. A player can therefore sit
below `AUTO_BAN_VL` because increments were dropped, and nothing indicates it
happened.

Two things this is *not*, having checked:

- The `-9999.0` instant-ban sentinel is handled correctly by the decay pass
  (`:477-481` preserves `vl < 0.0` and clamps the normal path at
  `maxOf(0.0, …)`), so decay cannot manufacture a false sentinel.
- The 1500 ms per-check accumulation throttle is intentional and per-check, not
  a bug.

**Fix direction:** one atomic operation —
`violationLevels.merge(uuid, adjustedSeverity) { old, add -> if (old < 0.0) old else old + add }`
— and read the result for the threshold comparison, rather than reading and
writing separately.

---

## P-18 · Low · Crate rewards are drawn from a predictable 48-bit LCG

**Evidence:** `src/main/java/net/imperiummc/economy/CrateService.kt:56`

```kotlin
private val random = Random()
```

`java.util.Random` is a 48-bit linear congruential generator. Its internal state
is recoverable from a small number of consecutive observed outputs, after which
all future values are predictable. It is documented as unsuitable for any
security-sensitive purpose.

Crate rolls decide the distribution of items with real economic value, and on a
prison server with a store, plausibly real monetary value. A player who can
observe enough outcomes to recover the seed can predict future rolls and time
crate opens to land rare rewards. This is a known and previously-exploited
pattern on Minecraft servers, which is why it is filed rather than dismissed.

Severity is Low rather than higher because the attack needs many observed
outputs from *this specific generator*, the generator is shared across all
players (so an attacker's observations are interleaved with everyone else's
draws, which materially frustrates state recovery), and pity/weighting layers sit
on top.

**Fix direction:** `java.security.SecureRandom`, or at minimum
`ThreadLocalRandom` (a 64-bit generator, and it also removes the shared-instance
contention). The cost is negligible at crate-open frequency — this is not a hot
path.

---

## P-19 · Low · Money column type varies by install age; a dead balance table is still maintained

Two related schema-hygiene problems.

**The authoritative money column has two possible types.** `CurrencyManager`'s
`SchemaBuilder` declares `balance BIGINT` (`:103`), but older installs were
created by `DatabaseManager` with `balance DECIMAL(20,2)` (`:200`, `:607`,
`:832`), and `CREATE TABLE IF NOT EXISTS` will not change an existing column's
type. The codebase already knows this — `PrivacyTableRegistry.kt:126` notes:

> "money keep: CurrencyManager live balances (**DB may also carry DECIMAL
> variant**)"

Every read is `rs.getLong("balance")` (`:273`, `:413`, `:765`, `:932`). Against a
`DECIMAL(20,2)` column holding a fractional value, `getLong` truncates. So the
same code silently behaves differently depending on how old the database is, and
which behaviour you get is not visible from the source. **This needs checking
against the live database** — the audit could not determine which variant
production runs.

**`player_balances` is dead but still maintained.** `ImperiumAdminCommand.kt:211-213`
records that it is legacy:

> read the LIVE `currency_balances` table … the legacy `player_balances` table,
> **which no gameplay code writes**

Yet it is still created on every fresh install (`SchemaInitializer.kt:32`), was
still targeted by the destructive V28 conversion (P-14), and is still registered
for GDPR anonymisation (`PrivacyTableRegistry.kt:106`). A table that nothing
writes but that three subsystems still service is a reliable source of future
confusion — and it means a GDPR export can return stale balances that contradict
the live ones.

**Fix direction:** determine the live column type and, if it is `DECIMAL(20,2)`,
add a migration that converts it to `BIGINT` explicitly so both fleets agree.
Separately, drop `player_balances` — remove the `CREATE TABLE`, remove it from
`PrivacyTableRegistry`, and archive whatever it still holds.

---

## Verified good this round

- **Migration runner integrity.** All 28 `applyMigrationV*` functions are defined
  and all 28 are called from `runMigrations()` with matching version guards — no
  gaps, no unreachable migrations. Each writes its own `insertSchemaVersion`
  inside its own `executeWrite`, so a mid-sequence failure leaves a coherent
  version rather than a partial one.
- **`safeExec`'s per-statement savepoints** (`DatabaseManager.kt:122-134`)
  correctly handle the PostgreSQL "any error aborts the transaction" behaviour,
  and the comment explaining why is accurate.
- **Auction concurrency control is genuinely good.** Conditional updates guarded
  on prior state (`WHERE id = ? AND current_bid = ? AND status = 'ACTIVE'`) are
  the right compare-and-swap pattern, and the post-CAS re-read of bid columns to
  refund the *fresh* high bidder rather than the stale one is a subtle race
  handled correctly. P-16 is about where the debit sits, not about the CAS.
- **The key-escrow ordering is correct** (`AuctionService.kt:581-622`): keys are
  removed from the seller via an atomic `compute` CAS *before* the listing row is
  inserted, so a crash between the two can neither lose nor duplicate keys. The
  reasoning is documented at the site.
- **VL decay handles the instant-ban sentinel correctly** (see P-17).
- **`weightedRandom` itself is correct** — it sums actual weights rather than
  assuming they total 1.0, and falls back to the last element to cover
  floating-point shortfall.

---

## Addendum — backend depth pass (B-11…B-17 + re-verification)

Second Round-3 sweep (HEAD `598daa6`, code-identical to the heads above):
the game-MySQL pool, tickets, v2 routes, checkout siblings, the bot bridge —
plus line-level re-verification of B-01/B-02/B-03/B-06 and every Round-1
backend complaint. No overlaps with B-01…B-10.

## B-11 · High · `gameQuery` swallows every DB failure into `[]`

**Evidence:** `src/db/gameMysql.ts:130-154` (`return [];` at `:152` on every
outage), `src/api/routes.ts:1652-1665` (`dbReadOrNull` → null,
`dbWriteBestEffort` fire-and-forget), `src/db/pool.ts:636-638` (empty catch →
stale Postgres mirror with no `available:false` flag). Callers treat empty as a
valid answer: `GET /store/subscription` serves `subscription: null` (`:1689-1696`),
the leaderboard serves a frozen mirror, and the cancel route returns `{ok:true}`
at `:1789` while its cache write (`:1784-1787`) is still in flight — a failed
write leaves `status:'active'` in D1 permanently (B-09's exact shape, new
instance). The swallow even masks this repo's own bugs: `getGamePlayerLegionId`
queries `legion_members WHERE uuid = ?` (`gameMysql.ts:299-304`) while the
Postgres fallback queries `WHERE player_uuid = $1` (`pool.ts:1061-1064`), and
`getGameLegionMembers` selects `uuid, rank, contribution` (`:315-320`) vs
`player_uuid, role` (`pool.ts:1081-1088`) — if the game schema matches the
Postgres names, the game path errors on every call and nobody can tell.

**Fix:** make `gameQuery` throw (or return `{ok, rows}`) and force each call site
to degrade explicitly with an `available:false`/staleness signal; `await` the
cancel-path cache write; reconcile the `legion_members` column names.

---

## B-12 · High · Tickets: any player reads all, answers any as staff

**Evidence:** `src/api/routes.ts:2229-2255` — the comment promises a staff gate
that does not exist (`api.get('/tickets', botAuthMiddleware, …)` reads
`X-Mc-Uuid` for presence only, then selects with no uuid filter and no role
check). `POST /tickets/:id/respond` (`:2274-2289`) writes `staff_response` /
`responded_by` / `status` for any caller, with `status` free-form
(`body.status ?? 'responded'`) — arbitrary strings the 48 h auto-close sweep
(`bot/cron.ts:143-162`) then acts on.

**Fix:** scope the list to `WHERE uuid = $n` unless the caller passes a real
staff gate (`staffActorHasRole(..., 'helper')`); gate `/respond` the same way;
allowlist `status`.

---

## B-13 · High · ~15 v1 routes accept arbitrary `X-Mc-Uuid` under the shared token

**Evidence:** `src/api/routes.ts:2206-2208` (representative — tickets, referrals,
marketplace, crates, legion reads): `botAuthMiddleware` (`:133-138`) checks only
`X-Bot-Token == BOT_API_TOKEN`, and the header is used directly as identity. The
`INTERNAL_SERVICE_TOKEN` split from `gates.ts` is not consulted on any of these
paths (B-04 non-adoption, now with teeth). Leak of the one widely-shared secret
lets an attacker act as *any* player — including checkouts billed against
another player's PayNow mapping.

**Fix:** require `safeEqual(botToken, env.internalServiceToken)` wherever
`X-Mc-Uuid` is accepted as identity (or migrate these routes to
`requireSelfOrDelegated`); apply UUID-shape validation everywhere meanwhile.

---

## B-14 · Medium · Checkout passes unvalidated `productId` + `subscription` flag

**Evidence:** `src/api/routes.ts:1835-1856` (presence-only check), mapped verbatim
to PayNow (`src/paynow/client.ts:142-147`, no validation). Every sibling
validates: preview-change (`:1880-1882`), change (`:1911`), gift (`:1966-1968`),
cart (`:2062-2067`). Callable outcome: hidden/test/foreign products purchasable,
type/flag mismatches → paid-but-undelivered orders and support load.

**Fix:** validate against `isDonorSubscriptionProduct() || isLifetimeProduct()`
and require the flag to match the product kind, mirroring the cart route.

---

## B-15 · Medium · Guide vote score is 4 non-atomic statements vs the "same statement" comment

**Evidence:** comment `src/api/v2/guides.ts:10-14` ("maintained on the same
statement as the vote insert (D1 serializes writes per database)") vs code at
`:146-161`: SELECT guide, SELECT existing vote, INSERT/UPDATE vote, then a
*separate* `UPDATE guides SET score = score + ?`. Concurrent votes interleave the
read-modify-write and lose updates, drifting `score` with no reconciliation.

**Fix:** vote + score change in one `batch()`, or recompute `score` from
`guide_votes`.

---

## B-16 · Medium · v2 ticket PATCH: arbitrary values, author defaults to `'staff'`

**Evidence:** `src/api/v2/tickets.ts:117-131` (columns allowlisted — good — but
values `String(v)` unvalidated), `:154` (any non-player/discord author recorded
as staff). Bot-token holders can close tickets to dodge the stale-sweep, invent
priorities, poison `satisfaction` analytics; unattributed notes land as staff
statements.

**Fix:** enum-validate `status`/`priority`/`satisfaction` (400 on unknown);
default unknown authors to `'discord'` or reject.

---

## B-17 · Low · Bridge Bearer compare skips the length guard (length oracle + alert spam)

**Evidence:** `src/bot/bridge.ts:169-174` (`timingSafeEqual` without the
length guard every other check has). Wrong-length secrets throw → generic 500 +
`alertError('unhandled', …)` staff ping (`app.ts:113-120`): unauthenticated
probers distinguish wrong-length (500) from wrong-bytes (401) and can spam staff
alerts at will.

**Fix:** copy the `a.length !== b.length → false` guard from `botTokenMatches`.

---

## Re-verification (all at `598daa6`, code-identical to round-1 head)

| Item | Verdict | Evidence |
|---|---|---|
| B-01 RBAC exemption | **STILL PRESENT** | `routes.ts:191-193`, `:196-199` byte-identical |
| B-02 unreachable delegated branch | **STILL PRESENT** | `gates.ts:71-82` |
| B-03 `:`-split + `===` | **STILL PRESENT** | `routes.ts:143-145`, `:180-181` |
| B-06 unvalidated UUID | **PARTIAL** | `storeAuth` now validates (`:1627-1630`); `gates.ts:73-75` + ~9 v1 routes still presence-only |
| X-03 `X-Admin-Uuid` | **NOT FIXED** | zero readers in `src/` |
| Plaintext DB password | **NOT FIXED** | `wrangler.jsonc:23-24` still has it (re-added with Hyperdrive rebuild); **second copy** in `migrate-tables.cjs:22-24` (port 6543). Rotate + placeholder both |
| `unhandledrejection` suppression | **NOT FIXED** | `worker.ts:18-20` still bare `preventDefault()` |
| Placeholder shifting | **NOT FIXED** (latent) | `mysqlWire.ts:152-168`, `escapeValue :140-150` |
| Per-query handshakes | **NOT FIXED by design** | documented tradeoff; retained risk |
| Missing socket timeouts | **NOT FIXED** | `WireStream.fill`, `ChunkReader.fill`; only `redisSubscribeOnce` has a deadline |
| Refunds/chargebacks | **NOT FIXED** | `routes.ts:2151-2154` still `default: break`; unresolvable-customer still 200s |
| Multi-DB split brain | **NOT FIXED** | no `DATA_TOPOLOGY.md`, no compensation; B-11 legion mismatch is a new instance |
