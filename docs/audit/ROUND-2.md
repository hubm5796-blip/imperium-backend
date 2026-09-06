# Round 2 — Findings

A second pass covering areas the first audit explicitly listed as uncovered:
payments, dupe prevention, anticheat registration, the Discord bot, and shipped
configuration.

Same commits as round 1: plugin `234f89b`, backend `eba7716`, frontend `8fccb2a`.

**This round found the most serious defect in the audit — P-11.** It is a
configuration finding, not a code finding, which is why the first pass (which
read code) missed it entirely.

| ID | Sev | Repo | Finding |
|---|---|---|---|
| P-11 | **Critical** | plugin | A blind find-and-replace disabled 10 live subsystems, including all dupe prevention |
| P-12 | High | plugin | Dupe *prevention* is gated behind a *punishment* flag that defaults off |
| B-09 | Medium | backend | Subscription cancel failures are swallowed and can never self-heal |
| X-05 | Medium | cross | The backend's outage signal is ignored by the frontend that needed it |
| B-10 | Low | backend | Slash-command registration signs a nonce it never stores |

---

## P-11 · Critical · A blind find-and-replace disabled 10 live subsystems

**Evidence:** commit `68b2065`, 2026-08-20, authored by
`ImperiumMC Migration Bot <migration-bot@imperiummc.local>`:

> `fix: ambient Citizens NPCs disabled — owner never placed them and they spawned in bad spots`

The commit message describes changing exactly one key, and claims it was
verified:

> - live config.yml: `ambient.enabled` false (panel write + read-back verified)
> - repo default: same, with the owner note + re-enable hint
> - boot log verified: 'Disabled — zero entities, no tasks'

**It changed thirteen.** The diff is 13 identical hunks of
`enabled: true` → `enabled: false`, each stamped with the same ambient-NPC
justification:

```
-  enabled: true
+  enabled: false   # owner 2026-08-20: unwanted ambient filler — spawned in bad spots; flip to re-enable
```

This was a global substitution on the string `enabled: true`, not a targeted
edit. The tell is the final hunk, where the note was spliced into the middle of
an unrelated pre-existing comment:

```
-  enabled: true           # 03c COMPLETE 2026-08-16: objective listeners wired ...
+  enabled: false   # owner 2026-08-20: unwanted ambient filler — spawned in bad spots; flip to re-enable           # 03c COMPLETE 2026-08-16: objective listeners wired ...
```

### What is actually switched off

Current state of `src/main/resources/config.yml`. Only `ambient` was intended:

| Section | Line | Gate read at | Code default | Effect |
|---|---|---|---|---|
| `antidupe` | 846 | `Main.kt:2705` | `true` | **All 4 dupe-prevention components unregistered** |
| `circuit_breaker` | 165 | `EconomyCircuitBreaker.kt:32` | `true` | Economy circuit breaker never engages |
| `economy_reconciliation` | 253 | `EconomyReconciliationJob.kt:53` | `true` | No economy reconciliation |
| `redis` | 759 | `RedisClient.kt:38` | `true` | **Web-panel command bus dead** |
| `web` | 769 | `WebSecrets.kt:32` | `true` | Web bridge disabled |
| `tips` | 278 | `SystemBootstrap.kt:176` | `true` | Tips off |
| `festival` | 941 | `FestivalService.kt:124` | `true` | Festivals off |
| `audio` | 963 | `ImperiumAudio.kt:47` | `true` | Audio system off |
| `tax` | 359 | `TaxService.kt:39` | `false` | Tax off |
| `contracts` | 916 | `ContractService.kt:271` | `false` | Contracts off |
| `ambient` | 523 | `AmbientNpcService.kt:513` | — | **Intended** |
| `boosters` | 410 | *no reader* | — | Dead key, no effect |
| `database` | 716 | *no reader* | — | Dead key, no effect |

### Why `antidupe` is the severe one

`Main.kt:2705` gates the registration of **all four** dupe-prevention
components behind this single key:

