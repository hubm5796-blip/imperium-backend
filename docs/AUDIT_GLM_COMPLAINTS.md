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
  "localConnectionString": "postgresql://postgres.rgqgaiwcuqmidbxggayk:KCxtU9fjBMkZDRC%26@aws-0-us-east-1.pooler.supabase.com:5432/postgres"
  ```
* **The Problem:** The production Supabase pooler password (`KCxtU9fjBMkZDRC%26`) is committed directly in plaintext inside `wrangler.jsonc`. Anyone with read access to the repository has full administrative access to the primary Postgres database containing player data, balances, and links.
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
