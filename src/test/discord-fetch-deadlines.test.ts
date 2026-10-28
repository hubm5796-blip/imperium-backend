import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

// Every outbound Discord call carries a deadline. Without one, a hung Discord
// holds the request (OAuth callback, slash-command reply, registration) until
// the Worker is killed.
vi.mock('../db/redis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/redis.js')>();
  return { ...actual, claimNonceOnce: vi.fn(async () => true) };
});

import { createApp } from '../app.js';
import { initEnvFromBindings } from '../env.js';
import { exchangeCodeForToken, fetchDiscordUser } from '../auth/discord.js';
import { InteractionShim } from '../bot/interactionShim.js';

const SECRET = 'test-hmac-secret-0123456789abcdef0123456789abcdef';
const calls: Array<{ url: string; init?: RequestInit }> = [];

function stubFetch(body: unknown): void {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
}

function expectDeadline(urlPart: string): void {
  const call = calls.find((x) => x.url.includes(urlPart));
  expect(call, `no fetch to ${urlPart}`).toBeDefined();
  expect(call!.init?.signal).toBeInstanceOf(AbortSignal);
  expect(call!.init!.signal!.aborted).toBe(false);
}

beforeAll(() => {
  initEnvFromBindings({
    JWT_SECRET: 'test-jwt-secret-0123456789abcdef0123456789abcdef',
    WEBPANEL_HMAC_SECRET: SECRET,
    DISCORD_CLIENT_ID: 'test-client-id',
    DISCORD_CLIENT_SECRET: 'test-client-secret',
    DISCORD_BOT_TOKEN: 'test-discord-bot-token',
    BOT_API_TOKEN: 'test-bot-token',
    PAYNOW_API_KEY: 'test-paynow-key',
    PAYNOW_STORE_ID: 'test-store',
    PAYNOW_WEBHOOK_SECRETS: 'test-webhook-secret',
    NODE_ENV: 'test',
  } as unknown as Record<string, unknown>);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Discord fetch deadlines', () => {
  it('OAuth token exchange', async () => {
    stubFetch({ access_token: 'a', token_type: 'Bearer', expires_in: 1, refresh_token: 'r', scope: 'identify' });
    await exchangeCodeForToken('code');
    expectDeadline('/oauth2/token');
  });

  it('OAuth /users/@me', async () => {
    stubFetch({ id: '1', username: 'u' });
    await fetchDiscordUser('token');
    expectDeadline('/users/@me');
  });

  it('slash-command registration PUT', async () => {
    stubFetch([]);
    const ts = Math.floor(Date.now() / 1000);
    const nonce = 'deadline-nonce';
    const sig = createHmac('sha256', SECRET).update(`${ts}|${nonce}`).digest('hex');
    const res = await createApp().request('/api/admin/bot/register-commands', {
      method: 'POST',
      headers: { 'X-Timestamp': String(ts), 'X-Nonce': nonce, 'X-Signature': sig },
    });
    expect(res.status).toBe(200);
    expectDeadline('/applications/test-client-id/commands');
  });

  it('interaction followup POST and editReply PATCH', async () => {
    stubFetch({});
    const shim = new InteractionShim({ id: '1', token: 'itok', application_id: 'app', type: 2, data: { name: 'x' } }, 'bot');
    await shim.deferReply();
    await shim.reply({ content: 'second' });
    await shim.editReply({ content: 'edit' });
    expect(calls.map((x) => x.init?.method)).toEqual(['POST', 'PATCH']);
    for (const call of calls) {
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    }
  });
});
