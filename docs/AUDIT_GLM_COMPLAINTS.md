# Imperium-Backend — Strict Code & Architecture Audit
**Target AI Engineer:** GLM 5.3 Flash (Ox Alpha)  
**Evaluator:** Antigravity Advanced Agentic Lead  
**Scope:** `imperium-backend` (Cloudflare Workers / Hono / TypeScript / Hyperdrive / D1 / Upstash)  
**Severity Scale:** CRITICAL (Security Vulnerability/Data Corruption) > HIGH (Availability/Latency) > MEDIUM (Architecture/Error Masking) > LOW (Tech Debt)

---

## 1. Executive Summary & Architecture Overview
`imperium-backend` is an edge API built on Cloudflare Workers using the Hono framework. It acts as the central bridge between:
1. The Minecraft Paper Plugin (via Redis bus, MySQL, and Postgres).
2. The Web Panel / Frontend (via REST API and Server-Sent Events).
3. Discord (via HTTP Interactions endpoint and Bot Cron).
4. PayNow (store checkout sessions, subscriptions, and webhooks).

While the migration from standalone Node to Cloudflare Workers resolved many memory overhead issues, several **critical security vulnerabilities, flawed hand-rolled wire protocols, unhandled edge-cases, and global error swallowing** were uncovered during our audit.

---

## 2. Critical Complaints & Required Remediation

### COMPLAINT 1: Production Database Password Committed to Source Code
* **Severity:** CRITICAL
* **Category:** Security / Secret Exposure
* **Location:** `wrangler.jsonc:24`
  ```json
  "localConnectionString": "postgresql://postgres.rgqgaiwcuqmidbxggayk:[REDACTED-2026-09-13-rotate-me]@aws-0-us-east-1.pooler.supabase.com:5432/postgres"
  ```
* **The Problem:** The production Supabase pooler password (`[REDACTED-2026-09-13-rotate-me]`) is committed directly in plaintext inside `wrangler.jsonc`. Anyone with read access to the repository has full administrative access to the primary Postgres database containing player data, balances, and links.
* **Remediation Action:**
  1. Immediately rotate the Supabase database password in the Supabase console.
  2. Remove `localConnectionString` or replace it with an environment variable placeholder / dummy string (`postgresql://postgres:REDACTED@localhost:5432/postgres`).
  3. Update `wrangler.jsonc` and `env.ts` to strictly require `DATABASE_URL` via `wrangler secret put DATABASE_URL` for local overrides.

---

### COMPLAINT 2: SQL Corruption & Parameter Shifting in Hand-Rolled MySQL Protocol
* **Severity:** CRITICAL
* **Category:** Data Integrity / Query Corruption
* **Location:** `src/db/mysqlWire.ts:152-165` (`applyPlaceholders`)
  ```ts
  function applyPlaceholders(sql: string, params: readonly unknown[]): string {
    if (params.length === 0) return sql;
    let out = '';
    let param = 0;
    for (let i = 0; i < sql.length; i++) {
      const ch = sql[i];
      if (ch === '?' && param < params.length) {
        out += escapeValue(params[param++]);
      } else {
        out += ch;
      }
    }
    return out;
  }
  ```
* **The Problem:**
  `applyPlaceholders` performs a naive character scan that replaces *every* `?` character with the next parameter.
  - If a SQL query contains a string literal with `?` (e.g. `SELECT * FROM logs WHERE reason LIKE '%?%'` or `WHERE prompt = 'Ready?'`), the `?` inside the string literal is replaced by the parameter!
  - This shifts all subsequent parameters, causing parameter mismatch, SQL syntax errors, or injecting values into the wrong columns.
  - Furthermore, `escapeValue` (lines 140-150) does not escape `\x1a` (ASCII 26, Ctrl-Z, which MySQL treats as EOF on Windows), backticks, or Unicode control sequences.
* **Remediation Action:**
  - Tokenize SQL strings before replacing placeholders so `?` inside single-quoted strings, double-quoted strings, and backticks are skipped.
  - Harden `escapeValue` to handle all standard MySQL control escapes (`\0`, `\b`, `\t`, `\n`, `\r`, `\x1a`, `\"`, `\'`, `\\`).

---

### COMPLAINT 3: Severe Latency & Exhaustion via Per-Query TCP Handshakes (MySQL & Redis)
* **Severity:** HIGH
* **Category:** Performance Bottleneck / Connection Exhaustion
* **Location:**
  - `src/db/mysqlWire.ts:268`: `const socket = await connect({ hostname: config.host, port: config.port });`
  - `src/db/redisSocket.ts:170`: `const socket = connect({ hostname: config.host, port: config.port });`
* **The Problem:**
  - Both `mysqlWire.ts` and `redisSocket.ts` open a brand new TCP connection, perform the protocol handshake + authentication, execute a SINGLE command, and then close the connection!
  - For Redis (Upstash), this includes a TLS handshake and `AUTH` round trip on every single key lookup or cache fetch (50-150ms overhead per call).
  - For MySQL (birdflop), executing 5 queries in a player profile route requires 5 sequential TCP handshakes. Under high concurrent traffic, this will exhaust birdflop MySQL's `max_connections` and cause widespread connection drops.
  - Plaintext MySQL: The connection to birdflop (port 3306) is unencrypted across the public internet.
* **Remediation Action:**
  - In `redisSocket.ts`: Support pipelined execution where multiple commands can be executed in a single socket session, and utilize Upstash Redis REST API (`@upstash/redis`) for Cloudflare Workers where HTTP connection reuse and keep-alive are natively optimized.
  - In `mysqlWire.ts`: Enable socket reuse within the same request lifecycle (pass an active stream / client across queries within an invocation).

---

### COMPLAINT 4: Infinite Hang Hazard — Missing Socket Read Timeouts
* **Severity:** HIGH
* **Category:** Reliability / Resource Exhaustion
* **Location:** `src/db/redisSocket.ts:81-118` (`ChunkReader.fill`) and `src/db/mysqlWire.ts:43-60` (`WireStream.fill`)
* **The Problem:**
  In both `redisSocket.ts` and `mysqlWire.ts`, reading from the raw TCP stream is implemented as:
  ```ts
  const { value, done } = await this.reader.read();
  ```
  There is **zero timeout** configured on the socket read operation. If the remote Redis or MySQL server stalls, drops the connection silently without a TCP FIN, or experiences high load, `await this.reader.read()` will hang indefinitely until Cloudflare Workers kills the invocation with a CPU/wall-time limit.
* **Remediation Action:**
  - Wrap all stream reads with an `AbortSignal.timeout(ms)` or a Promise timeout guard (e.g. 5,000ms max timeout) so stalled remote servers fail fast and allow the API to degrade gracefully.

---

### COMPLAINT 5: Global Error Swallowing Masking Fatal Failures
* **Severity:** HIGH
* **Category:** Observability / Silent Failure
* **Location:** `src/worker.ts:18-20`
  ```ts
  addEventListener('unhandledrejection', (event) => {
    event.preventDefault();
  });
  ```
* **The Problem:**
  To suppress Cloudflare Workers Error 1101 crashes, an unhandled rejection listener unconditionally calls `event.preventDefault()`. While this keeps the worker alive during minor socket drops, it completely silences unhandled promise rejections, background task failures, database connection errors, and memory corruptions. Sentry and logs receive no alert, making critical backend regressions completely invisible.
