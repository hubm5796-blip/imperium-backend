/**
 * Postgres transport for the web bus (owner directive 2026-09-19: the free Layerbase
 * Redis must be allowed to sleep ≥25% of the time — a 24/7 pub/sub subscriber makes
 * that impossible, so the bus rides the shared Supabase Postgres both sides already
 * hold open). This module implements the SAME operation surface redis.ts exported,
 * over three tables (bus_kv / web_commands / web_responses), so redis.ts can delegate
 * here function-by-function behind the BUS_TRANSPORT env flag.
 *
 * Table shapes are created idempotently HERE as well as by the plugin's BusStore —
 * whichever side boots first brings the schema in.
 *
 * Latency contract: command pickup ≤~500ms (the plugin's poller) + response pickup
 * ≤~400ms (the backend's poll loop) — ~1s added versus pub/sub, accepted for
 * free-tier compliance.
 */
import { query } from './pool.js';

let schemaEnsured = false;

/** CREATE TABLE IF NOT EXISTS for all three bus tables (idempotent, once per isolate). */
async function ensureSchema(): Promise<void> {
  if (schemaEnsured) return;
  await query(
    `CREATE TABLE IF NOT EXISTS bus_kv (
       kv_key VARCHAR(160) PRIMARY KEY,
       value TEXT,
       expires_at BIGINT NOT NULL
     )`,
    [],
  );
  await query(
    `CREATE TABLE IF NOT EXISTS web_commands (
       id BIGSERIAL PRIMARY KEY,
       request_id VARCHAR(64),
       envelope TEXT NOT NULL,
       created_at BIGINT NOT NULL
     )`,
    [],
  );
  await query(
    `CREATE TABLE IF NOT EXISTS web_responses (
       id BIGSERIAL PRIMARY KEY,
       request_id VARCHAR(64) NOT NULL,
       envelope TEXT NOT NULL,
       created_at BIGINT NOT NULL
     )`,
    [],
  );
  await query(`CREATE INDEX IF NOT EXISTS idx_web_responses_request ON web_responses (request_id)`, []);
  schemaEnsured = true;
}

/** SETEX equivalent: upsert a key with a TTL in seconds. */
export async function pgKvPut(key: string, value: string, ttlSeconds: number): Promise<void> {
  await ensureSchema();
  await query(
    `INSERT INTO bus_kv (kv_key, value, expires_at) VALUES ($1, $2, $3)
     ON CONFLICT (kv_key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`,
    [key, value, Date.now() + Math.max(1, Math.floor(ttlSeconds)) * 1000],
  );
}

/** GET equivalent: live value or null. */
export async function pgKvGet(key: string): Promise<string | null> {
  await ensureSchema();
  const r = await query<{ value: string }>(
    `SELECT value FROM bus_kv WHERE kv_key = $1 AND expires_at > $2`,
    [key, Date.now()],
  );
  return r.rows[0]?.value ?? null;
}

/** DEL equivalent. */
export async function pgKvDel(key: string): Promise<void> {
  await ensureSchema();
  await query(`DELETE FROM bus_kv WHERE kv_key = $1`, [key]);
}

/** GETDEL equivalent (atomic single-use consume). */
export async function pgKvConsume(key: string): Promise<string | null> {
  await ensureSchema();
  const r = await query<{ value: string }>(
    `DELETE FROM bus_kv WHERE kv_key = $1 AND expires_at > $2 RETURNING value`,
    [key, Date.now()],
  );
  return r.rows[0]?.value ?? null;
}

/** SET NX EX equivalent (nonce claim): true = first sighting. */
export async function pgKvPutOnce(key: string, ttlSeconds: number): Promise<boolean> {
  await ensureSchema();
  const r = await query(
    `INSERT INTO bus_kv (kv_key, value, expires_at) VALUES ($1, '1', $2) ON CONFLICT (kv_key) DO NOTHING`,
    [key, Date.now() + Math.max(1, Math.floor(ttlSeconds)) * 1000],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Queue a signed command envelope for the plugin's poller. */
export async function pgSendCommand(envelopeJson: string): Promise<void> {
  await ensureSchema();
  const parsed = JSON.parse(envelopeJson) as { request_id: string };
  await query(
    `INSERT INTO web_commands (request_id, envelope, created_at) VALUES ($1, $2, $3)`,
    [parsed.request_id, envelopeJson, Date.now()],
  );
}

/**
 * Wait for the plugin's response envelope for [requestId], polling the table at
 * ~400ms until [timeoutMs]. The row is deleted on read (single consumer). Returns
 * the raw envelope JSON (the exact string the plugin published), or null on timeout.
 */
export async function pgWaitForResponse(requestId: string, timeoutMs: number): Promise<string | null> {
  await ensureSchema();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await query<{ envelope: string }>(
      `DELETE FROM web_responses WHERE id IN (
         SELECT id FROM web_responses WHERE request_id = $1 ORDER BY id ASC LIMIT 1
       ) RETURNING envelope`,
      [requestId],
    );
    if (r.rows[0]) return r.rows[0].envelope;
    await new Promise((res) => setTimeout(res, 400));
  }
  return null;
}
