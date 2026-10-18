/**
 * Checkout resolves usernames with strictPlatform: a bare name is Java and a
 * '.'-name is Bedrock. A Java name that collides with a Bedrock gamertag in
 * player_names must not resolve to the Floodgate UUID (PayNow cannot index
 * it and the purchase fails), and a '.'-name must find a gamertag stored
 * without the dot.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { pgState } = vi.hoisted(() => ({
  pgState: { rows: [] as Array<{ uuid: string }>, queries: [] as Array<{ sql: string; params: unknown[] }> },
}));

vi.mock('pg', () => ({
  Pool: class {
    on() {}
    async end() {}
    async connect() {
      return {
        async query(sql: string, params: unknown[]) {
          pgState.queries.push({ sql, params });
          return { rows: sql.startsWith('SELECT') ? pgState.rows : [], rowCount: 0 };
        },
        release() {},
      };
    }
  },
}));

import { getUuidByUsername, initPool, isFloodgateUuid } from '../db/pool.js';

const JAVA = 'a25a17ce-bca1-4894-92c9-00d7ab5b7875';
const FLOODGATE = '00000000-0000-0000-0009-c1381381a817';
const MOJANG = 'b50ad385-829d-3141-a216-7e7d7539ba7f';
const realFetch = globalThis.fetch;

beforeAll(() => initPool('postgresql://fake'));
beforeEach(() => {
  pgState.rows = [];
  pgState.queries = [];
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ id: MOJANG.replace(/-/g, ''), name: 'mstudboy' }), { status: 200 }),
  ) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('getUuidByUsername strictPlatform', () => {
  it('detects Floodgate UUIDs', () => {
    expect(isFloodgateUuid(FLOODGATE)).toBe(true);
    expect(isFloodgateUuid(JAVA)).toBe(false);
  });

  it('a bare name prefers the Java row over a same-named Bedrock row', async () => {
    pgState.rows = [{ uuid: FLOODGATE }, { uuid: JAVA }];
    expect(await getUuidByUsername('mstudboy', { strictPlatform: true })).toBe(JAVA);
  });

  it('a bare name with only a Bedrock row falls through to Mojang', async () => {
    pgState.rows = [{ uuid: FLOODGATE }];
    expect(await getUuidByUsername('mstudboy', { strictPlatform: true })).toBe(MOJANG);
  });

  it('a dot-name matches the gamertag stored without the dot', async () => {
    pgState.rows = [{ uuid: JAVA }, { uuid: FLOODGATE }];
    expect(await getUuidByUsername('.mstudboy', { strictPlatform: true })).toBe(FLOODGATE);
    expect(pgState.queries[0]!.params).toEqual(['.mstudboy', 'mstudboy']);
  });

  it('a dot-name never resolves to a Java account', async () => {
    pgState.rows = [{ uuid: JAVA }];
    expect(await getUuidByUsername('.mstudboy', { strictPlatform: true })).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('without strictPlatform the first registry row still wins (profile lookups unchanged)', async () => {
    pgState.rows = [{ uuid: FLOODGATE }, { uuid: JAVA }];
    expect(await getUuidByUsername('mstudboy')).toBe(FLOODGATE);
  });
});
