import { beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';

/**
 * X-01 (backend half): forwarded session JWTs obey the backend's 7-day
 * policy regardless of their exp claim (the frontend's 400-day TTL
 * previously made that policy unenforceable), and issuer/audience claims
 * are enforced when present.
 */
import { initEnvFromBindings } from '../env.js';
import { JWT_EXPIRY_SECONDS, signJwt, verifyJwt } from '../auth/jwt.js';

const SECRET = 'test-jwt-secret-0123456789abcdef0123456789abcdef';
const key = () => new TextEncoder().encode(SECRET);

async function customToken(opts: {
  iat: number;
  lifetime: number;
  iss?: string;
  aud?: string;
}): Promise<string> {
  const builder = new SignJWT({ authMethod: 'discord', discordId: '111111111111111111' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(opts.iat)
    .setExpirationTime(opts.iat + opts.lifetime);
  if (opts.iss !== undefined) builder.setIssuer(opts.iss);
  if (opts.aud !== undefined) builder.setAudience(opts.aud);
  return builder.sign(key());
}

describe('X-01 forwarded-JWT hygiene', () => {
  beforeAll(() => {
    initEnvFromBindings({
      JWT_SECRET: SECRET,
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

  it('the backend-issued 7-day token verifies', async () => {
    const token = await signJwt({ authMethod: 'mc_code', mcUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    expect(await verifyJwt(token)).not.toBeNull();
  });

  it('a 400-day forwarded token is rejected (lifetime exceeds the cap)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await customToken({ iat: now, lifetime: 400 * 24 * 60 * 60 });
    expect(await verifyJwt(token)).toBeNull();
  });

  it('a token older than 7 days is rejected regardless of a future exp', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await customToken({ iat: now - (JWT_EXPIRY_SECONDS + 3600), lifetime: 400 * 24 * 60 * 60 });
    expect(await verifyJwt(token)).toBeNull();
  });

  it('missing iat/exp fails closed', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ authMethod: 'discord' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(now)
      // no exp
      .sign(key());
    expect(await verifyJwt(token)).toBeNull();
  });

  it('issuer is enforced when present: family issuers pass, others are rejected', async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(await verifyJwt(await customToken({ iat: now, lifetime: 3600, iss: 'imperium-frontend' }))).not.toBeNull();
    expect(await verifyJwt(await customToken({ iat: now, lifetime: 3600, iss: 'evil-service' }))).toBeNull();
    expect(await verifyJwt(await customToken({ iat: now, lifetime: 3600 }))).not.toBeNull(); // legacy: absent
  });

  it('audience is enforced when present: imperium-api passes, others are rejected', async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(await verifyJwt(await customToken({ iat: now, lifetime: 3600, aud: 'imperium-api' }))).not.toBeNull();
    expect(await verifyJwt(await customToken({ iat: now, lifetime: 3600, aud: 'some-other-api' }))).toBeNull();
  });
});
