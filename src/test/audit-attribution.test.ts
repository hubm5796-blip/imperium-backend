import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Audit attribution + role gates (2026-08-31). Exercises the real Hono app:
 *   - /admin/punish is mod+ (service identities other than the trusted panel pipe are refused)
 *   - /admin/reload is admin+
 *   - /admin/broadcast is helper+
 *   - per-staff tokens (STAFF_ACTOR_TOKEN_MAP: "token:name:role") raise the caller's role and
 *     name the human in the dispatched payload
 * The Redis command bus is mocked so allowed-path tests assert the actor travels with the
 * dispatch instead of touching a real bus.
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
import { sendCommandWithResponse } from '../db/redis.js';

let app: ReturnType<typeof createApp>;

const BOT = { 'X-Bot-Token': 'test-bot-token' };
const punishBody = { target: 'griefos', action: 'ban', reason: 'test' };

describe('audit attribution role gates', () => {
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
      // The shared bot token maps to a NAMED service identity (not panel-service) — its default
      // role is helper, which lets us prove the role gates actually refuse.
      ACTOR_TOKEN_MAP: 'test-bot-token:legacy-service',
      // Per-staff tokens with roles.
      STAFF_ACTOR_TOKEN_MAP: 'stafftok1:SenatorBrukus:mod,stafftok2:ConsulMaximus:admin',
      D1_RATE_LIMIT: { stub: true },
    } as unknown as Record<string, unknown>);
    app = createApp();
  });

  it('refuses punish for a below-mod service identity (403)', async () => {
    (sendCommandWithResponse as ReturnType<typeof vi.fn>).mockClear();
    const res = await app.request('/api/admin/punish', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...BOT },
      body: JSON.stringify(punishBody),
    });
    expect(res.status).toBe(403);
    expect(sent.find((c) => c.type === 'PUNISH_PLAYER')).toBeUndefined();
  });

  it('refuses reload for a below-admin identity (403)', async () => {
    const res = await app.request('/api/admin/reload', { method: 'POST', headers: BOT });
    expect(res.status).toBe(403);
  });

  it('allows broadcast for a helper identity and names the actor in the dispatch', async () => {
    const res = await app.request('/api/admin/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...BOT },
      body: JSON.stringify({ message: 'Hail, Rome' }),
    });
    expect(res.status).toBe(200);
    const cmd = sent.find((c) => c.type === 'BROADCAST');
    expect(cmd?.payload.actor).toBe('legacy-service');
  });

  it('a per-staff mod token can punish and the human name rides the dispatch', async () => {
    const res = await app.request('/api/admin/punish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...BOT,
        'X-Staff-Token': 'stafftok1',
        'X-Staff-Actor': 'SenatorBrukus',
      },
      body: JSON.stringify(punishBody),
    });
    expect(res.status).toBe(200);
    const cmd = sent.find((c) => c.type === 'PUNISH_PLAYER');
    expect(cmd?.payload.actor).toBe('SenatorBrukus');
  });

  it('a per-staff admin token can reload', async () => {
    const res = await app.request('/api/admin/reload', {
      method: 'POST',
      headers: { ...BOT, 'X-Staff-Token': 'stafftok2', 'X-Staff-Actor': 'ConsulMaximus' },
    });
    expect(res.status).toBe(200);
  });

  it('a staff header pair that is not bound is refused like an unranked identity (403)', async () => {
    const res = await app.request('/api/admin/punish', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...BOT,
        'X-Staff-Token': 'forged-token',
        'X-Staff-Actor': 'SenatorBrukus',
      },
      body: JSON.stringify(punishBody),
    });
    expect(res.status).toBe(403);
  });
});

