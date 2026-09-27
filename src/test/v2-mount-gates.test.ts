import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mount-level regression (2026-09-27): a bare `use('*', requireStaffRole(...))` on a
 * sub-app that is mounted at the v2 ROOT with `v2Api.route('/', subApp)` applies to
 * every route mounted after it — adminPanel's helper gate leaked onto the DM and
 * changelog routes, so the service principal got 403 "Staff role helper or above
 * required" on surfaces B-23 explicitly delegated to it. The sub-app-isolation tests
 * in dms-gates.test.ts cannot see this; these tests mount the sub-apps in the SAME
 * ORDER as src/api/v2/index.ts and assert the boundaries hold.
 */

const { fetchCalls } = vi.hoisted(() => ({ fetchCalls: [] as Array<{ url: string; body: Record<string, unknown> }> }));

import { Hono } from 'hono';
import { __resetEnvForTests, initEnvFromBindings } from '../env.js';
import { adminPanelV2 } from '../api/v2/adminPanel.js';
import { dmApi, changelogApi } from '../api/v2/dms.js';
import type { AppContextVariables } from '../types/index.js';

const SERVICE = { 'X-Bot-Token': 'service-token-0123456789' };

function initEnv(withChannel = true): void {
  __resetEnvForTests();
  initEnvFromBindings({
    JWT_SECRET: 'test-jwt-secret-0123456789abcdef',
    DISCORD_CLIENT_ID: '1',
    DISCORD_CLIENT_SECRET: 'x',
    DISCORD_BOT_TOKEN: 'discord-bot-token',
    WEBPANEL_HMAC_SECRET: 'test-hmac-secret',
    PAYNOW_API_KEY: 'pk_test',
    PAYNOW_STORE_ID: '1',
    PAYNOW_WEBHOOK_SECRETS: 'whsec_test',
    BOT_API_TOKEN: 'bot-token-0123456789',
    INTERNAL_SERVICE_TOKEN: 'service-token-0123456789',
    ...(withChannel ? { CHANGELOG_CHANNEL_ID: '1234567890' } : {}),
  } as unknown as Record<string, unknown>);
}

/** The v2 mount, replicated in index.ts order for the three sub-apps involved. */
function buildV2() {
  type Env = { Variables: AppContextVariables };
  const app = new Hono<Env>();
  app.route('/', adminPanelV2);
  app.route('/', dmApi);
  app.route('/', changelogApi);
  return app;
}

beforeEach(() => {
  fetchCalls.length = 0;
  initEnv(true);
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    fetchCalls.push({
      url: String(url),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    return new Response(JSON.stringify({ id: 'mock' }), { status: 200 });
  }));
});

describe('v2 mount boundaries', () => {
  it('the service principal reaches changelog/post THROUGH the mount (no leaked staff gate)', async () => {
    const res = await buildV2().request('/changelog/post', {
      method: 'POST',
      headers: { ...SERVICE, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'v2 mount', changes: ['one'] }),
    });
    expect(res.status).toBe(200);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toContain('/channels/1234567890/messages');
  });

  it('the service principal reaches dm enqueue THROUGH the mount', async () => {
    // An invalid body is fine here — the point is we reach the ROUTE (400),
    // not the leaked staff gate (403 "Staff role helper or above required").
    const res = await buildV2().request('/notifications/dm', {
      method: 'POST',
      headers: { ...SERVICE, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).not.toBe(403);
  });

  it('the helper gate still guards the /admin/* surface through the mount', async () => {
    const res = await buildV2().request('/admin/anticheat/alerts', {
      headers: { ...SERVICE },
    });
    // The service principal is not staff: refused, but by the ADMIN gate — and
    // with the scoping fix the refusal stays on /admin/* instead of leaking.
    expect([401, 403]).toContain(res.status);
    if (res.status === 403) {
      expect(((await res.json()) as { error: string }).error).toContain('helper');
    }
  });

  it('changelog without a shared bot token stays 401 through the mount', async () => {
    const res = await buildV2().request('/changelog/post', {
      method: 'POST',
      headers: { 'X-Bot-Token': 'bot-token-0123456789', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'no', changes: ['one'] }),
    });
    expect(res.status).toBe(401);
  });
});