```kotlin
if (config.getBoolean("antidupe.enabled", true)) {
    Bukkit.getPluginManager().registerEvents(antiDupeService!!, this)
    val dupePrevention = DupePreventionListener(this) ...
    itemFingerprintService = ItemFingerprintService(this) ...
    serverAuthoritativeInventory = ServerAuthoritativeInventory(this) ...
} else {
    logger.log(Level.INFO, "[AntiDupe] antidupe.enabled=false — 4 dupe listeners NOT registered")
}
```

That is **3,944 lines** of dupe-prevention machinery that never registers:

| Component | Lines |
|---|---|
| `DupePreventionListener.kt` | 1660 |
| `AntiDupeService.kt` | 1203 |
| `ItemFingerprintService.kt` | 587 |
| `ServerAuthoritativeInventory.kt` | 494 |

On a prison server the economy *is* the game. This code is sophisticated —
death-window container gating, cursor finalization ordering, item fingerprinting,
server-authoritative inventory snapshots, an item ledger — and it is doing
nothing.

### It also explains the 501s

`redis.enabled: false` kills the Redis command bus, which is why the backend's
admin routes all carry a "not wired yet" fallback
(`imperium-backend/src/api/routes.ts:1030, 1069, 1103`) and the frontend has a
`notImplemented: true` path
(`imperium-frontend/src/app/api/admin/punish/route.ts:88`). Those were read in
round 1 as unfinished features. They are not unfinished — the transport is
switched off.

### It violates the repo's own standing rule

`CLAUDE.md` opens with the project's Standing Review Question:

> **"Does this actually do what it says?"** — Before declaring anything done,
> verify it works, not just that it compiles. … **A commit message must match
> the diff.** The one thing that must be trustworthy when solo and moving fast
> is the green check.

Commit `68b2065` is the exact failure that rule exists to prevent: a commit
message describing a verified one-key change, attached to a thirteen-key diff.

`CLAUDE.md` also documents the circuit breaker as live behaviour — "The wall
also checks the circuit breaker and enforces the balance cap on both Vault and
non-Vault branches" — which is now false in the shipped configuration.

### Important scoping caveat

`src/main/resources/config.yml` is the **jar's default**. Bukkit does not
overwrite an existing `plugins/ImperiumMC/config.yml`, so a server that has run
before may hold different values, and the commit message suggests the live file
was edited separately (and correctly) for `ambient` only.

What is certain:

- **Every fresh install** boots with these 10 subsystems off.
- **The repo default is wrong**, so the values are misleading to anyone reading
  them and to any tooling that diffs live config against the default.
- **Code and config now contradict each other.** `Main.kt:2697-2704` states
  "All 4 listeners register + DETECT every dupe vector when config.yml →
  `antidupe.enabled` is true (default)" — the shipped config says otherwise.
  That contradiction is why this survived four months.

**What is not certain, and must be checked on the live server first:** whether
production is currently running with dupe prevention disabled. Do this before
anything else in this audit.

**Fix direction:**

1. **Check the live `plugins/ImperiumMC/config.yml` right now** for all 13 keys.
   Boot logs will confirm: grep for `[AntiDupe] antidupe.enabled=false`.
2. Revert the 12 unintended flips in the repo default; keep `ambient.enabled:
   false` and restore its original standalone comment.
3. Repair the mangled `contracts` line, which now carries two concatenated
   comments.
4. Delete the dead `boosters.enabled` and `database.enabled` keys, or wire them.
5. Add a boot-time assertion that logs at `WARNING` for every security-relevant
   subsystem found disabled (`antidupe`, `circuit_breaker`, `redis`), so a
   silently-off safety system announces itself on every start.
6. Treat this as a process finding too: an automated commit claimed a verified
   one-key change and shipped a thirteen-key change. Whatever produced it should
   not be trusted to edit config without a reviewed diff.

---

## P-12 · High · Dupe *prevention* is gated behind a *punishment* flag that defaults off

**Evidence:** `src/main/java/net/imperiummc/admin/DupePreventionListener.kt:1437`

