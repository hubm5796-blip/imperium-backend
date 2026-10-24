# Pass 4 — Money-Path Failure Composition — backend × plugin (2026-10-24)

> Companion to `2026-10-23-code-review.md` (backend passes 1-3) and RomanicaPlugin's `2026-10-23-code-review.md`. This audit traces the exact path of one real purchase across **both** repos and asks whether the individually-verified recovery paths **compose** when failures stack. Known findings not repeated except where the composition sharpens them.

## Critical framing correction: there are TWO disjoint money transports

The passes 1-3 narrative treated webhook → D1 claim → `web_queue` → plugin as one path. It is not:

- **A. Real money (PayNow)** travels the **signed command bus** (`sendCommandWithResponse`, 6s timeout), NOT `web_queue`: webhook HMAC verify (`webhookVerify.ts:19-51`) → per-line D1 claim (`fulfillment.ts:261-276`) → `sendCommandWithResponse` (`:394`) → Redis `ImperiumMC:commands` (or MySQL `web_commands` on the default transport — see the split-brain note) → plugin `WebPanelCommandListener` → `WebPanelCommandHandler` → `PurchaseRegistry` (dedupe on `transaction_id`, DB UNIQUE) → `depositPremium` / `PendingGrantService`. The 24h `web_queue` freshness does **not** apply to PayNow orders — that protection is web_queue-only.
- **B. Denarius web shop + votes** travel `web_queue` on cloud Postgres (`enqueueWebQueue`, nanoid(16), HMAC v1) → plugin `WebQueueConsumer` — whose "claim" is a **read-only SELECT of pending rows** (no claim status, nothing to strand) → sinks dedupe durably (`web_queue:<requestId>` registry claim, `vote_claims`).
- **C. Crate-open delegation** (website → in-game): `CRATE_OPEN_WEB` / `GET_PLACED_CRATES` are dispatched by `routes.ts:2736,2750-2787` but **exist nowhere in the plugin** (grep: zero matches; no case in the dispatch table `WebPanelCommandHandler.kt:138-172`) → every open hangs 15s → 501 "Game server did not respond". The feature is dead on arrival; no key can ever be consumed through it.

## Failure-mode composition table

| Scenario | What the code actually does | Outcome | Verdict |
|---|---|---|---|
| Plugin polls, crashes before processing | No claim status exists to strand; row re-polled; sinks' durable dedupe absorbs partial work | None | **RECOVERS** |
| Crash after grant, before settle | Replay store is in-memory (lost on restart) → re-poll → same requestId → same txId → `DUPLICATE → DONE`, no re-withdraw | No double-pay | **RECOVERS** |
| **Crash between registry claim and grant completion** | Redelivery sees `DUPLICATE` → `DONE`/`OK` (`WebGrantSinksImpl.kt:99-102`, `WebPanelCommandHandler.kt:776-779` et al.) — the recovery path **certifies a grant that never happened**; no completion marker is consulted | Paid order permanently undelivered, reads as settled | **LOSES-MONEY/ITEM** (narrow window, deterministic once hit) |
| PayNow retry storm while plugin down, retries exhausted | Each retry releases the claim correctly and 500s so PayNow retries; when PayNow gives up: **no dead-letter, no re-dispatcher, no alert, no email** — only `/shop/orders` showing `complete` without `deliveredAt`. **Worse stack:** if the release DELETE itself fails (swallowed, `fulfillment.ts:291-294`), the orphan claim makes the next retry `skippedDuplicate` → `ok`/200 → retries stop → `history.ts:92-98` maps the orphan to **`delivered`** — a false delivery claim that suppresses support intuition | Charged, undelivered, silent; worst case actively mislabeled | **SILENT** |
| Clock skew >30s (worker vs game host) | Plugin rejects at the ts check **silently** (`WebPanelCommandHandler.kt:1936`); the only log is the catch-all `Rejected unauthenticated command` (`:123-125`); 6s timeout → release → 500 → retry loop. Sustained skew = all PayNow delivery halts, composing with the no-dead-letter gap. (Webhooks' 5-min window and web_queue's 24h window are skew-tolerant) | Charged, undelivered while skew persists | **SILENT** |
| Duplicate request_id | `web_queue.request_id` UNIQUE + plain INSERT ⇒ collision throws ⇒ 503 ⇒ client retries with a fresh nanoid. PayNow grants key on `transaction_id = orderId(:L<i>)` — distinct orders can't collide | None | **RECOVERS** |
| **PayNow `refunded`/`chargeback`** | Hit `case 'unknown': break` → 200 (`routes.ts:2501-2505`). The backend **never dispatches `STORE_REFUND`** (zero references); the plugin's complete revocation pipeline (`PurchaseRefundService.kt:72-228`: AUREUS clawback floored at 0 with audit, rank demote, key decrement) has **no sender** — its own doc claims one exists (`:35-38`), which is false. (Wall question resolves cleanly: the clawback is a withdrawal; no refund path re-credits AUREUS) | Refunded chargeback keeps every granted good — **server loses money AND goods** | **LOSES-MONEY** (server side) |
| Website crate-open timeout vs late processing | Moot — the command has no plugin handler; the route always 501s and no key is ever consumed | Feature dead; no money moves | **SILENT** (absent feature) |
| Vote-callback replay | Auth = static per-site shared key; body `timestamp` optional and unvalidated; **no nonce, no replay cache** (`webshop.ts:59-89`); 10/min/IP is the only throttle. Plugin-side `vote_claims (uuid,site,day)` bounds same-day replay; replay after UTC-midnight grants again — composing with the known fail-open dedupe during DB outages | Extra vote keys per replayed callback per day | **DUPLICATES** (bounded) |
| `inFlight` overlap | Released before async grants settle — safe only because `recordIfNew` (DB UNIQUE) is the serialization point | None (document it) | **RECOVERS** |

