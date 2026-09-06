/**
 * V6 02-08 — bridge contract pins: v1 compat parsing, the v2 envelope, and
 * route-level auth behavior (B-C22: wrong-length bearers must 401, not crash
 * timingSafeEqual with a RangeError/500).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { parseBridgeBody, bridgeApi } from '../bot/bridge.js';
import { __resetEnvForTests, initEnvFromBindings } from '../env.js';

const BRIDGE_SECRET = 'bridge-secret-0123456789abcdef';

function initBridgeEnv(withWebhook: boolean): void {
  __resetEnvForTests();
  initEnvFromBindings({
    JWT_SECRET: 'test-jwt-secret-0123456789abcdef',
    DISCORD_CLIENT_ID: '1',
    DISCORD_CLIENT_SECRET: 'x',
    WEBPANEL_HMAC_SECRET: 'test-hmac-secret',
    PAYNOW_API_KEY: 'pk_test',
    PAYNOW_STORE_ID: '1',
    PAYNOW_WEBHOOK_SECRETS: 'whsec_test',
    BRIDGE_SECRET: BRIDGE_SECRET,
    ...(withWebhook ? { BRIDGE_WEBHOOK_URL: 'https://discord.example/webhook' } : {}),
  });
}

beforeEach(() => {
  // Default: secret configured but no webhook URL (bridge enabled check comes
  // AFTER auth, so auth behavior is testable without stubbing fetch).
  initBridgeEnv(false);
});

describe('bridge payload parsing', () => {
  it('v1 body maps to a chat event', () => {
    const e = parseBridgeBody({ player: 'Sextus', rank: 'X', message: 'hello' });
    expect(e).toEqual({ kind: 'chat', player: 'Sextus', rank: 'X', message: 'hello', uuid: undefined });
  });

  it('v2 envelope passes the typed event through', () => {
    const e = parseBridgeBody({ v: 2, event: { kind: 'rankup', player: 'Sextus', fromRank: 9, toRank: 10 } });
    expect(e).toMatchObject({ kind: 'rankup', toRank: 10 });
  });

  it('garbage is rejected (400 at the route)', () => {
    expect(parseBridgeBody({})).toBeNull();
    expect(parseBridgeBody({ v: 2 })).toBeNull();
    expect(parseBridgeBody({ player: 'x' })).toBeNull();
  });
});

describe('POST /bridge/send auth (B-C22)', () => {
  const body = JSON.stringify({ v: 2, event: { kind: 'system', message: 'hello' } });

  it('a wrong-LENGTH bearer gets 401, not a RangeError 500', async () => {
    // Shorter than the secret — pre-fix this threw inside timingSafeEqual and
    // bubbled up as an unhandled error (500).
    const res = await bridgeApi.request('/send', {
      method: 'POST',
      headers: { authorization: `Bearer ${'x'.repeat(BRIDGE_SECRET.length - 1)}`, 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(401);
    await res.json();

    // Longer than the secret — same crash class.
    const resLong = await bridgeApi.request('/send', {
      method: 'POST',
      headers: { authorization: `Bearer ${'x'.repeat(BRIDGE_SECRET.length + 7)}`, 'content-type': 'application/json' },
      body,
    });
    expect(resLong.status).toBe(401);
    await resLong.json();
  });

  it('a same-length wrong bearer still gets 401 (fail-closed, not fail-open)', async () => {
    const res = await bridgeApi.request('/send', {
      method: 'POST',
      headers: { authorization: `Bearer ${'x'.repeat(BRIDGE_SECRET.length)}`, 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(401);
  });

  it('the correct bearer passes auth (proceeds to the enabled check → 503 without webhook url)', async () => {
    const res = await bridgeApi.request('/send', {
      method: 'POST',
      headers: { authorization: `Bearer ${BRIDGE_SECRET}`, 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Bridge disabled' });
  });

  it('a missing bearer and an empty secret both 401', async () => {
    const noHeader = await bridgeApi.request('/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(noHeader.status).toBe(401);

    __resetEnvForTests();
    initEnvFromBindings({
      JWT_SECRET: 'test-jwt-secret-0123456789abcdef',
      DISCORD_CLIENT_ID: '1',
      DISCORD_CLIENT_SECRET: 'x',
      WEBPANEL_HMAC_SECRET: 'test-hmac-secret',
      PAYNOW_API_KEY: 'pk_test',
      PAYNOW_STORE_ID: '1',
      PAYNOW_WEBHOOK_SECRETS: 'whsec_test',
      // No BRIDGE_SECRET at all.
    });
    const noSecret = await bridgeApi.request('/send', {
      method: 'POST',
      headers: { authorization: `Bearer ${BRIDGE_SECRET}`, 'content-type': 'application/json' },
      body,
    });
    expect(noSecret.status).toBe(401);
  });
});
