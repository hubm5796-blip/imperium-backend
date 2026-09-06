/**
 * B-27 — legion command dispatch allowlist + structured single-token args.
 *
 * /legion/create and /legion/invite compose an in-game command string
 * (`legion create ${name}`, `legion invite ${username}`) that the plugin
 * executes. Both validated by LENGTH/presence only: a name like
 * "IX Legio leave" or "bob; legion disband" passed and traveled to the
 * plugin as extra command tokens — a parse-injection surface on a transport
 * that is otherwise sound (HMAC-signed, uuid verified).
 *
 * Post-fix gate: the verb stays a fixed literal and the single argument must
 * match the plugin's own charsets — legion names [A-Za-z0-9_]{3,16}
 * (LegionManager.createLegion's exact gate) and Minecraft usernames
 * ^\.?[A-Za-z0-9_]{3,16}$ (mcUsernameSchema shape). Anything else 400s
 * BEFORE the Redis dispatch fires.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendCommandWithResponseMock } = vi.hoisted(() => ({
  sendCommandWithResponseMock: vi.fn(),
}));

vi.mock('../db/redis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/redis.js')>();
  return {
    ...actual,
    sendCommandWithResponse: sendCommandWithResponseMock,
  };
});

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    // Linked session: attachUser resolves the discord id to this uuid.
    getUuidByDiscordId: vi.fn(async () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
  };
});

import { createApp } from '../app.js';
import { initEnvFromBindings, __resetEnvForTests } from '../env.js';
import { signJwt } from '../auth/jwt.js';

let app: ReturnType<typeof createApp>;

beforeAll(() => {
  __resetEnvForTests();
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
  app = createApp();
});

beforeEach(() => {
  sendCommandWithResponseMock.mockReset().mockResolvedValue({ ok: true, data: null });
});

async function post(path: string, body: Record<string, unknown>): Promise<Response> {
  const jwt = await signJwt({ authMethod: 'discord', discordId: '111111111111111111' });
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: `imperium_session=${jwt}` },
    body: JSON.stringify(body),
  });
}

describe('B-27: legion dispatch allowlist', () => {
  it('a clean legion name dispatches exactly the fixed verb + single token', async () => {
    const res = await post('/api/legion/create', { name: 'IX_Legio' });
    expect(res.status).toBe(200);
    expect(sendCommandWithResponseMock).toHaveBeenCalledWith('DISPATCH_COMMAND', {
      command: 'legion create IX_Legio',
      uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    }, 5_000);
  });

  it('names with spaces (extra command tokens) are rejected before dispatch', async () => {
    for (const name of ['IX Legio', 'IX  Legio leave', 'IX;legion disband', 'legion create nope']) {
      sendCommandWithResponseMock.mockClear();
      const res = await post('/api/legion/create', { name });
      expect(res.status, `name "${name}"`).toBe(400);
      expect(sendCommandWithResponseMock).not.toHaveBeenCalled();
    }
  });

  it('names outside the plugin charset or length (3-16) are rejected', async () => {
    for (const name of ['ab', 'x'.repeat(17), 'has-dash', 'has.dot', '', 'has slash', '<bold>']) {
      sendCommandWithResponseMock.mockClear();
      const res = await post('/api/legion/create', { name });
      expect(res.status, `name "${name}"`).toBe(400);
      expect(sendCommandWithResponseMock).not.toHaveBeenCalled();
    }
  });

  it('a well-formed username (Java or Bedrock .name) dispatches the invite', async () => {
    for (const username of ['Steve', 'xX_Miner_Xx', '.Steve']) {
      sendCommandWithResponseMock.mockClear();
      const res = await post('/api/legion/invite', { username });
      expect(res.status, `username "${username}"`).toBe(200);
      expect(sendCommandWithResponseMock).toHaveBeenCalledWith('DISPATCH_COMMAND', {
        command: `legion invite ${username}`,
        uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      }, 5_000);
    }
  });

  it('usernames with spaces, quotes, or command tokens are rejected before dispatch', async () => {
    for (const username of ['', 'Two Words', 'bob; legion disband', '"quoted"', 'x'.repeat(17), 'na--me', 'user\\name']) {
      sendCommandWithResponseMock.mockClear();
      const res = await post('/api/legion/invite', { username });
      expect(res.status, `username "${username}"`).toBe(400);
      expect(sendCommandWithResponseMock).not.toHaveBeenCalled();
    }
  });
});
