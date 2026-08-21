/**
 * V6 05-04 — API key lifecycle pins: create -> plaintext once -> hash stored ->
 * authenticate carries scopes -> wrong key/scope rejected -> revoke -> 401.
 * Uses an in-memory D1 stub (same shape as the webhooks tests' store stubs).
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

interface Row { id: string; prefix: string; hash: string; name: string; owner_uuid: string | null; scopes: string; status: string; rate_tier: string; last_used_at: number | null; created_at: number }

function makeD1() {
  const rows = new Map<string, Row>();
  return {
    rows,
    prepare(sql: string) {
      const self = {
        bind: (...params: unknown[]) => ({
          all: async () => ({
            // Respect the SELECT projection: a query that does not ask for 'hash'
            // (listKeys) must not receive it — this is exactly the leak the test pins.
            results: [...rows.values()].map((r) => (/hash/i.test(sql) ? r : { ...r, hash: undefined })),
          }),
          run: async () => {
          if (sql.startsWith('INSERT INTO api_keys')) {
            const [id, prefix, hash, name, ownerUuid, scopes] = params as [string, string, string, string, string | null, string];
            rows.set(id, { id, prefix, hash, name, owner_uuid: ownerUuid, scopes, status: 'active', rate_tier: 'standard', last_used_at: null, created_at: Date.now() });
            return { meta: { changes: 1 } };
          }
          if (sql.startsWith('UPDATE api_keys SET status')) {
            const [id, owner] = params as [string, string];
            const row = [...rows.values()].find((r) => r.id === id && r.owner_uuid === owner && r.status === 'active');
            if (row) { row.status = 'revoked'; return { meta: { changes: 1 } }; }
            return { meta: { changes: 0 } };
          }
          return { meta: { changes: 0 } };
        }}),
        all: async () => ({ results: [...rows.values()] }),
        run: async () => ({ meta: { changes: 0 } }),
      };
      return self;
    },
  };
}

// stub the D1 singleton before importing the module under test
const d1 = makeD1();
const pool = await import('../db/pool.js');
pool.initD1(d1 as never);
const { createKey, authenticateApiKey, revokeKey, listKeys } = await import('../auth/apiKeys.js');

const OWNER = '0bfbae80-a9d4-46a8-a7e7-f70ab01e7c13';

describe('API key lifecycle (05-04)', () => {
  let created: { plaintext: string; id: string };

  beforeEach(async () => {
    d1.rows.clear();
    created = await createKey('test key', OWNER, ['read:public', 'read:leaderboards']);
  });

  it('create returns the plaintext once and stores only the hash', () => {
    expect(created.plaintext).toMatch(/^imp_[A-Za-z0-9_-]{20,}$/);
    const stored = [...d1.rows.values()].find((r) => r.id === created.id);
    expect(stored).toBeDefined();
    expect(stored!.hash).toBe(createHash('sha256').update(created.plaintext).digest('hex'));
    expect(stored!.hash).not.toContain(created.plaintext);
  });

  it('authenticates the exact key with its scopes', async () => {
    const auth = await authenticateApiKey(created.plaintext);
    expect(auth).not.toBeNull();
    expect(auth!.id).toBe(created.id);
    expect(auth!.scopes).toEqual(['read:public', 'read:leaderboards']);
    expect(auth!.ownerUuid).toBe(OWNER);
  });

  it('rejects a tampered key', async () => {
    const tampered = created.plaintext.slice(0, -2) + 'xx';
    expect(await authenticateApiKey(tampered)).toBeNull();
  });

  it('rejects after revocation', async () => {
    expect(await revokeKey(created.id, OWNER)).toBe(true);
    expect(await authenticateApiKey(created.plaintext)).toBeNull();
  });

  it('revocation is owner-scoped', async () => {
    expect(await revokeKey(created.id, 'someone-else')).toBe(false);
    expect(await authenticateApiKey(created.plaintext)).not.toBeNull();
  });

  it('list never exposes hashes or plaintext', async () => {
    const keys = await listKeys(OWNER);
    expect(keys).toHaveLength(1);
    const json = JSON.stringify(keys);
    expect(json).not.toContain('hash');
    expect(json).not.toContain(created.plaintext);
  });
});
