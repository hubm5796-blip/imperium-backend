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
