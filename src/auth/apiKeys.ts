/**
 * V6 05-04 AUTH V2 — API keys: the third-party access principal.
 *
 * Format: imp_<32 url-safe chars>, shown ONCE at creation, stored as SHA-256
 * hash + 8-char prefix (plaintext never at rest — unlike the shared bot
 * token, keys get pasted into repos). Lookup: prefix index in D1, then
 * constant-time hash compare. Scopes are a closed enum (v1: reads +
 * webhook management ONLY — game mutations go through the queue/bus, which
 * keys cannot reach; there are no write scopes by construction).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { getD1 } from '../db/pool.js';

export const SCOPES = [
  'read:public',
  'read:player',
  'read:leaderboards',
  'read:economy',
  'webhooks:manage',
] as const;

export type Scope = (typeof SCOPES)[number];

export interface ApiKeyRow {
  id: string;
  prefix: string;
  name: string;
  owner_uuid: string | null;
  scopes: string; // JSON array
  status: string;
  rate_tier: string;
  last_used_at: number | null;
  created_at: number;
}

export interface AuthenticatedKey {
  id: string;
  scopes: Scope[];
  ownerUuid: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS api_keys (
  id text primary key,
  prefix text not null,
  hash text not null,
  name text not null,
  owner_uuid text,
  scopes text not null,
  status text not null default 'active',
  rate_tier text not null default 'standard',
  last_used_at integer,
  created_at integer not null
)`;

async function ensureSchema(): Promise<void> {
  await getD1().prepare(SCHEMA).run();
}

function hashKey(fullKey: string): string {
  return createHash('sha256').update(fullKey, 'utf8').digest('hex');
}

function parseScopes(json: string): Scope[] {
  try {
    const arr = JSON.parse(json) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((s): s is Scope => (SCOPES as readonly string[]).includes(s as string));
  } catch {
    return [];
  }
}

/** Generates a fresh key: imp_<32 chars>. Returns the plaintext ONCE + the row to store. */
export function generateKey(name: string, ownerUuid: string | null, scopes: Scope[]): { plaintext: string; id: string; prefix: string; hash: string } {
  const plaintext = 'imp_' + randomBytes(24).toString('base64url').slice(0, 32);
  return {
    plaintext,
    id: 'key_' + randomBytes(6).toString('base64url'),
    prefix: plaintext.slice(0, 8),
    hash: hashKey(plaintext),
  };
}

/** Persists a key (hash only). Returns the stored id. */
export async function createKey(name: string, ownerUuid: string | null, scopes: Scope[]): Promise<{ plaintext: string; id: string; prefix: string }> {
  await ensureSchema();
  const k = generateKey(name, ownerUuid, scopes);
  await getD1()
    .prepare('INSERT INTO api_keys (id, prefix, hash, name, owner_uuid, scopes, status, rate_tier, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(k.id, k.prefix, k.hash, name.slice(0, 80), ownerUuid, JSON.stringify(scopes), 'active', 'standard', Date.now())
    .run();
  return { plaintext: k.plaintext, id: k.id, prefix: k.prefix };
}

export async function listKeys(ownerUuid: string): Promise<Array<Omit<ApiKeyRow, 'hash'>>> {
  await ensureSchema();
  const { results } = await getD1()
    .prepare('SELECT id, prefix, name, owner_uuid, scopes, status, rate_tier, last_used_at, created_at FROM api_keys WHERE owner_uuid = ? ORDER BY created_at DESC')
    .bind(ownerUuid)
    .all<Omit<ApiKeyRow, 'hash'>>();
  return results ?? [];
}

export async function revokeKey(id: string, ownerUuid: string): Promise<boolean> {
  await ensureSchema();
  const res = await getD1()
    .prepare("UPDATE api_keys SET status = 'revoked' WHERE id = ? AND owner_uuid = ? AND status = 'active'")
    .bind(id, ownerUuid)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * Authenticate a bearer key: prefix lookup, constant-time hash compare,
 * active-status check, last_used touch (fire-and-forget). Null on any miss.
 */
export async function authenticateApiKey(fullKey: string): Promise<AuthenticatedKey | null> {
  if (!fullKey.startsWith('imp_') || fullKey.length < 12) return null;
  await ensureSchema();
  const prefix = fullKey.slice(0, 8);
  const { results } = await getD1()
    .prepare('SELECT id, hash, owner_uuid, scopes, status FROM api_keys WHERE prefix = ?')
    .bind(prefix)
    .all<{ id: string; hash: string; owner_uuid: string | null; scopes: string; status: string }>();
  const rows = results ?? [];
  for (const row of rows) {
    if (row.status !== 'active') continue;
    const expected = Buffer.from(row.hash, 'utf8');
    const provided = Buffer.from(hashKey(fullKey), 'utf8');
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) {
      void getD1().prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').bind(Date.now(), row.id).run().catch(() => undefined);
      return { id: row.id, scopes: parseScopes(row.scopes), ownerUuid: row.owner_uuid };
    }
  }
  return null;
}
