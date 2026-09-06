import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B-46 — the legion card's cache key and its DB lookups must AGREE on casing.
 * The key was lowercased while the queries used the raw name with a
 * case-sensitive `=`: `LegioI` and `legioi` shared one cache entry while
 * querying different rows — a case-sensitive collation served the wrong card
 * (owner/motd/bank/roster) for 60s fresh + 5min stale + 24h bridge.
 *
 * Pins: every lookup compares LOWER(column) = LOWER($1); the bound parameter
 * is the trimmed lowercase name; leading/trailing spaces are rejected as
 * junk keys (trimmed pre-validation means ' LegioI ' resolves, not mints
 * ' legioi ').
 */

const { queryCalls, redisGetKeys } = vi.hoisted(() => ({
  queryCalls: [] as Array<{ sql: string; params: unknown[] }>,
  redisGetKeys: [] as string[],
}));

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    query: vi.fn(async (sql: string, params: unknown[]) => {
      queryCalls.push({ sql, params });
      if (sql.includes('FROM legions')) {
        return {
          rows: [{
            name: 'legoi', display_name: 'Legio I', level: 3, max_members: 20,
            owner_uuid: 'uu-1', motd: 'rome', created_at: '2026-01-01', xp: '100',
            member_count: '2', bank_balance: '5', owner_name: 'Sextus',
          }],
        };
      }
      return { rows: [] };
    }),
    getD1: vi.fn(() => {
      throw new Error('D1 not needed here (readRateLimit fails open)');
    }),
  };
});

vi.mock('../db/redis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/redis.js')>();
  return {
    ...actual,
    getCachedJson: vi.fn(async (key: string) => {
      redisGetKeys.push(key);
      return null; // cache miss — force the fetcher
    }),
    setCachedJson: vi.fn(async () => true),
  };
});

import { legionsApi } from '../api/expansion/legions.js';
import { __resetEnvForTests, initEnvFromBindings } from '../env.js';

beforeAll(() => {
  __resetEnvForTests();
  initEnvFromBindings({
    JWT_SECRET: 'test-jwt-secret-0123456789abcdef',
    DISCORD_CLIENT_ID: '1',
    DISCORD_CLIENT_SECRET: 'x',
    WEBPANEL_HMAC_SECRET: 'hmac',
    PAYNOW_API_KEY: 'pk',
    PAYNOW_STORE_ID: '1',
    PAYNOW_WEBHOOK_SECRETS: 'whsec',
  } as unknown as Record<string, unknown>);
});

beforeEach(() => {
  queryCalls.length = 0;
  redisGetKeys.length = 0;
});

describe('B-46 legion card casing agreement', () => {
  it('queries use LOWER(...) = LOWER($1) with the normalized key, and the cache key matches', async () => {
    const res = await legionsApi.request('/LeGoI');
    expect(res.status).toBe(200);
    await res.json();

    // Cache key: trimmed + lowercased.
    expect(redisGetKeys).toContain('legion:card:legoi:v1');

    // Every SQL lookup is case-insensitive AND binds the same normalized value.
    const lookups = queryCalls.filter((c) => /legion_name|legions l/i.test(c.sql));
    expect(lookups.length).toBeGreaterThanOrEqual(4); // card, roster, upgrades, war
    for (const call of lookups) {
      expect(call.sql).toMatch(/LOWER\(l\.name\) = LOWER\(\$1\)|LOWER\((m\.)?legion_name\) = LOWER\(\$1\)/);
      expect(call.params[0]).toBe('legoi');
    }
  });

  it('surrounding whitespace is normalized away, not minted into a junk key', async () => {
    const res = await legionsApi.request('/%20LeGoI%20');
    expect(res.status).toBe(200);
    await res.json();
    expect(redisGetKeys).toContain('legion:card:legoi:v1');
    for (const call of queryCalls) {
      if (/legion/i.test(call.sql)) expect(String(call.params[0])).toBe('legoi');
    }
  });
});
