import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Panel-service exemption (2026-08-31): with NO ACTOR_TOKEN_MAP configured (the current
 * production state), the shared bot token resolves to the trusted "panel-service" pipe,
 * which is exempt from the staff role gates — the webpanel session-gates its own users.
 * Lives in its own file because env is process-cached (initEnvFromBindings is a no-op on
 * a second call within one module registry).
 */
const { sent } = vi.hoisted(() => ({ sent: [] as Array<{ type: string; payload: Record<string, unknown> }> }));
vi.mock('../db/redis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/redis.js')>();
  
  return {
    ...actual,
    sendCommandWithResponse: vi.fn(async (type: string, payload: Record<string, unknown>) => {
      sent.push({ type, payload });
      return { status: 'OK', data: null };
    }),
  };
});

import { createApp } from '../app.js';
import { initEnvFromBindings } from '../env.js';


describe('panel-service exemption', () => {
  it('the unconfigured (panel-service) identity can punish and is named in the dispatch', async () => {
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
      D1_RATE_LIMIT: { stub: true },
    } as unknown as Record<string, unknown>);
    const app = createApp();
    const res = await app.request('/api/admin/punish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bot-Token': 'test-bot-token' },
      body: JSON.stringify({ target: 'griefos', action: 'ban', reason: 'test' }),
    });
    expect(res.status).toBe(200);
    const cmd = sent.find((c) => c.type === 'PUNISH_PLAYER');
    expect(cmd?.payload.actor).toBe('panel-service');
  });
});