```kotlin
private fun shouldPunish(): Boolean = plugin.config.getBoolean("antidupe.punish", false)
```

`shouldPunish()` gates **item removal** at roughly ten sites in this file alone
(`:388, 507, 742, 898, 929, 1069, 1078, 1322, 1362`), and at further sites in
`AntiDupeService.kt:757, 900, 1181` and `ItemFingerprintService.kt:187, 276`.

The shipped documentation states the intent plainly
(`src/main/resources/config.yml:842-844`):

> `punish: false` (default, RECOMMENDED) = detect+log+alert ONLY — **NO item
> removal**, NO ban, NO kick, so any false positive is a harmless log line

The reasoning is sound for *punishment* — nobody wants a false-positive ban. But
it has been applied to *state correction*, which is a different thing. Removing a
duplicated item is not a penalty against a player; it is undoing an invalid
change to the world. Under the recommended default, a detected dupe is logged,
alerted, audited — **and the duplicated items stay in the player's inventory.**
The dupe succeeds, loudly.

Even with P-11 fixed, this leaves the system in observe-only mode by design.

There is a second, smaller defect at the same site (`:382-394`):

```kotlin
if (shouldPunish()) {
    player.inventory.setItem(i, ItemStack(Material.AIR))
}
plugin.logger.warning("[DupePrevention] Cleared preserved item for ${player.name} ...")
```

The log line sits **outside** the gate, so with `punish: false` the log claims
"Cleared preserved item" for an item it deliberately left in place. Anyone
reading logs to assess whether dupes are being contained will conclude they are.

**Fix direction:** separate the two concepts into `antidupe.correct` (remove
duplicated items — should default **true**, it is not a penalty) and
`antidupe.punish` (ban/kick — safe to default false). Then move the log line
inside the branch, or make it state what actually happened.

---

## B-09 · Medium · Subscription cancellations that fail are swallowed and can never self-heal

**Evidence:** `imperium-backend/src/api/routes.ts:2140-2151` and `:2156-2160`

The PayNow webhook handler returns 200 on any internal failure, with this
reasoning:

```ts
// Log but still 200 — PayNow retries on non-2xx, and a cache-write failure
// isn't worth a retry storm; the next renewal event will self-heal it.
```

That argument holds for `OnSubscriptionActivated` / `OnSubscriptionRenewed`,
which recur. It does not hold for `OnSubscriptionCanceled` — **a cancelled
subscription emits no further events.** There is no next renewal, so there is
nothing to self-heal from. The same applies to the unresolvable-customer branch
at `:2145-2150`, which logs an error and returns 200.

The cache is then read first and unconditionally (`:1689`):

```ts
const cached = await dbReadOrNull('getCachedSubscription', () => getCachedSubscription(uuid));
if (cached) { return c.json({ ...cached }); }   // never falls through to live PayNow
```

So a single dropped cancel leaves `status: 'active'` in D1 permanently, and the
dashboard shows a cancelled subscriber as an active one forever.

The table has an `updated_at` column. `upsertCachedSubscription` writes it
(`src/db/pool.ts:255`), `getCachedSubscription` selects it (`:237`), and **no
code path ever reads it.** The staleness field exists; the staleness check does
not.

Worth noting the contrast: the cancel *route* at `:1728` is explicitly careful —
"Always verifies live against PayNow (never trusts the cache for an
authorization decision)". The codebase already knows this cache is
untrustworthy. The read path trusts it anyway.

Entitlement itself is granted by PayNow product commands rather than this cache,
which is why this is Medium and not High — the impact is a wrong dashboard and
management controls offered against a dead subscription, not free perks.

**Fix direction:** return non-2xx for cancel-path failures so PayNow retries;
add a `MAX_CACHE_AGE` check against `updated_at` in `getCachedSubscription` and
fall through to live PayNow when stale; and add a reconciliation job that
re-syncs cached rows older than a day.

---

## X-05 · Medium · The backend's outage signal is ignored by the frontend it was added for

