import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * B-52: single-use codes are consumed ATOMICALLY. The mock simulates the
 * exact race the old GET-then-DEL lost: GET always answers with the record
 * (as if neither consumer's DEL had landed yet) while GETDEL answers once
 * and then misses — so the legacy implementation would hand the same login
 * code to two concurrent consumers and the new one cannot.
 */
const { calls } = vi.hoisted(() => ({ calls: [] as string[][] }));
// 2026-09-19: these tests assert the REDIS transport semantics via the socket mock.
process.env.BUS_TRANSPORT = 'redis';

vi.mock('../db/redisSocket.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/redisSocket.js')>();
  return {
    ...actual,
    redisCommand: vi.fn(async (_cfg: unknown, argv: string[]) => {
      calls.push(argv);
      const [cmd, key] = argv;
      if (cmd === 'GETDEL') {
        // Atomic consume: succeeds exactly once per key (the current call is
        // already in `calls`, so "first" means no PRIOR GETDEL for the key).
        const prior = calls.filter((c) => c[0] === 'GETDEL' && c[1] === key).length <= 1;
        if (key === 'ImperiumMC:login_code:123456' && prior) {
          return JSON.stringify({ uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', username: 'Griefos' });
        }
        return null;
      }
      if (cmd === 'GET') {
        // Legacy race shape: the value is still there (DEL hasn't landed).
        return JSON.stringify({ uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', username: 'Griefos' });
      }
      return null;
    }),
  };
});

import { initEnvFromBindings } from '../env.js';
import { consumeLoginCode, consumeSessionCode } from '../db/redis.js';

describe('B-52 atomic single-use consumption', () => {
  beforeAll(() => {
    initEnvFromBindings({
      JWT_SECRET: 'test-jwt-secret-0123456789abcdef0123456789abcdef',
      WEBPANEL_HMAC_SECRET: 'test-hmac-secret-0123456789abcdef0123456789abcdef',
      DISCORD_CLIENT_ID: 'test-client-id',
      DISCORD_CLIENT_SECRET: 'test-client-secret',
      BOT_API_TOKEN: 'test-bot-token',
      PAYNOW_API_KEY: 'test-paynow-key',
      PAYNOW_STORE_ID: 'test-store',
      PAYNOW_WEBHOOK_SECRETS: 'test-webhook-secret',
      NODE_ENV: 'test',
    } as unknown as Record<string, unknown>);
  });

  it('two concurrent consumers of one login code: exactly ONE wins', async () => {
    calls.length = 0;
    const [a, b] = await Promise.all([
      consumeLoginCode('123456'),
      consumeLoginCode('123456'),
    ]);
    const winners = [a, b].filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]?.uuid).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    // The atomic path was used (GETDEL), not the racy GET+DEL pair.
    expect(calls.some((c) => c[0] === 'GETDEL')).toBe(true);
    expect(calls.some((c) => c[0] === 'GET')).toBe(false);
  });

  it('a miss costs nothing and returns null (no consume)', async () => {
    calls.length = 0;
    expect(await consumeLoginCode('999999')).toBeNull();
  });

  it('session handoff codes use the same atomic consume', async () => {
    calls.length = 0;
    // GETDEL on the session key answers once per the mock's login-code rule;
    // use a login-code-shaped key is wrong — assert the command shape instead.
    await consumeSessionCode('abcdef').catch(() => null);
    expect(calls.some((c) => c[0] === 'GETDEL' && c[1] === 'ImperiumMC:session:abcdef')).toBe(true);
  });
});