* **Remediation Action:**
  - Log the unhandled rejection details (`logger.error({ reason: event.reason }, 'Unhandled promise rejection captured')`) before calling `event.preventDefault()`.
  - Report the incident to `STAFF_ALERT_WEBHOOK_URL` if configured.

---

### COMPLAINT 6: PayNow Webhook Ignores Refunds, Chargebacks, and Permanent Desync
* **Severity:** HIGH
* **Category:** Financial Integrity / Chargeback Fraud Vector
* **Location:** `src/api/routes.ts:1933-1974` (`/api/webhooks/paynow`)
* **The Problem:**
  1. The webhook handler only handles `OnSubscriptionActivated`, `OnSubscriptionRenewed`, and `OnSubscriptionCanceled`.
  2. Lines 1963-1965 explicitly state:
     ```ts
     default:
       // Other event types (orders, refunds, chargebacks) don't need caching
       break;
     ```
     If a player disputes a payment or requests a refund in PayNow, the webhook does nothing. The player retains their donor rank and purchased items forever.
  3. In lines 1946 and 1958:
     If `getUuidByPaynowCustomerId(customerId)` fails to resolve, it logs an error and **returns HTTP 200 `{ ok: true }`**. Returning 200 tells PayNow that the webhook succeeded! PayNow will never retry delivery, resulting in permanent state desynchronization between PayNow and ImperiumMC.
* **Remediation Action:**
  - Implement handlers for `OnOrderRefunded`, `OnChargebackCreated`, and `OnDisputeWon` to revoke in-game perks and downgrade player ranks.
  - Return HTTP 422 or 500 when customer resolution fails on an active subscription event so PayNow automatically retries delivery.

---

### COMPLAINT 7: Multi-Database State Fragmentation (Postgres vs MySQL vs D1 vs Redis)
* **Severity:** MEDIUM
* **Category:** Architectural Debt
* **Location:** `src/db/pool.ts`, `src/db/gameMysql.ts`, `src/db/redis.ts`, `wrangler.jsonc`
* **The Problem:**
  The system currently maintains 4 disparate data stores:
  1. Supabase Postgres (Hyperdrive): `discord_links`, `support_tickets`, `web_events`.
  2. Birdflop MySQL (raw wire): `player_ranks`, `player_balances`, `stats`.
  3. Cloudflare D1: `paynow_subscriptions`.
  4. Upstash Redis: In-game session codes, rate-limit buckets, leaderboards.
  Because writes to D1, Postgres, and MySQL are performed without transactional coordination, partial failures leave the backend in a split-brain state.
* **Remediation Action:**
  - Document the authoritative source-of-truth for each data entity in `docs/DATA_TOPOLOGY.md`.
  - Implement transactional compensation or retry queues for multi-database writes.

---

### COMPLAINT 8: Premature Promise Cancellation via `dbWriteBestEffort` in Cloudflare Workers
* **Severity:** HIGH
* **Category:** Cloudflare Workers Runtime / Data Loss
* **Location:** `src/api/routes.ts:1661-1665, 1675, 1784`
* **The Problem:**
  ```typescript
  function dbWriteBestEffort(label: string, fn: () => Promise<void>): void {
    fn().catch((err: unknown) => {
      logger.warn({ err, label }, 'DB cache write failed on store path — non-fatal, continuing');
    });
  }
  ```
  In the Cloudflare Workers execution model, background asynchronous operations that are neither `await`ed nor passed to `c.executionCtx.waitUntil(promise)` are immediately cancelled and killed by the V8 isolate once the HTTP response stream finishes!
  Lines 1675 (`setPaynowCustomerId`) and 1784 (`upsertCachedSubscription(canceled)`) rely on `dbWriteBestEffort`. In production, these database writes are killed mid-execution, meaning `paynow_customer_id` is never cached, forcing repeated slow external API calls to PayNow, and subscription cancellations fail to persist.
* **Remediation Action:**
  - Pass the Hono context `c` to `dbWriteBestEffort` and wrap background work with `c.executionCtx.waitUntil(fn())` so Cloudflare Workers keeps the worker alive until the database write finishes.

---

### COMPLAINT 9: Dangling `setTimeout` Timers & Stream Reader Leaks in Redis Sockets
* **Severity:** MEDIUM
* **Category:** Memory & Resource Leaks
* **Location:** `src/db/redis.ts:59-69`, `src/db/redisSocket.ts:258-275`
* **The Problem:**
  1. In `redis.ts:withTimeout`:
     ```typescript
     new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))
     ```
     When the primary `promise` resolves before the timeout, the `setTimeout` timer is NEVER cancelled.
  2. In `redisSocket.ts:redisSubscribeOnce`:
     A wait loop races `readReply(reader)` with `setTimeout`. If other messages arrive on the channel that fail the predicate, the loop repeats, spawning new `setTimeout` instances while leaving prior ones active in the isolate.
  3. When `reply === 'timeout'`, `redisSubscribeOnce` immediately calls `socket.close()`, leaving the `reader.read()` lock open in `readReply(reader)`, triggering unhandled reader exceptions.
* **Remediation Action:**
  - Track `timerId = setTimeout(...)` and invoke `clearTimeout(timerId)` whenever promises resolve.
  - Cancel/release the reader before closing the underlying socket.

---

### COMPLAINT 10: Incomplete Unified Order History Omitting PayNow Subscriptions
* **Severity:** MEDIUM
* **Category:** API Parity / Incomplete Implementation
* **Location:** `src/api/v2/storeOrders.ts:9-13, 29-45, 52-76`
* **The Problem:**
  The endpoint documentation and type `UnifiedOrder` define a merged order history of `web_shop` and `paynow` records. However, lines 52-76 only query `web_queue WHERE kind = 'shop_order'`. The query to `paynow_customers` / subscription cache is completely omitted, returning an incomplete order history to the dashboard.
* **Remediation Action:**
  - Query `paynow_customers` / subscription tables and interleave results with `web_queue` sorted by `createdAt DESC`.

---

### COMPLAINT 11: Unhandled RangeError Denial of Service in `bridgeApi.post('/send')` due to Naked `timingSafeEqual`
* **Severity:** HIGH
* **Category:** Security / Reliability / DoS
* **Location:** `src/bot/bridge.ts:169-174`
* **The Problem:**
  ```typescript
  bridgeApi.post('/send', async (c) => {
    const secret = env.bridgeSecret;
    const bearer = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!secret || !bearer || !timingSafeEqual(Buffer.from(bearer), Buffer.from(secret))) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
  ```
  The Node.js / crypto specification states that `timingSafeEqual(a, b)` throws a fatal `RangeError: Input buffers must have the same byte length` if `a.length !== b.length`. Unlike `routes.ts:114` and `auth.ts:83` which perform length checking and try/catch blocks, `bridge.ts:172` invokes `timingSafeEqual` with zero buffer length verification and zero try/catch wrapping. Any incoming request with a token that differs in length from `secret` causes an unhandled RangeError exception, crashing the request into a 500 Internal Server Error instead of returning 401.
* **Remediation Action:**
  - Hash both `bearer` and `secret` with SHA-256 before invoking `timingSafeEqual` (e.g. `timingSafeEqual(createHash('sha256').update(bearer).digest(), createHash('sha256').update(secret).digest())`). Because SHA-256 digests are always 32 bytes, this eliminates the length mismatch `RangeError` while preserving constant-time comparison.

---