**Evidence:** `imperium-backend/src/api/routes.ts:1713-1717`

```ts
// `available:false` lets the caller tell "genuinely not subscribed" from
// "PayNow is down" — the pre-fix body was indistinguishable from a real
// null, so active subscribers saw "no subscription" during outages.
return c.json({ subscription: null, available: false });
```

The frontend never reads it. `grep -n "available"` across
`src/app/dashboard/subscription/page.tsx` and `src/app/store/page.tsx` returns
nothing, and the `CurrentSubscription` type (`page.tsx:12-15`) does not declare
the field. The proxy at `src/app/api/store/subscription/route.ts:25` passes the
body through untouched, and the page renders:

```tsx
if (!currentTier || current.status === 'canceled') {
  return <h2>No active subscription</h2>  // page.tsx:77-81
}
```

So during a PayNow outage a paying subscriber is still shown *"No active
subscription. Grab one in the store."* — **the exact bug the backend comment
says was fixed.** The fix was implemented on one side of the boundary and never
consumed on the other.

This is the same shape as X-03 and X-04 from round 1, and it strengthens the
pattern noted there: four separate controls built correctly in the backend and
never adopted by the frontend.

**Fix direction:** add `available?: boolean` to `CurrentSubscription` and render
a distinct "we can't reach the billing provider right now" state when it is
`false`. Guard it with a test — this is precisely the class of bug F-01 leaves
undetectable.

---

## B-10 · Low · Slash-command registration signs a nonce it never stores

**Evidence:** `imperium-backend/src/bot/adminRegisterRoute.ts:34-45`

The route's own documentation promises replay protection:

```
 *   X-Timestamp: unix seconds (±120s replay window)
 *   X-Nonce:     random string
 *   X-Signature: hex HMAC-SHA256(secret, "<timestamp>|<nonce>")
```

The nonce is required, and it is included in the signed string — but it is never
recorded, so nothing detects its reuse. Replay protection here is the ±120s
timestamp window alone; a captured request replays freely for two minutes. The
nonce contributes nothing except the appearance of protection to a reviewer.

Compare the plugin's equivalent bus, which does this correctly:
`WebPanelCommandHandler.kt:1739` keeps a Caffeine `SEEN_NONCES` cache (and see
P-06 for its own weakness). The pattern exists in the codebase; this route does
not use it.

Impact is genuinely low — the operation is a `PUT` of the full command set, so a
replay is near-idempotent. It is filed because the gap between what the comment
promises and what the code does is exactly the kind of thing a future reader
will rely on.

**Worth noting:** this route is authorised by `env.webpanelHmacSecret`, which is
the same secret as the plugin's baked-in `DEFAULT_HMAC_SECRET` (P-01). That
constant therefore also authorises rewriting the bot's Discord slash commands —
wider blast radius than P-01 recorded.

**Fix direction:** store nonces in Redis or D1 with a TTL matching the window,
and reject repeats. Or drop the nonce from the protocol and document it honestly
as timestamp-window-only.

---

## Verified good this round

- **PayNow webhook signature verification** (`src/paynow/webhookVerify.ts`) is
  correct: HMAC-SHA256 over `${timestamp}.${rawBody}`, constant-time compare
  with a length guard, 5-minute skew window, and it fails closed when no secrets
  are configured (`.some()` on an empty array is `false`).
- **Discord interaction verification** (`src/bot/interactions.ts:39-47`) uses
  `verifyKey` from `discord-interactions` against the raw body, before parsing,
  and rejects unsupported interaction types.
- **The dupe-prevention code itself is good.** Death-time cursor finalization is
  ordered deliberately and the reasoning is documented
  (`DupePreventionListener.kt:325-341`); the death-window container gate closes a
  real hacked-client vector and correctly declines to exempt Bedrock. The
  problem is entirely that it is switched off, not how it is written.
- **`/store/subscription/cancel`** verifies ownership live against PayNow rather
  than trusting the cache (`routes.ts:1723-1727`).
