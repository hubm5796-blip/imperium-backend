import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Offline tags equip (forward-plan 2026-09-18 item #2). The dashboard's
 * POST /api/player/tags/equip used to be online-only by plugin refusal; now the
 * plugin equips by UUID and the route must PASS ITS HONESTY FLAGS THROUGH:
 *
 *   - plugin OK with { applied:false, pending:true, active } (offline equip:
 *     persisted now, renders in chat on next join) → 200 with those exact
 *     fields — the route must not rewrite a pending equip into an error.
 *   - plugin OK with { applied:true, pending:false } (online equip) → 200 unchanged.
 *   - plugin ERROR (tag not unlocked) → 409 carrying the plugin's reason.
 *   - The dispatch payload is { uuid, tag } with the tag capped at 64 chars,
 *     uuid from the resolved principal (never the body).
 *
 * The bus is mocked (audit-attribution pattern); the app, auth gates and the
 * route under test are the real ones.
 */
const { sent } = vi.hoisted(() => ({ sent: [] as Array<{ type: string; payload: Record<string, unknown> }> }));
vi.mock('../db/redis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/redis.js')>();
  return {
    ...actual,
    sendCommandWithResponse: vi.fn(async (type: string, payload: Record<string, unknown>) => {
      sent.push({ type, payload });
      const tag = String(payload.tag ?? '');
      if (tag === 'refused') {
        return { status: 'ERROR', error: 'tag not unlocked', data: { applied: false, pending: false, reason: 'tag not unlocked' } };
      }
      const online = tag === 'online-equip';
      return {
        status: 'OK',
        data: { applied: online, pending: !online, active: online ? tag : 'centurion' },
      };
    }),
  };
});

import { createApp } from '../app.js';
import { initEnvFromBindings } from '../env.js';

let app: ReturnType<typeof createApp>;

const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const DELEGATED = { 'X-Bot-Token': 'svc-secret', 'X-Mc-Uuid': UUID };

function post(tag: string): Promise<Response> {
  return Promise.resolve(
    app.request('/api/player/tags/equip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...DELEGATED },
      body: JSON.stringify({ tag }),
    }),
  );
}

describe('POST /api/player/tags/equip — offline-capable pass-through', () => {
  beforeAll(() => {
    initEnvFromBindings({
      JWT_SECRET: 'test-jwt-secret-0123456789abcdef0123456789abcdef',
      WEBPANEL_HMAC_SECRET: 'test-hmac-secret-0123456789abcdef0123456789abcdef',
      DISCORD_CLIENT_ID: 'test-client-id',
      DISCORD_CLIENT_SECRET: 'test-client-secret',
      BOT_API_TOKEN: 'bot-secret',
      INTERNAL_SERVICE_TOKEN: 'svc-secret',
      PAYNOW_API_KEY: 'test-paynow-key',
      PAYNOW_STORE_ID: 'test-store',
      PAYNOW_WEBHOOK_SECRETS: 'test-webhook-secret',
      NODE_ENV: 'test',
      D1_RATE_LIMIT: { stub: true },
    } as unknown as Record<string, unknown>);
    app = createApp();
  });

  it('dispatches TAG_SET_ACTIVE with the principal uuid and the requested tag', async () => {
    sent.length = 0;
    const res = await post('centurion');
    expect(res.status).toBe(200);
    const cmd = sent.find((c) => c.type === 'TAG_SET_ACTIVE');
    expect(cmd?.payload).toMatchObject({ uuid: UUID, tag: 'centurion' });
  });

  it('an OFFLINE success (applied:false, pending:true) passes through as 200 — not an error', async () => {
    const res = await post('centurion');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ applied: false, pending: true, active: 'centurion' });
  });

  it('an ONLINE success (applied:true, pending:false) passes through as 200', async () => {
    const res = await post('online-equip');
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ applied: true, pending: false, active: 'online-equip' });
  });

  it('a refused equip surfaces the plugin reason as 409', async () => {
    const res = await post('refused');
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ error: 'tag not unlocked' });
  });

  it('caps the dispatched tag at 64 characters', async () => {
    sent.length = 0;
    const long = 'x'.repeat(80);
    const res = await post(long);
    expect(res.status).toBe(200);
    const cmd = sent.find((c) => c.type === 'TAG_SET_ACTIVE');
    expect(cmd?.payload.tag).toBe('x'.repeat(64));
  });
});
