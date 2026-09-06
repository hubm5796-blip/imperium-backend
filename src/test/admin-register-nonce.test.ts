import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

/**
 * B-10: the slash-command registration route's nonce is actually single-use.
 * A captured (validly signed) request replayed within the ±120s window is
 * rejected by the SET-NX nonce store; the first sighting proceeds (to the
 * Discord-credentials check in these tests). Store unavailability fails
 * open with the timestamp window still in force.
 */
const { nonceClaims } = vi.hoisted(() => ({ nonceClaims: [] as string[] }));
vi.mock('../db/redisSocket.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/redisSocket.js')>();
  return {
    ...actual,
    redisCommand: vi.fn(async (_cfg: unknown, argv: string[]) => {
      if (argv[0] === 'SET' && argv[3] === 'NX') {
        const key = argv[1] as string;
        if (nonceClaims.includes(key)) return null; // already seen — replay
        nonceClaims.push(key);
        return 'OK';
      }
      return null;
    }),
  };
});

import { createApp } from '../app.js';
import { initEnvFromBindings } from '../env.js';

let app: ReturnType<typeof createApp>;
const SECRET = 'test-hmac-secret-0123456789abcdef0123456789abcdef';

function signedHeaders(nonce: string): Record<string, string> {
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', SECRET).update(`${ts}|${nonce}`).digest('hex');
  return { 'X-Timestamp': String(ts), 'X-Nonce': nonce, 'X-Signature': sig };
}

describe('B-10 registration nonce is single-use', () => {
  beforeAll(() => {
    initEnvFromBindings({
      JWT_SECRET: 'test-jwt-secret-0123456789abcdef0123456789abcdef',
      WEBPANEL_HMAC_SECRET: SECRET,
      DISCORD_CLIENT_ID: 'test-client-id',
      DISCORD_CLIENT_SECRET: 'test-client-secret',
      BOT_API_TOKEN: 'test-bot-token',
      PAYNOW_API_KEY: 'test-paynow-key',
      PAYNOW_STORE_ID: 'test-store',
      PAYNOW_WEBHOOK_SECRETS: 'test-webhook-secret',
      NODE_ENV: 'test',
    } as unknown as Record<string, unknown>);
    app = createApp();
  });

  it('the first validly-signed request proceeds past the nonce store', async () => {
    const res = await app.request('/api/admin/bot/register-commands', {
      method: 'POST',
      headers: signedHeaders('nonce-one'),
    });
    // Discord credentials are unset in tests → the route's own 503 proves the
    // request passed auth AND the nonce gate.
    expect(res.status).toBe(503);
  });

  it('the SAME signed request replayed is rejected (401 replay)', async () => {
    const headers = signedHeaders('nonce-two');
    const first = await app.request('/api/admin/bot/register-commands', {
      method: 'POST',
      headers,
    });
    expect(first.status).toBe(503); // passed the gate
    const replay = await app.request('/api/admin/bot/register-commands', {
      method: 'POST',
      headers, // byte-identical — still within the ±120s window
    });
    expect(replay.status).toBe(401);
  });

  it('a fresh nonce on the next request is fine', async () => {
    const res = await app.request('/api/admin/bot/register-commands', {
      method: 'POST',
      headers: signedHeaders('nonce-three'),
    });
    expect(res.status).toBe(503);
  });
});
