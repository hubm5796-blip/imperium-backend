/**
 * B-C21 — the Discord OAuth callback is a BROWSER flow: every failure branch
 * redirects back to the frontend's /login with a machine-readable ?error=
 * code. The state-mismatch branch used to be the one exception, returning raw
 * JSON on a bare API origin. These tests pin the redirect contract
 * (Location + 302 + state cookie cleared) for each browser-facing branch.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { __resetEnvForTests, initEnvFromBindings } from '../env.js';

beforeAll(() => {
  // development mode → frontendUrl() is http://localhost:3000 (deterministic).
  __resetEnvForTests();
  initEnvFromBindings({
    JWT_SECRET: 'test-jwt-secret-0123456789abcdef',
    DISCORD_CLIENT_ID: '1',
    DISCORD_CLIENT_SECRET: 'x',
    WEBPANEL_HMAC_SECRET: 'test-hmac-secret',
    PAYNOW_API_KEY: 'pk_test',
    PAYNOW_STORE_ID: '1',
    PAYNOW_WEBHOOK_SECRETS: 'whsec_test',
  });
});

describe('GET /api/auth/discord/callback state mismatch (B-C21)', () => {
  it('redirects to /login?error=state_mismatch with 302, not raw JSON 400', async () => {
    const { api } = await import('../api/routes.js');
    const res = await api.request(
      '/auth/discord/callback?code=abc&state=attacker-state',
      {
        headers: {
          cookie: 'oauth_state=legitimate-state',
          'cf-connecting-ip': '203.0.113.9',
        },
      },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://localhost:3000/login?error=state_mismatch');
    // The single-use state cookie is cleared on the error path.
    const setCookieHeader = res.headers.getSetCookie().join('\n');
    expect(setCookieHeader).toContain('oauth_state=');
    // Must NOT be a raw JSON error body anymore.
    const body = await res.text();
    expect(body).not.toMatch(/Invalid state/);
  });

  it('still redirects when the state cookie is missing entirely', async () => {
    const { api } = await import('../api/routes.js');
    const res = await api.request('/auth/discord/callback?code=abc&state=some-state', {
      headers: { 'cf-connecting-ip': '203.0.113.10' },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://localhost:3000/login?error=state_mismatch');
  });
});