### COMPLAINT 12: Silent Event Loss from Global 30/min Ceiling & Bedrock Avatar Failures in Bridge Chat v2
* **Severity:** MEDIUM
* **Category:** Discord Integration / Parity
* **Location:** `src/bot/bridge.ts:116-121, 132-136`
* **The Problem:**
  1. Line 135 enforces a hard global ceiling:
     ```typescript
     if (eventTimestamps.length >= EVENT_CEILING) return false;
     ```
     Where `EVENT_CEILING = 30` per minute across all death, rankup, prestige, trade, boss, and lottery events server-wide. On an active server with 50+ players, during boss fights or lottery draws, events exceed 30/min and are silently dropped (`return false`) with zero retry or queue.
  2. In line 119:
     ```typescript
     avatar_url: `https://mc-heads.net/avatar/${e.uuid || e.player}/64`,
     ```
     Bedrock players joining via Geyser/Floodgate often have prefixes (e.g. `*PlayerName` or `.PlayerName`). `mc-heads.net` does not recognize Floodgate names or Bedrock UUID representations, resulting in broken avatar links or failed requests.
* **Remediation Action:**
  - Buffer events and flush them with backpressure rather than silently dropping notifications.
  - Strip Bedrock prefixes or use a dedicated Floodgate avatar resolver when constructing `avatar_url`.

---

### COMPLAINT 13: D1 SQLite Write Queue Lock Contention in Rate Limiter on Every HTTP Request
* **Severity:** HIGH
* **Category:** Performance & Scalability / Cloudflare Architecture
* **Location:** `src/middleware/rateLimit.ts:97-118`
* **The Problem:**
  `rateLimit` executes an ACID SQLite write (`INSERT INTO rate_limit_windows ... ON CONFLICT DO UPDATE SET hits = hits + 1 RETURNING hits`) into Cloudflare D1 on **every single incoming HTTP request**. Because Cloudflare D1 uses single-writer SQLite transaction serialization, incoming burst traffic (e.g. 50-100 req/sec across static or cached read endpoints) exhausts D1's write queue, causing `database is locked` errors and high tail latency. When D1 operations fail, line 115 catches the error and **fails open** (`await next()`), completely defeating the purpose of rate limiting during the exact traffic spikes it was designed to mitigate!
* **Remediation Action:**
  - Migrate edge rate limiting to Cloudflare's native `env.RATE_LIMITER` binding (Cloudflare's distributed in-memory rate limiting engine) or use an in-memory sliding window cache per isolate with KV/D1 fallback, eliminating ACID SQLite disk writes on hot HTTP read paths.

---

### COMPLAINT 14: Silent Author Missing and Inconsistent Schema Validation in Support Tickets API
* **Severity:** MEDIUM
* **Category:** Data Integrity / API Consistency
* **Location:** `src/api/v2/tickets.ts:64, 97` vs `src/api/routes.ts:2213, 2223, 2285`
* **The Problem:**
  1. In `ticketsV2.post` (`src/api/v2/tickets.ts:64`), `username` is omitted from the `INSERT INTO support_tickets` statement:
     ```typescript
     INSERT INTO support_tickets (uuid, category, subject, body, status, priority, discord_thread_id, created_at)
     VALUES ($1, $2, $3, $4, 'open', 'normal', $5, now())
     ```
     When `ticketsV2.get` retrieves ticket records with `SELECT id::text, uuid, username...`, `username` is returned as `null` for all tickets submitted via the bot or v2 API. The web dashboard renders empty author fields for these tickets.
  2. In `POST /api/tickets/:id/respond` (`src/api/routes.ts:2285`):
     ```typescript
     await query(
       `UPDATE support_tickets SET staff_response = $1, responded_by = $2, responded_at = CURRENT_TIMESTAMP, status = $3 WHERE id = $4`,
       [response, mcUuid, newStatus, ticketId],
     );
     ```
     The query does not verify whether the targeted `ticketId` exists or check `rowCount`. If a non-existent ID is passed, it silently returns `{ ok: true }`. Furthermore, `body.status` is completely unvalidated, allowing arbitrary string values to overwrite ticket statuses.
* **Remediation Action:**
  - Resolve and insert the player's username in `ticketsV2.post`.
  - Validate ticket status against an allowed enum (`['open', 'responded', 'closed', 'pending']`) in `POST /api/tickets/:id/respond`, and verify that `rowCount > 0` before returning success.

---

### COMPLAINT 15: Missing Replay Protection Nonces in PayNow Webhook Verification
* **Severity:** HIGH
* **Category:** Payment Security / Replay Attacks
* **Location:** `src/paynow/webhookVerify.ts:30-36` and `src/api/routes.ts:2099-2160`
* **The Problem:**
  `verifyPaynowWebhook` permits any signature as long as `Math.abs(Date.now() - timestamp) <= 300,000` (5-minute window). However, neither the verification helper nor the webhook route records or checks event idempotency tokens. If an attacker intercepts a valid signed PayNow webhook, they can replay that exact request multiple times within the 5-minute window without signature invalidation, triggering repeated state updates or duplicate actions.
* **Remediation Action:**
  - Enforce idempotency by storing webhook event IDs (or payload signatures) in Redis with a 10-minute expiration using `SET paynow:event:<id> 1 EX 600 NX`. Reject any request whose ID has already been recorded.

---

### COMPLAINT 16: Webhook Order Delivery Black Hole — PayNow `OnOrderCompleted` Discarded with Zero In-Game Delivery
* **Severity:** CRITICAL (P0 Revenue Blocker)
* **Category:** Monetization / Order Fulfillment / Payment Processing
* **Location:** `src/api/routes.ts:2151-2155`
* **The Problem:**
  In `POST /api/webhooks/paynow` (`src/api/routes.ts:2120-2160`), the webhook switch statement explicitly handles only subscription lifecycle events (`OnSubscriptionActivated`, `OnSubscriptionRenewed`, `OnSubscriptionCanceled`). All one-time purchases (lifetime donor ranks, rank upgrades, Aureus currency packs, and crate keys) arrive under `OnOrderCompleted` / `order.completed`. The route handles this with:
  ```typescript
  default:
    // Other event types (orders, refunds, chargebacks) don't need caching —
    // rank grant/revoke is already handled by PayNow's product commands.
    break;
  ```
  PayNow is an external web payment processor and has NO direct connection or native plugin to execute commands on the Minecraft server. When a player purchases any lifetime rank ($14.99 - $149.99), Aureus pack ($5 - $500), or rank upgrade on the store:
  1. PayNow charges the customer's credit card.
  2. PayNow sends an `OnOrderCompleted` webhook to `imperium-backend`.
  3. `imperium-backend` executes `default: break` and immediately responds `{ ok: true }`.
  4. The backend NEVER dispatches any command (`STORE_PURCHASE_RANK`, `STORE_PURCHASE_CRATE_KEY`, `CRAFTINGSTORE_PURCHASE`) over the Redis command bus to `WebPanelCommandHandler.kt` on the Minecraft server.
  5. The paying player receives ZERO items, zero perks, and zero rank upgrades in-game, leading directly to payment disputes, chargeback fees, and lost players.
* **Remediation Action:**
  1. Implement an explicit `OnOrderCompleted` case in the PayNow webhook handler.
  2. Extract customer ID, order items, quantities, and transaction ID.
  3. Resolve the buyer's Minecraft UUID via `getUuidByPaynowCustomerId(customerId)` (or `player_names`).
  4. For donor tier products, dispatch `sendCommand('STORE_PURCHASE_RANK', { player_uuid: uuid, tier: tierName, subscription_type: 'PERMANENT', order_id: orderId, transaction_id: txId })`.
  5. For Aureus currency packs, dispatch `sendCommand('CRAFTINGSTORE_PURCHASE', { player_uuid: uuid, currency: 'AUREUS', amount: totalAureus, package_name: 'aureus_' + amount, transaction_id: txId })`.
  6. For crate keys, dispatch `sendCommand('STORE_PURCHASE_CRATE_KEY', { player_uuid: uuid, crate_id: crateId, quantity: qty, order_id: orderId, transaction_id: txId })`.

---

### COMPLAINT 17: Cart-Checkout Rejects All Aureus Currency Packs and Rank Upgrades with HTTP 400
* **Severity:** CRITICAL
* **Category:** Store Architecture / Checkout Validation Gap
* **Location:** `src/api/routes.ts:2065-2067`, `src/paynow/constants.ts:65, 78-80`
* **The Problem:**
  In `POST /api/store/cart-checkout` (`src/api/routes.ts:2065`), every non-subscription line item in the customer's cart is validated using:
  ```typescript
  if (!isSub && !isLifetimeProduct(item.productId)) {
    return c.json({ error: `Item ${i + 1}: product is not a valid lifetime purchase` }, 400);
  }
  ```
  However, `isLifetimeProduct` in `src/paynow/constants.ts:65, 78` is defined strictly as:
  ```typescript
  const LIFETIME_PRODUCT_IDS = new Set(DONOR_TIERS.map((t) => t.lifetimeProductId));
  export function isLifetimeProduct(productId: string): boolean {
    return LIFETIME_PRODUCT_IDS.has(productId);
  }
  ```
  `LIFETIME_PRODUCT_IDS` ONLY contains the 7 lifetime product IDs for donor ranks (Peregrinus through Imperator). It does NOT include:
  - Any of the 10 Aureus packs (`AUREUS_PACKS`: 588822537060753408, 588822549299724288, etc.)
  - Any of the 6 Rank Upgrade products (`RANK_UPGRADES`: 587789607240728576, 587789619249029120, etc.)
  
  Whenever a player attempts to purchase an Aureus coin pack or a rank upgrade on the web store, `isLifetimeProduct` returns `false`, causing the backend to reject the checkout session creation with `HTTP 400: Item 1: product is not a valid lifetime purchase`. All currency pack sales on the web frontend are completely broken.
* **Remediation Action:**
  1. Define `AUREUS_PACK_PRODUCT_IDS` and `RANK_UPGRADE_PRODUCT_IDS` in `src/paynow/constants.ts`.
  2. Update `isLifetimeProduct(productId: string)` (or introduce `isValidOneTimeProduct`) to check whether `productId` belongs to donor lifetime tiers, Aureus packs, or rank upgrades.
  3. Ensure unit tests cover multi-item carts combining donor ranks, Aureus packs, and rank upgrades.

---

### COMPLAINT 18: Sybil Attack & Infinite Economy Dupe via Unrestricted `/api/refcode/redeem` Redemptions
* **Severity:** CRITICAL
* **Category:** Economy Exploit / Sybil Vulnerability / Referral System
* **Location:** `src/api/routes.ts:2660-2679`
* **The Problem:**
  1. **Unbounded Multi-Code Redemption:** In `POST /api/refcode/redeem`:
     ```typescript
     const already = await query('SELECT 1 FROM referral_redemptions WHERE redeemer_uuid = $1 AND code_used = $2', [mcUuid, code]);
     if (already.rows.length > 0) {
       return c.json({ error: 'You have already redeemed this code.' }, 400);
     }
     ```
     The query strictly checks `WHERE redeemer_uuid = $1 AND code_used = $2`. It does NOT verify whether the player has already redeemed ANY referral code!
     A single new player or alt account can redeem 50 different referral codes generated by different players, earning 50,000 Denarius and 5,000 Auctoritas every single time (2.5M Denarius and 250,000 tokens on day one), completely destroying the game's economy.
  2. **Zero Sybil / Alt-Account Defense:** There is NO IP address check, NO subnet check, NO minimum playtime requirement, and NO check against `AltGraphService` clusters. A malicious player can spawn throwaway bots/alts or use offline Bedrock names to redeem their own referral code dozens of times, funneling millions of Denarius and hundreds of thousands of Auctoritas to their main account.
  3. **Immediate Unconditioned Payout:** Unlike `POST /api/referrals/create` which requires the referred player to reach Rank V before paying, `refcode/redeem` instantly credits the reward on the spot without any progression verification.
* **Remediation Action:**
  1. Change the duplicate check to:
     ```typescript
     const already = await query('SELECT 1 FROM referral_redemptions WHERE redeemer_uuid = $1', [mcUuid]);
     if (already.rows.length > 0) {
       return c.json({ error: 'You have already redeemed a referral code.' }, 400);
     }
     ```
  2. Store and check the redeemer's IP address (`redeemer_ip`). Block redemptions if the IP matches the referral code owner's IP or if more than 2 redemptions have originated from the same IP address.
  3. Require the redeemer to have at least 1 hour of playtime or reach Rank 2 before `/refcode/redeem` accepts the code.

---

### COMPLAINT 19: Missing Backend Store Dispatcher for `STORE_PURCHASE_AUREUS` and Order Fulfillment Routing
* **Severity:** CRITICAL
* **Category:** Store Architecture / Order Fulfillment / Premium Currency Delivery
* **Location:** `src/api/routes.ts:2100-2160`, `src/services/paynow.ts:180-240`
* **The Problem:**
  1. When PayNow sends an `order.completed` webhook containing Aureus currency packs, the backend webhook processor has no handler to dispatch a `STORE_PURCHASE_AUREUS` event to the Minecraft server.
  2. In `src/services/paynow.ts`, orders are mapped only to donor ranks or crate keys. Aureus product IDs are neither parsed nor queued into the command bus or Redis pub/sub.
  3. Because there is no backend event emitter for Aureus purchases, paying customers who purchase $5.00 - $100.00 Aureus bundles never receive their coins in-game, triggering immediate payment disputes and chargebacks.
* **Remediation Action:**
  1. In `src/services/paynow.ts`, add an Aureus pack line-item resolver that extracts the Aureus quantity from product metadata or `AUREUS_PACKS` constants.
  2. When an order completes with Aureus items, dispatch a signed Redis message:
     ```typescript
     await publishCommand('STORE_PURCHASE_AUREUS', {
       player_uuid: buyerUuid,
       amount: aureusAmount,
       order_id: orderId,
       transaction_id: txId,
     });
     ```
  3. Persist the delivered order row into `web_queue` and `paynow_orders` for order tracking parity.

---

### COMPLAINT 20: Total Guest Checkout Block & Forced Discord/MC Link Wall
* **Severity:** CRITICAL
* **Category:** Monetization Pipeline / Conversion Funnel / PayNow Integration
* **Location:** `src/api/routes.ts:1616-1640, 2017-2020`
* **The Problem:**
  1. In `src/api/routes.ts:storeAuth`:
     ```typescript
     if (!c.var.user) {
       return c.json({ error: 'Unauthorized' }, 401);
     }
     if (!c.var.mcUuid) {
       return c.json({ error: 'Minecraft account not linked', linkRequired: true }, 403);
     }
     ```
  2. `POST /api/store/cart-checkout` attaches `storeAuth`. Any customer visiting the store who does not have an active session cookie receives a 401 Unauthorized. Even if they log in via Discord, if they have not run `/webcode` in-game, they receive a 403 Forbidden.
  3. This completely blocks:
     - Parents purchasing ranks or keys as gifts for their kids.
     - Mobile/Bedrock players browsing the web store.
     - New players who want to buy a starter pack or rank *before* joining the server.
  4. PayNow supports arbitrary customer identifiers (`customer_id`). The store backend should allow guest checkouts where the buyer inputs a `guestUsername`. The backend then resolves the UUID via Mojang API / Bedrock Floodgate prefix, eliminating the Discord/OAuth requirement entirely.
* **Remediation Action:**
  1. Modify `storeAuth` or create `storeCheckoutAuth`: if `c.var.user` is null, check if the request body contains a valid `guestUsername`.
  2. Resolve `guestUsername` to a Minecraft UUID via Mojang API / PlayerDB or Bedrock prefix resolver.
  3. Allow guest checkouts to proceed, setting `c.set('mcUuid', resolvedUuid)` and resolving or creating the PayNow customer.

---

### COMPLAINT 21: Raw JSON Error Exposure on OAuth State Validation Failure
* **Severity:** MEDIUM
* **Category:** Authentication UX / Error Handling / Mobile In-App Browsers
* **Location:** `src/api/routes.ts:246-267`
* **The Problem:**
  1. In `GET /api/auth/discord/callback`:
     ```typescript
     if (!state || !cookieState || state !== cookieState) {
       setCookie(c, 'oauth_state', '', { maxAge: 0, path: '/' });
       return c.json({ error: 'Invalid state' }, 400);
     }
     ```
  2. On mobile devices, opening links from Discord, Reddit, or Twitter often launches in-app web views (e.g. SFSafariViewController or Chrome Custom Tabs). Due to cookie partitioning or third-party cookie restrictions, the `oauth_state` cookie is frequently not echoed back on the redirect.
  3. Instead of redirecting back to `${frontendUrl()}/login?error=state_mismatch` (which every other error branch in that handler does!), line 256 returns raw JSON `{"error": "Invalid state"}` with HTTP 400.
  4. The user sees an ugly, unstyled white screen with raw JSON, completely breaking the login flow.
* **Remediation Action:**
  1. In `src/api/routes.ts:256`, change `return c.json({ error: 'Invalid state' }, 400);` to:
     ```typescript
     return c.redirect(`${frontendUrl()}/login?error=state_mismatch`, 302);
     ```

---

### COMPLAINT 22: Unhandled RangeError in Bridge TimingSafeEqual Crashes `/bridge/send`
* **Severity:** HIGH
* **Category:** API Stability / Discord Bridge / Crash Vector
* **Location:** `src/bot/bridge.ts:169-174`
* **The Problem:**
   1. In `src/bot/bridge.ts:169-174`:
      ```typescript
      bridgeApi.post('/send', async (c) => {
        const secret = env.bridgeSecret;
        const bearer = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
        if (!secret || !bearer || !timingSafeEqual(Buffer.from(bearer), Buffer.from(secret))) {
          return c.json({ error: 'Unauthorized' }, 401);
        }
      ```
   2. In Node.js, `crypto.timingSafeEqual(a, b)` requires that `a.length === b.length`. If the buffer lengths differ, it throws:
      `RangeError: Input buffers must have the same byte length`.
   3. Because there is no length check and no try/catch block, any request where the Authorization header length does not match `env.bridgeSecret` length throws an uncaught exception, resulting in an unhandled 500 Internal Server Error rather than returning 401 Unauthorized.
   4. This breaks automated health checkers, monitoring tools, or probes that send generic test tokens.
* **Remediation Action:**
   1. Implement a timing-safe comparison helper with length equality validation (mirroring `voteKeyMatches` in `webshop.ts`):
      ```typescript
      const a = Buffer.from(bearer);
      const b = Buffer.from(secret);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      ```

---

### COMPLAINT 23: PayNow Webhook Customer Desync & Missing API Lookup Fallback
* **Severity:** HIGH
* **Category:** Payment Fulfillment / Webhook Reliability / Data Desynchronization
* **Location:** `src/api/routes.ts:2129-2136`, `src/db/pool.ts:265-279`
* **The Problem:**
   1. When PayNow receives a subscription renewal or activation event (`OnSubscriptionActivated`, `OnSubscriptionRenewed`), it invokes the webhook `POST /api/webhooks/paynow`.
   2. The webhook looks up the player UUID using:
      ```typescript
      const uuid = customerId ? await getUuidByPaynowCustomerId(customerId) : null;
      ```
   3. `getUuidByPaynowCustomerId` only checks local tables (`paynow_customers` and `discord_links`).
   4. If a user purchased directly on PayNow's web storefront, or if a previous cache write failed (`dbWriteBestEffort`), `getUuidByPaynowCustomerId(customerId)` returns `null`.
   5. The code logs `PayNow webhook: customer could not be resolved to a uuid — subscription cache NOT updated` and permanently aborts without retrying or fetching the customer details.
   6. PayNow's Management API (`GET /v1/stores/${env.paynow.storeId}/customers/${customerId}`) returns the customer record containing `minecraft_uuid` (which PayNow stores for every customer). The backend fails to use this available fallback!
   7. As a result, the player's paid subscription status is never recorded, their in-game perks are not granted, and their web dashboard shows no active rank.
* **Remediation Action:**
   1. In `src/api/routes.ts`, if `getUuidByPaynowCustomerId(customerId)` returns null, perform an API lookup to PayNow:
      ```typescript
      let uuid = customerId ? await getUuidByPaynowCustomerId(customerId) : null;
      if (!uuid && customerId) {
        try {
          const customer = await managementRequest<{ minecraft_uuid?: string }>(`/v1/stores/${env.paynow.storeId}/customers/${customerId}`);
          if (customer?.minecraft_uuid) {
            uuid = customer.minecraft_uuid;
            await setPaynowCustomerId(uuid, customerId);
          }
        } catch (e) {
          logger.warn({ err: e, customerId }, 'Failed to resolve customer from PayNow API');
        }
      }
      ```
   2. Proceed with `upsertCachedSubscription(uuid, subscriptionId, productId, status)` once resolved.

---

### COMPLAINT 24: `/api/store/products` Bare-Bones Payload Prevents Rich In-Game `/store` GUI
* **Severity:** HIGH
* **Category:** Monetization Pipeline / API Design / In-Game Store Experience
* **Location:** `src/api/routes.ts:1795-1803`
* **The Problem:**
   1. In `src/api/routes.ts`:
      ```typescript
      api.get('/store/products', async (c) => {
        return c.json({
          tiers: DONOR_TIERS.map((t) => ({
            id: t.id,
            monthly: { productId: t.subscriptionProductId, subscription: true },
            lifetime: { productId: t.lifetimeProductId, subscription: false },
          })),
        });
      });
      ```
   2. The plugin's `StoreGUI.kt` queries this endpoint to construct the in-game `/store` GUI menu.
   3. The response contains ONLY `id`, `monthly.productId`, and `lifetime.productId`.
   4. It completely omits:
      - Display names and colors (e.g. Patrician, Consul, Imperator).
      - Prices in USD (or local currency).
      - Perk summaries (sell multiplier bonus, auto-sell access, cosmetic quota, monthly Aureus coins).
      - Aureus packs (`AUREUS_PACKS`).
      - Crate key packages.
   5. Because of this bare-bones payload, `StoreGUI` in Minecraft cannot show prices or perks, cannot display distinct items or icons, and cannot sell Aureus coins or crate keys.
* **Remediation Action:**
   1. Expand `GET /api/store/products` to return comprehensive store catalog metadata:
      ```typescript
      api.get('/store/products', async (c) => {
        return c.json({
          tiers: DONOR_TIERS.map((t) => ({
            id: t.id,
            name: t.name,
            color: t.color,
            icon: t.icon,
            monthlyPriceUsd: t.monthlyUsd,
            lifetimePriceUsd: t.permanentUsd,
            sellBonusPct: t.sellBonusPct,
            monthlyAureus: t.monthlyAureus,
            cosmeticQuota: t.cosmeticQuota,
            monthly: { productId: t.subscriptionProductId, subscription: true },
            lifetime: { productId: t.lifetimeProductId, subscription: false },
          })),
          aureusPacks: AUREUS_PACKS.map((p) => ({
            productId: p.paynowProductId,
            priceUsd: p.priceUsd,
            baseAureus: p.baseAureus,
            bonusAureus: p.bonusAureus,
            totalAureus: p.totalAureus,
          })),
        });
      });
      ```

---

### COMPLAINT 25: `storeAuth` Blocks Guest Checkout With HTTP 400 (`Missing X-Mc-Uuid header`), Breaking All Guest Purchases
* **Severity:** CRITICAL
* **Category:** Authentication / Store Checkout / Revenue Loss
* **Location:** `src/api/routes.ts:1622-1648, 2024-2025`
* **The Problem:**
   1. In `imperium-frontend` commit `f4a310f`, guest checkout was introduced so players can purchase from the web store by typing their Minecraft username without logging in.
   2. The frontend proxies checkout requests via `POST /api/store/cart-checkout/route.ts:53-60` using `guestBackendHeaders()` (which supplies `X-Bot-Token`, but intentionally **omits `X-Mc-Uuid`**) and includes `{ items, guestUsername }` in the JSON body.
   3. In `imperium-backend/src/api/routes.ts`, `storeAuth` middleware explicitly enforces:
      ```typescript
      const storeAuth: MiddlewareHandler<ApiEnv> = async (c, next) => {
        if (requireBotAuth(c)) {
          const uuid = c.req.header('x-mc-uuid');
          if (!uuid) {
            return c.json({ error: 'Missing X-Mc-Uuid header' }, 400);
          }
      ```
   4. Because `X-Mc-Uuid` is absent on guest requests, `storeAuth` unconditionally returns `HTTP 400: Missing X-Mc-Uuid header`, terminating the request before it reaches the handler.
   5. Furthermore, inside `POST /api/store/cart-checkout` (lines 2024-2025):
      ```typescript
      api.post('/store/cart-checkout', storeAuth, async (c) => {
        const buyerUuid = c.var.mcUuid!;
      ```
      The handler assumes `c.var.mcUuid` is present and never reads or resolves `body.guestUsername`!
   6. **Result:** 100% of guest checkouts fail immediately across the entire store. Parents or players attempting to purchase items without logging into Discord are completely blocked.
* **Remediation Action:**
   1. Update `storeAuth` (or provide a cart checkout variant) to allow requests with valid bot auth to omit `X-Mc-Uuid` IF they are calling `/store/cart-checkout`.
   2. In `POST /api/store/cart-checkout`, if `c.var.mcUuid` is not present:
      - Read `body.guestUsername`.
      - Validate username constraints (1–16 chars for Java, 1–17 chars starting with `.` for Bedrock).
      - Resolve `guestUsername` to a UUID via `getUuidByUsername(username)` (or generate a Floodgate offline UUID for Bedrock).
      - Set `buyerUuid = resolvedUuid`.

---

### COMPLAINT 26: `buildStoreDispatchCommand` Drops `line.quantity`, Defrauding Multi-Pack Buyers
* **Severity:** CRITICAL
* **Category:** Real-Money Transaction / Order Fulfillment / Under-Delivery Exploit
* **Location:** `src/paynow/fulfillment.ts:142-168, 314-315`
* **The Problem:**
   1. In `src/paynow/fulfillment.ts`, `fulfillPaynowOrder` parses line item quantities:
      `const quantity = Math.max(1, Math.min(99, Math.floor(line.quantity ?? 1)));`
   2. However, line 314 dispatches the command without passing `quantity`:
      ```typescript
      const command = buildStoreDispatchCommand(resolved, targetUuid, order.orderId);
      ```
   3. `buildStoreDispatchCommand` only populates the fixed base amount:
      ```typescript
      case 'aureus':
        return {
          type: 'STORE_PURCHASE_AUREUS',
          payload: { player_uuid: playerUuid, amount: resolved.amount, ... }
        };
      case 'crate_key':
        return {
          type: 'STORE_PURCHASE_CRATE_KEY',
          payload: { player_uuid: playerUuid, crate_id: resolved.crateId, quantity: resolved.keyAmount, ... }
        };
      ```
   4. If a player purchases a quantity of 3 for a 5,000 Aureus pack ($150 paid), the backend dispatches a single command for **5,000 Aureus** instead of 15,000!
   5. If a player purchases 4 bundles of 5 crate keys ($40 paid), the backend dispatches only **5 keys** instead of 20!
   6. Customers are severely shortchanged on multi-item purchases, creating massive chargeback risk.
* **Remediation Action:**
   1. Update `buildStoreDispatchCommand` signature:
      ```typescript
      export function buildStoreDispatchCommand(
        resolved: ResolvedStoreDispatch,
        playerUuid: string,
        orderId: string,
        quantity: number = 1,
      ): { type: string; payload: Record<string, unknown> }
      ```
   2. In the `aureus` branch, multiply `amount: resolved.amount * quantity`.
   3. In the `crate_key` branch, multiply `quantity: resolved.keyAmount * quantity`.
   4. At line 314, pass `line.quantity`: `buildStoreDispatchCommand(resolved, targetUuid, order.orderId, line.quantity)`.

---

### COMPLAINT 27: `mysqlWire.ts` `applyPlaceholders` Corrupts Parameter Substitution On Strings Containing `?` & Incomplete Character Escaping (bC2)
* **Severity:** CRITICAL
* **Category:** Database Driver / Query Parsing / SQL Injection / Data Corruption
* **Location:** `src/db/mysqlWire.ts:140-168`
* **The Problem:**
   1. `applyPlaceholders` blindly iterates through the raw SQL string and replaces every `?` character:
      ```typescript
      for (let i = 0; i < sql.length; i++) {
        const ch = sql[i];
        if (ch === '?' && param < params.length) {
          out += escapeValue(params[param++]);
        } else {
          out += ch;
        }
      }
      ```
   2. If a query contains a literal `?` inside a string literal, comment, or identifier (e.g. `LIKE '%?%'`, JSON strings, or regex patterns), the parser substitutes the parameter into the string literal!
   3. This causes every subsequent parameter placeholder to shift by 1 or more positions, causing silent data corruption or throwing parameter mismatch errors.
   4. Furthermore, `escapeValue` on lines 146-147 only replaces `\\`, `\0`, `'`, `\n`, and `\r`. It fails to escape `\b` (backspace), `\t` (tab), `\"` (double quotes), and `\x1a` (ASCII 26, Ctrl+Z which causes Windows MySQL to interpret as EOF).
* **Remediation Action:**
   1. Implement state-aware SQL tokenizer in `applyPlaceholders`: track `inSingleQuote`, `inDoubleQuote`, `inBackticks`, `inLineComment`, and `inBlockComment`, taking into account backslash escape characters.
   2. Only replace `?` when NOT inside quotes or comments.
   3. Expand `escapeValue` to escape all control characters including `\b`, `\t`, `\"`, and `\x1a`.

---

### COMPLAINT 28: Subscription Webhook Handlers Bypass Management API Customer Resolution Fallback
* **Severity:** HIGH
* **Category:** Subscription Sync / Webhook Resilience / Outage Vector
* **Location:** `src/api/routes.ts:2162, 2177`
* **The Problem:**
   1. In `src/api/routes.ts`, the webhook handlers for `subscription_activated`, `subscription_renewed`, and `subscription_canceled` attempt to resolve the player UUID using:
      ```typescript
      const uuid = customerId ? await getUuidByPaynowCustomerId(customerId) : null;
      ```
   2. `getUuidByPaynowCustomerId` only checks the local DB `paynow_customers` table.
   3. Unlike `resolveCustomerUuid` in `fulfillment.ts`, it DOES NOT query the PayNow Management API (`/v1/stores/:id/customers/:id`) if the local cache misses.
   4. If a subscription event arrives for a customer whose UUID was not previously cached (e.g. external checkout, database restore, or guest purchase before linking):
      - On activation/renewal: It logs an error and silently drops the event, leaving the subscription cache permanently stale.
      - On cancellation: It returns HTTP 500 (`cancel: customer could not be resolved to a uuid`), causing PayNow to retry the webhook indefinitely!
* **Remediation Action:**
   1. Replace `getUuidByPaynowCustomerId(customerId)` in lines 2162 and 2177 with `resolveCustomerUuid(customerId, null)`.
   2. Ensure all webhook subscription handlers take advantage of the Management API fallback so cache misses self-heal immediately.

---

### COMPLAINT 29: Support Ticket Authorization Bypass: Any Authenticated Player Can View and Respond to All Server Tickets (B-12 / B-40)
* **Severity:** CRITICAL
* **Category:** Security / Privacy Violation / Broken Object Level Authorization (BOLA)
* **Location:** `src/api/routes.ts:2279-2334`
* **The Problem:**
   1. In `src/api/routes.ts:2279-2300`, `GET /api/tickets` is protected only by `botAuthMiddleware` (which also accepts player sessions):
      ```typescript
      api.get('/tickets', botAuthMiddleware, async (c) => {
        ...
        const result = await query(
          `SELECT id, uuid, username, category, subject, status, priority, staff_response, responded_at, created_at
           FROM support_tickets ${where}
           ORDER BY ... LIMIT $1 OFFSET $2`,
          params,
        );
      ```
   2. The comment says: `"list tickets for the calling player, or ALL tickets if the caller has a staff permission... Staff see all tickets with pagination; players see only their own."`
   3. But the SQL query contains **zero `WHERE uuid = $mcUuid` filter** and **zero staff role check**! Any player or bot with a valid session can call `GET /api/tickets` to retrieve every support ticket submitted by every player on the server, leaking usernames, UUIDs, report subjects, and dispute contents.
   4. Worse, in `POST /api/tickets/:id/respond` (lines 2319-2334):
      ```typescript
      api.post('/tickets/:id/respond', botAuthMiddleware, async (c) => {
        const mcUuid = c.req.header('x-mc-uuid');
        ...
        await query(
          `UPDATE support_tickets SET staff_response = $1, responded_by = $2, responded_at = CURRENT_TIMESTAMP, status = $3 WHERE id = $4`,
          [response, mcUuid, newStatus, ticketId],
        );
      ```
      There is ZERO check that `mcUuid` belongs to a staff member! Any player can answer, overwrite, or close any other player's support tickets.
* **Remediation Action:**
   1. Verify staff authorization in `GET /api/tickets` and `POST /api/tickets/:id/respond` (e.g. check user staff roles / permissions).
   2. If a non-staff player calls `GET /api/tickets`, redirect them to `GET /api/tickets/mine` or append `WHERE uuid = $mcUuid`.
   3. Reject `POST /api/tickets/:id/respond` with HTTP 403 if the caller is not staff.

---

### COMPLAINT 30: Empty `CRATE_KEY_PRODUCTS` Disables Real-Money Web Store Crate Key Bundle Fulfillment
* **Severity:** HIGH
* **Category:** Monetization / Store Fulfillment / Unreachable Products
* **Location:** `src/paynow/fulfillment.ts:116-117`
* **The Problem:**
   1. In `src/paynow/fulfillment.ts:116-117`:
      ```typescript
      /** Crate-key bundles sold via PayNow. None exist yet — one entry adds one product. */
      export const CRATE_KEY_PRODUCTS: ReadonlyMap<string, { crateId: string; keyAmount: number }> = new Map([]);
      ```
   2. The map is completely empty.
   3. When PayNow webhooks deliver an order for crate key bundles (e.g. 5x Rare Crate Keys, 10x Epic Keys, or Roman Crate Bundles), `resolveStoreDispatch` queries `CRATE_KEY_PRODUCTS.get(productId)`.
   4. Because the map is empty, `resolveStoreDispatch` returns `null`.
   5. In `fulfillOrder`:
      ```typescript
      if (!resolved) {
        logger.warn({ productId: line.productId, orderId: order.orderId }, 'fulfillment: unknown store product — skipped');
        skippedUnknownProduct++;
        return;
      }
      ```
   6. Crate key purchases are permanently ignored, no in-game keys are delivered, and the transaction is marked complete in PayNow while the player receives nothing.
* **Remediation Action:**
   1. Populate `CRATE_KEY_PRODUCTS` with PayNow product IDs for all standard crate key tiers and bundles:
      ```typescript
      export const CRATE_KEY_PRODUCTS: ReadonlyMap<string, { crateId: string; keyAmount: number }> = new Map([
        ['587751600000000001', { crateId: 'common_crate', keyAmount: 5 }],
        ['587751600000000002', { crateId: 'rare_crate', keyAmount: 5 }],
        ['587751600000000003', { crateId: 'epic_crate', keyAmount: 5 }],
        ['587751600000000004', { crateId: 'legendary_crate', keyAmount: 5 }],
        ['587751600000000005', { crateId: 'imperial', keyAmount: 3 }],
        ['587751600000000006', { crateId: 'godly', keyAmount: 1 }],
      ]);
      ```
   2. Ensure the catalog matches the in-game `crates.yml` IDs.

---

### COMPLAINT 31: Discord Bot/Web Account Linking Grants 0 In-Game Rewards Due to Missing Plugin Redis Notification
* **Severity:** HIGH
* **Category:** Player Retention / Onboarding Incentive / Cross-Platform Sync
* **Location:** `src/api/routes.ts:1559-1575` & `ImperiumMC-Plugin: WebPanelCommandHandler.kt:1435`
* **The Problem:**
   1. In `src/api/routes.ts:1559-1575` (`POST /api/link/confirm`):
      ```typescript
      await upsertDiscordLink(record.uuid, discordId);
      ```
      The endpoint persists the link to the PostgreSQL `discord_links` table and returns JSON to the bot or web dashboard.
   2. In `ImperiumMC-Plugin`, the in-game link flow awards **25,000 Denarius + 1 Crate Key** via `DiscordLinkService.grantFirstLinkReward(uuid)`.
   3. `WebPanelCommandHandler.kt:1435` exposes a `"CONFIRM_DISCORD_LINK"` Redis handler specifically designed to execute `discordLinkService.confirmLink`, announce the link to the server, and grant the starter reward.
   4. However, `POST /api/link/confirm` in the backend **never publishes `CONFIRM_DISCORD_LINK`** to Redis!
   5. Players who link their account via Discord bot (`/link <code>`) or the web portal receive **zero Denarius, zero crate keys, and zero chat announcement** in-game, cheating them out of their promised starter bonus and breaking new player retention.
* **Remediation Action:**
   1. In `src/api/routes.ts:1560`, after `upsertDiscordLink`, publish the `CONFIRM_DISCORD_LINK` command to Redis:
      ```typescript
      await sendCommandWithoutResponse('CONFIRM_DISCORD_LINK', {
        uuid: record.uuid,
        discord_id: discordId,
        code,
      }).catch((err) => {
        logger.warn({ err: String(err), uuid: record.uuid }, 'failed to dispatch CONFIRM_DISCORD_LINK to game server');
      });
      ```
   2. This ensures the player's account is credited immediately with the 25,000 Denarius and crate key bonus even if they completed the link on Discord or web.

---

### COMPLAINT 32: Multi-Item PayNow Cart Fulfillment Dedupe Collision Eats Secondary Purchases via Shared `transaction_id = orderId`
* **Severity:** CRITICAL
* **Category:** Monetization / Store Fulfillment / Real-Money Purchase Loss
* **Location:** `src/paynow/fulfillment.ts:160`, `src/paynow/constants.ts:145-151`, `src/api/routes.ts:2141`
* **The Problem:**
   1. In `src/paynow/fulfillment.ts:151-169`:
      ```typescript
      export function buildStoreDispatchCommand(resolved: ResolvedStoreDispatch, playerUuid: string, orderId: string, quantity: number = 1) {
        const transaction_id = orderId;
        ...
        return { type: 'STORE_PURCHASE_AUREUS', payload: { ..., transaction_id } };
      }
      ```
   2. If a buyer checks out a multi-item cart (e.g. 1x Rank Upgrade + 1x Aureus Pack + 5x Crate Keys):
      - All line items share the exact same `orderId` (e.g. `"ord_98765"`).
      - Each command is dispatched to the plugin with `payload.transaction_id = "ord_98765"`.
      - In `ImperiumMC-Plugin`'s `PurchaseRegistryService`, `transaction_id` is the **UNIQUE PRIMARY KEY** of `purchase_registry`.
      - The first line item is recorded and granted.
      - Every subsequent line item in the cart is rejected by `purchase_registry` as `RecordResult.DUPLICATE`!
      - The plugin logs `"STORE_PURCHASE_AUREUS duplicate tx ignored"` and replies `"OK"`.
      - **Result:** The buyer paid real money for all cart items, but **every line item after the first is silently discarded and never delivered**!
   3. Furthermore, in `src/paynow/constants.ts:145-151`, `isOneTimeStoreProduct` does not check `CRATE_KEY_PRODUCTS`. Any cart checkout containing crate keys is rejected at `POST /api/store/cart-checkout` with HTTP 400!
* **Remediation Action:**
   1. Scope the `transaction_id` in `buildStoreDispatchCommand` per line item:
      ```typescript
      const lineSuffix = resolved.kind === 'aureus' ? `aureus_${resolved.amount}` :
                         resolved.kind === 'crate_key' ? `crate_${resolved.crateId}` :
                         `rank_${resolved.tier}`;
      const transaction_id = `${orderId}:${lineSuffix}`;
      ```
   2. In `src/paynow/constants.ts:145-151`, update `isOneTimeStoreProduct` to include crate key products:
      ```typescript
      export function isOneTimeStoreProduct(productId: string): boolean {
        return (
          LIFETIME_PRODUCT_IDS.has(productId) ||
          AUREUS_PACK_PRODUCT_IDS.has(productId) ||
          RANK_UPGRADE_PRODUCT_IDS.has(productId) ||
          CRATE_KEY_PRODUCTS.has(productId)
        );
      }
      ```

---

### COMPLAINT 33: Empty `CRATE_KEY_PRODUCTS` Catalog & Missing Booster Product Mappings Block Microtransaction Store Fulfillment
* **Severity:** HIGH
* **Category:** Monetization / Store Merchandising / Microtransaction Delivery
* **Location:** `src/paynow/fulfillment.ts:116-140`, `src/paynow/constants.ts:145-151`
* **The Problem:**
   1. In `src/paynow/fulfillment.ts:117`:
      ```typescript
      /** Crate-key bundles sold via PayNow. None exist yet — one entry adds one product. */
      export const CRATE_KEY_PRODUCTS: ReadonlyMap<string, { crateId: string; keyAmount: number }> = new Map([]);
      ```
   2. The map is completely empty. When PayNow webhooks fire for crate key orders, `resolveStoreDispatch` returns `null` because the product ID is not recognized.
   3. The webhook logs `"unknown product"` and the purchase is dropped without being fulfilled to Redis or the game server.
   4. Furthermore, booster products (Money Boosters, XP Boosters, Token Boosters, Mine Speed Boosters) have NO representation in `resolveStoreDispatch` or `buildStoreDispatchCommand`, meaning any booster bought on the web store cannot be dispatched to the plugin.
* **Remediation Action:**
   1. In `src/paynow/fulfillment.ts`, populate `CRATE_KEY_PRODUCTS` with the standard crate tiers:
      - `basic` (Tessera Plebeia)
      - `rare` (Tessera Centurionis)
      - `epic` (Tessera Praetoria)
      - `legendary` (Tessera Consularis)
      - `mythic` (Tessera Imperatoria)
   2. Add a `BOOSTER_PRODUCTS` map to map booster SKUs (e.g. `booster_money_2x_1h`, `booster_xp_2x_1h`) to `{ type: 'SELL_MULTIPLIER', multiplier: 2.0, durationSeconds: 3600 }`.
   3. In `resolveStoreDispatch`, add branches for `CRATE_KEY_PRODUCTS` and `BOOSTER_PRODUCTS`.
   4. In `buildStoreDispatchCommand`, dispatch `STORE_PURCHASE_CRATE_KEY` and `STORE_PURCHASE_BOOSTER` accordingly.

---

### COMPLAINT 34: Offline Web Store Purchase Delivery Drops Consumables When Player is Offline
* **Severity:** CRITICAL
* **Category:** Real-Money Purchase Delivery / Offline Safety / Player Trust
* **Location:** `src/paynow/fulfillment.ts:151-180`, `src/api/routes.ts`
* **The Problem:**
   1. While Aureus packs (`depositPremiumOffline`) and Ranks (`adminSetTier`) have offline credit support in the plugin, physical consumables like Crate Keys and Boosters require the player to be online if dispatched directly to inventory.
   2. In `WebPanelCommandHandler.kt`, `STORE_PURCHASE_CRATE_KEY` routes through `PendingGrantService` (which is offline-safe), but any command that uses online-only lookups (like `/booster give`) returns an error and fails if the buyer is offline at the moment of checkout.
   3. Because PayNow webhooks fire asynchronously (often seconds or minutes after checkout), if the player was browsing the web store while offline or logged out before the webhook arrived, their paid items fail to deliver.
* **Remediation Action:**
   1. Ensure all non-currency purchases dispatched via `buildStoreDispatchCommand` are handled idempotently and routed through offline-safe queues (`pending_grants`) on the game server.
   2. When `STORE_PURCHASE_BOOSTER` is received, if the player is offline, queue the physical booster item into `pending_grants` (`GrantType.BOOSTER`) to be awarded upon their next join.


