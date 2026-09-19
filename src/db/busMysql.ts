/**
 * Game-MySQL transport for the web bus (owner directive 2026-09-19: the free Layerbase
 * Redis must be allowed to sleep ≥25% of the time — a 24/7 pub/sub subscriber makes that
 * impossible). The bus rides the game MariaDB: the plugin owns it natively (its primary
 * pool) and this worker already reaches it through the mysqlWire client (gameQuery).
 *
 * Table shapes are created idempotently HERE as well as by the plugin's BusStore —
 * whichever side boots first brings the schema in. MariaDB has no DELETE…RETURNING:
 * single-use consume is a conditional-UPDATE claim (expires_at → 0), and the response
 * read is select-then-delete by id (safe: exactly one waiting caller per request_id).
 *
 * Latency contract: command pickup ≤~500ms (the plugin's poller) + response pickup
 * ≤~400ms (this side's poll loop) — ~1s added versus pub/sub, accepted for free-tier
 * compliance.
 */
import { gameQuery } from './gameMysql.js';

let schemaEnsured = false;

/** CREATE TABLE IF NOT EXISTS for all three bus tables (idempotent, once per isolate). */
async function ensureSchema(): Promise<void> {
  if (schemaEnsured) return;
  await gameQuery(
    `CREATE TABLE IF NOT EXISTS bus_kv (
       kv_key VARCHAR(160) PRIMARY KEY,
       value TEXT,
       expires_at BIGINT NOT NULL
     )`,
  );
  await gameQuery(
    `CREATE TABLE IF NOT EXISTS web_commands (
       id BIGINT AUTO_INCREMENT PRIMARY KEY,
       request_id VARCHAR(64),
       envelope TEXT NOT NULL,
       created_at BIGINT NOT NULL
     )`,
  );
  await gameQuery(
    `CREATE TABLE IF NOT EXISTS web_responses (
       id BIGINT AUTO_INCREMENT PRIMARY KEY,
       request_id VARCHAR(64) NOT NULL,
       envelope TEXT NOT NULL,
       created_at BIGINT NOT NULL,
       INDEX idx_web_responses_request (request_id)
     )`,
  );
  schemaEnsured = true;
}

/** SETEX equivalent: upsert a key with a TTL in seconds. */
export async function busKvPut(key: string, value: string, ttlSeconds: number): Promise<void> {
  await ensureSchema();
  await gameQuery(
    `INSERT INTO bus_kv (kv_key, value, expires_at) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value), expires_at = VALUES(expires_at)`,
    [key, value, Date.now() + Math.max(1, Math.floor(ttlSeconds)) * 1000],
  );
}

/** GET equivalent: live value or null. */
export async function busKvGet(key: string): Promise<string | null> {
  await ensureSchema();
  const r = await gameQuery<{ value: string }>(
    `SELECT value FROM bus_kv WHERE kv_key = ? AND expires_at > ?`,
    [key, Date.now()],
  );
  return r[0]?.value ?? null;
}

/** DEL equivalent. */
export async function busKvDel(key: string): Promise<void> {
  await ensureSchema();
  await gameQuery(`DELETE FROM bus_kv WHERE kv_key = ?`, [key]);
}

/** GETDEL equivalent (atomic single-use consume) — conditional-UPDATE claim. */
export async function busKvConsume(key: string): Promise<string | null> {
  await ensureSchema();
  const res = await gameQuery<{ affectedRows?: number }>(
    `UPDATE bus_kv SET expires_at = 0 WHERE kv_key = ? AND expires_at > ?`,
    [key, Date.now()],
  );
  // Writes resolve to one synthetic row (mysqlWire OK-packet / mysql2 OkPacket).
  const won = (res[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
  if (won !== 1) return null;
  const r = await gameQuery<{ value: string }>(`SELECT value FROM bus_kv WHERE kv_key = ?`, [key]);
  return r[0]?.value ?? null;
}

/** SET NX EX equivalent (nonce claim): true = first sighting. */
export async function busKvPutOnce(key: string, ttlSeconds: number): Promise<boolean> {
  await ensureSchema();
  const res = await gameQuery<{ affectedRows?: number }>(
    `INSERT INTO bus_kv (kv_key, value, expires_at) VALUES (?, '1', ?) ON DUPLICATE KEY UPDATE kv_key = kv_key`,
    [key, Date.now() + Math.max(1, Math.floor(ttlSeconds)) * 1000],
  );
  return ((res[0] as { affectedRows?: number } | undefined)?.affectedRows ?? 0) === 1;
}

/** Queue a signed command envelope for the plugin's poller. */
export async function busSendCommand(envelopeJson: string): Promise<void> {
  await ensureSchema();
  const parsed = JSON.parse(envelopeJson) as { request_id: string };
  await gameQuery(
    `INSERT INTO web_commands (request_id, envelope, created_at) VALUES (?, ?, ?)`,
    [parsed.request_id, envelopeJson, Date.now()],
  );
}

/**
 * Wait for the plugin's response envelope for [requestId], polling at ~400ms until
 * [timeoutMs]. Select-then-delete by id — safe because exactly one caller waits per
 * request_id. Returns the raw envelope JSON (the exact string the plugin published),
 * or null on timeout.
 */
export async function busWaitForResponse(requestId: string, timeoutMs: number): Promise<string | null> {
  await ensureSchema();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await gameQuery<{ id: number; envelope: string }>(
      `SELECT id, envelope FROM web_responses WHERE request_id = ? ORDER BY id ASC LIMIT 1`,
      [requestId],
    );
    if (rows[0]) {
      await gameQuery(`DELETE FROM web_responses WHERE id = ?`, [rows[0].id]);
      return rows[0].envelope;
    }
    await new Promise((res) => setTimeout(res, 400));
  }
  return null;
}
