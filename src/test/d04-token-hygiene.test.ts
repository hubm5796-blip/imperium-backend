import { beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { initEnvFromBindings, __resetEnvForTests, env } from '../env.js';
import { signJwt, signClientJwt, verifyJwt, verifyClientJwt, CLIENT_JWT_AUDIENCE } from '../auth/jwt.js';

/**
 * S2-D04 token hygiene — the per-family JWT secret split. Sessions and client
 * tokens are DIFFERENT trust families: separate key material (CLIENT_JWT_SECRET,
 * falling back to the session secret until the owner sets it), audience
 * separation on top. The pin that matters: key material minted with the SESSION
 * secret can never verify as a client token, even carrying the right audience —
 * the property a shared-secret bug or a lost audience check would break.
 */

const SESSION_SECRET = 'd04-session-secret-0123456789abcdef0123456789abcdef';
const CLIENT_SECRET = 'd04-client-secret-0123456789abcdef0123456789abcdef';
const encoder = new TextEncoder();

async function mintWithSessionSecret(aud: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ authMethod: 'mc_client', mcUuid: '11111111-2222-4333-8444-555555555555' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .setIssuer('imperium-backend')
    .setAudience(aud)
    .sign(encoder.encode(SESSION_SECRET));
}

describe('D04: client JWT family uses its own secret', () => {
  it('clientJwtSecretShared reports the fallback while CLIENT_JWT_SECRET is unset', () => {
    __resetEnvForTests();
    initEnvFromBindings({
      JWT_SECRET: SESSION_SECRET,
      WEBPANEL_HMAC_SECRET: 'd04-hmac-secret-0123456789abcdef0123456789abcdef',
      DISCORD_CLIENT_ID: 'd04-client-id',
      DISCORD_CLIENT_SECRET: 'd04-client-secret',
      BOT_API_TOKEN: 'd04-bot-secret',
      INTERNAL_SERVICE_TOKEN: 'd04-svc-secret',
      PAYNOW_API_KEY: 'd04-paynow-key',
      PAYNOW_STORE_ID: 'd04-store',
      PAYNOW_WEBHOOK_SECRETS: 'd04-webhook-secret',
      NODE_ENV: 'test',
      D1_RATE_LIMIT: { stub: true },
    } as unknown as Record<string, unknown>);
    expect(env.clientJwtSecretShared).toBe(true);
    expect(env.clientJwtSecret).toBe(SESSION_SECRET);
  });

  it('setting CLIENT_JWT_SECRET splits the families and flags it', () => {
    __resetEnvForTests();
    initEnvFromBindings({
      JWT_SECRET: SESSION_SECRET,
      CLIENT_JWT_SECRET: CLIENT_SECRET,
      WEBPANEL_HMAC_SECRET: 'd04-hmac-secret-0123456789abcdef0123456789abcdef',
      DISCORD_CLIENT_ID: 'd04-client-id',
      DISCORD_CLIENT_SECRET: 'd04-client-secret',
      BOT_API_TOKEN: 'd04-bot-secret',
      INTERNAL_SERVICE_TOKEN: 'd04-svc-secret',
      PAYNOW_API_KEY: 'd04-paynow-key',
      PAYNOW_STORE_ID: 'd04-store',
      PAYNOW_WEBHOOK_SECRETS: 'd04-webhook-secret',
      NODE_ENV: 'test',
      D1_RATE_LIMIT: { stub: true },
    } as unknown as Record<string, unknown>);
    expect(env.clientJwtSecretShared).toBe(false);
    expect(env.clientJwtSecret).toBe(CLIENT_SECRET);
  });

  it('a client token verifies under the split; a session token does not cross', async () => {
    __resetEnvForTests();
    initEnvFromBindings({
      JWT_SECRET: SESSION_SECRET,
      CLIENT_JWT_SECRET: CLIENT_SECRET,
      WEBPANEL_HMAC_SECRET: 'd04-hmac-secret-0123456789abcdef0123456789abcdef',
      DISCORD_CLIENT_ID: 'd04-client-id',
      DISCORD_CLIENT_SECRET: 'd04-client-secret',
      BOT_API_TOKEN: 'd04-bot-secret',
      INTERNAL_SERVICE_TOKEN: 'd04-svc-secret',
      PAYNOW_API_KEY: 'd04-paynow-key',
      PAYNOW_STORE_ID: 'd04-store',
      PAYNOW_WEBHOOK_SECRETS: 'd04-webhook-secret',
      NODE_ENV: 'test',
      D1_RATE_LIMIT: { stub: true },
    } as unknown as Record<string, unknown>);
    const clientToken = await signClientJwt({
      authMethod: 'mc_client',
      mcUuid: '11111111-2222-4333-8444-555555555555',
    });
    expect(await verifyClientJwt(clientToken)).not.toBeNull();

    // A session token is not a client token (audience + authMethod + KEY differ).
    const sessionToken = await signJwt({ authMethod: 'discord', discordId: '111111111111111111' });
    expect(await verifyClientJwt(sessionToken)).toBeNull();
    // ...and the client token is not a session cookie either.
    expect(await verifyJwt(clientToken)).toBeNull();
  });

  it('client-token material minted with the SESSION secret is rejected under the split', async () => {
    __resetEnvForTests();
    initEnvFromBindings({
      JWT_SECRET: SESSION_SECRET,
      CLIENT_JWT_SECRET: CLIENT_SECRET,
      WEBPANEL_HMAC_SECRET: 'd04-hmac-secret-0123456789abcdef0123456789abcdef',
      DISCORD_CLIENT_ID: 'd04-client-id',
      DISCORD_CLIENT_SECRET: 'd04-client-secret',
      BOT_API_TOKEN: 'd04-bot-secret',
      INTERNAL_SERVICE_TOKEN: 'd04-svc-secret',
      PAYNOW_API_KEY: 'd04-paynow-key',
      PAYNOW_STORE_ID: 'd04-store',
      PAYNOW_WEBHOOK_SECRETS: 'd04-webhook-secret',
      NODE_ENV: 'test',
      D1_RATE_LIMIT: { stub: true },
    } as unknown as Record<string, unknown>);
    // The forgery: right shape, right issuer, right audience — wrong key family.
    const forged = await mintWithSessionSecret(CLIENT_JWT_AUDIENCE);
    expect(await verifyClientJwt(forged)).toBeNull();
  });

  it('shared-secret fallback still separates by audience (legacy deploys stay safe)', () => {
    __resetEnvForTests();
    initEnvFromBindings({
      JWT_SECRET: SESSION_SECRET,
      WEBPANEL_HMAC_SECRET: 'd04-hmac-secret-0123456789abcdef0123456789abcdef',
      DISCORD_CLIENT_ID: 'd04-client-id',
      DISCORD_CLIENT_SECRET: 'd04-client-secret',
      BOT_API_TOKEN: 'd04-bot-secret',
      INTERNAL_SERVICE_TOKEN: 'd04-svc-secret',
      PAYNOW_API_KEY: 'd04-paynow-key',
      PAYNOW_STORE_ID: 'd04-store',
      PAYNOW_WEBHOOK_SECRETS: 'd04-webhook-secret',
      NODE_ENV: 'test',
      D1_RATE_LIMIT: { stub: true },
    } as unknown as Record<string, unknown>);
    // No throw: the fallback keeps existing deploys signing/verifying.
    expect(env.clientJwtSecret).toBe(SESSION_SECRET);
  });
});
