import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * L15 (2026-11-14) — legion cards 503'd for EVERY legion in production
 * ("Database unavailable"): the card SELECT included `l.motd`, but the live
 * legions table was created by a plugin build older than SchemaInitializer's
 * motd column, and CREATE TABLE IF NOT EXISTS never ALTERs an existing table
 * — every query died 42703 (column does not exist).
 *
 * This test simulates that live schema: any SQL touching the motd COLUMN is
 * rejected by the "database". The card must still answer 200 with
 * motd: null (the warRecord degrade pattern), not 503.
 */

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    query: vi.fn(async (sql: string) => {
      // The live DB has no motd column — any statement touching it errors.
      if (/\bmotd\b/.test(sql)) {
        const err = new Error('column l.motd does not exist');
        (err as Error & { code?: string }).code = '42703';
        throw err;
      }
      if (/FROM legions l/i.test(sql)) {
        return {
          rows: [{
            name: 'legoi', display_name: 'Legio I', level: 3, max_members: 20,
            owner_uuid: 'uu-1', created_at: '2026-01-01', xp: '100',
            member_count: '2', bank_balance: '5', owner_name: 'Sextus',
          }],
        };
      }
      if (/FROM legion_members m/i.test(sql)) {
        return { rows: [{ player_uuid: 'uu-1', role: 'LEADER', username: 'Sextus' }] };
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
    getCachedJson: vi.fn(async () => null), // cache miss — force the fetcher
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

describe('L15 legion card survives a missing motd column', () => {
  it('answers 200 with motd null when the live table lacks the column', async () => {
    const res = await legionsApi.request('/LeGoI');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { motd?: string | null; name?: string };
    expect(body.name).toBe('legoi');
    expect(body.motd).toBeNull();
  });
});