## Findings

1. **[P1] PayNow refunds/chargebacks are swallowed and the plugin's refund-revocation pipeline is dead code** — neither pass 2 (backend) nor the plugin audits saw the other half. Wire `refunded`/`chargeback` → `STORE_REFUND` carrying the order's transaction ids, or park the pipeline explicitly with a disabled marker and fix the false doc.
2. **[P1] Website crate-open is wired to nothing** (`CRATE_OPEN_WEB`, `GET_PLACED_CRATES`) — implement handlers in `WebPanelCommandHandler` (mirroring `CrateClaimService`'s durable claim) or delete the routes and the frontend surfaces.
3. **[P1, conditional] The MySQL/Redis bus split-brain is sharper than pass 2 reported:** PayNow fulfillment is the only caller that 500s PayNow, so on the default MySQL transport **every real-money dispatch times out forever regardless of plugin health**. Prod must pin `BUS_TRANSPORT=redis`; nothing in either repo enforces or alerts on the mismatch.
4. **[P2] Claim-before-grant commit gap** — on `DUPLICATE`, require a completion artifact (ledger row / pending-grant row / `completed_at` on `purchase_registry`) before returning DONE; else return TRANSIENT and let retries converge.
5. **[P2] A failed claim-release silently upgrades a failed dispatch to "delivered"** in shop history (`fulfillment.ts:393-404` + `history.ts:92-98`) — treat release failure as a webhook error so PayNow keeps retrying.
6. **[P2] >30s clock drift halts all bus delivery under a misleading "unauthenticated" log** — make `evaluateCommandEnvelope` return a reason (window/nonce/signature), log distinctly, alert on consecutive window-rejections; consider widening the window with the existing nonce-TTL headroom.
7. **[P2] No customer-visible artifact or reconciliation for exhausted PayNow retries** — add a cron sweep comparing PayNow completed orders against `paynow_order_dispatches` (alert + optional re-dispatch on gap).
8. **[P3] Vote callbacks accept unlimited same-key replays** — backend TTL dedupe on `(site, sha256(body))` + `timestamp` drift validation.
9. **[P3] `web_queue` expiry is plugin-only** — the backend never expires or surfaces `skipped` rows; a Denarius order queued near the 24h boundary flips to `skipped` with no notification.

## Top fixes

1. Wire the refund path (or park it honestly).
2. Close the claim-grant commit gap with a completion marker.
3. Make release failure visible (webhook error, not 200).
4. Implement or delete the web crate-open surface.
5. Skew observability on the bus + pin `BUS_TRANSPORT=redis` in prod with a boot-time cross-repo assertion.
6. PayNow reconciliation sweep + vote replay dedupe.
