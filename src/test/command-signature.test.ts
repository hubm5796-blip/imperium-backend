import { beforeAll, describe, expect, it } from 'vitest';

/**
 * B-53 (P-20 backend half): verifyCommand is v2-only. An envelope-only
 * (v1-style) signature must be REJECTED even though it was signed with the
 * same secret — that acceptance made one valid DISPATCH_COMMAND signature
 * valid for every DISPATCH_COMMAND. The web_queue HMAC (a different,
 * intentional v1-pipe protocol) is untouched.
 */
import { initEnvFromBindings } from '../env.js';
import { signCommand, verifyCommand } from '../db/redis.js';

describe('B-53 verifyCommand is v2-only', () => {
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

  const type = 'DISPATCH_COMMAND';
  const ts = 1_700_000_000;
  const nonce = 'abcdef0123456789';
  const requestId = 'req_123';
  const body = { command: 'say hello', actor: 'panel-service' };

  it('accepts the v2 body-bound signature', () => {
    const v2 = signCommand(type, ts, nonce, requestId, body);
    expect(verifyCommand(type, ts, nonce, requestId, v2, body)).toBe(true);
  });

  it('rejects the v1 envelope-only signature for a body-bearing envelope (fails pre-fix)', () => {
    const v1 = signCommand(type, ts, nonce, requestId); // no body hash
    expect(verifyCommand(type, ts, nonce, requestId, v1, body)).toBe(false);
  });

  it('rejects a signature computed over a DIFFERENT body (cross-command replay)', () => {
    const other = signCommand(type, ts, nonce, requestId, { command: 'op garbage', actor: 'x' });
    expect(verifyCommand(type, ts, nonce, requestId, other, body)).toBe(false);
  });

  it('rejects garbage signatures without throwing', () => {
    expect(verifyCommand(type, ts, nonce, requestId, 'not-hex', body)).toBe(false);
    expect(verifyCommand(type, ts, nonce, requestId, '', body)).toBe(false);
  });
});
