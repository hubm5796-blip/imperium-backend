/**
 * B-C31 — first-link reward dispatch on /api/link/confirm.
 *
 * Pre-fix: the confirm route persisted the Discord↔Minecraft link and stopped
 * there — the plugin's grantFirstLinkReward (25,000 Denarius + 1 Crate Key)
 * was NEVER triggered from the web/bot linking flow, so linking granted 0
 * in-game rewards.
 *
 * Post-fix contract under test:
 *   1. A FIRST link (upsertDiscordLink's inserted signal = true) dispatches
 *      exactly one CONFIRM_DISCORD_LINK over the signed Redis bus with the
 *      payload { player_uuid, discord_id } the plugin handler consumes.
 *   2. A RE-link (inserted = false) dispatches NOTHING — the reward cannot be
 *      farmed by re-confirming.
 *   3. A dispatch failure (plugin offline / ERROR ack) does NOT fail the
 *      confirm: the link row is already persisted and the code was
 *      single-use-consumed, so a bot retry would 404 and the player would be
 *      told an error for a link that actually succeeded.
 *
 * db/pool + db/redis are mocked (no Postgres/Redis in CI); the route runs
 * end-to-end through Hono's api.request.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  sendCommandWithResponseMock,
  consumeLinkCodeMock,
  upsertDiscordLinkMock,
  isAlreadyLinkedMock,
  getNameByUuidMock,
  fakeD1,
} = vi.hoisted(() => {
  /** Minimal D1 fake: the D1-backed global rate limiter needs first() to
   * resolve instead of throwing a TypeError (same shape as paynow tests). */
  const fakeD1 = {
    prepare() {
      const runFor = () => ({ run: async () => ({ meta: { changes: 1 } }), first: async () => null });
      return { bind: () => runFor(), ...runFor() };
    },
  };
  return {
    sendCommandWithResponseMock: vi.fn(),
    consumeLinkCodeMock: vi.fn(),
    upsertDiscordLinkMock: vi.fn(),
    isAlreadyLinkedMock: vi.fn(),
    getNameByUuidMock: vi.fn(),
    fakeD1,
  };
});

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    getD1: () => fakeD1,
    upsertDiscordLink: upsertDiscordLinkMock,
    isAlreadyLinked: isAlreadyLinkedMock,
    getNameByUuid: getNameByUuidMock,
  };
});

vi.mock('../db/redis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/redis.js')>();
  return {
    ...actual,
    consumeLinkCode: consumeLinkCodeMock,
    sendCommandWithResponse: sendCommandWithResponseMock,
  };
});

import { __resetEnvForTests, initEnvFromBindings } from '../env.js';

const UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const DISCORD_ID = '123456789012345678';

beforeAll(() => {
  __resetEnvForTests();
  initEnvFromBindings({
    JWT_SECRET: 'test-jwt-secret-0123456789abcdef',
    DISCORD_CLIENT_ID: '1',
    DISCORD_CLIENT_SECRET: 'x',
    WEBPANEL_HMAC_SECRET: 'test-hmac-secret',
    PAYNOW_API_KEY: 'pk_test',
    PAYNOW_STORE_ID: '1',
    PAYNOW_WEBHOOK_SECRETS: 'whsec_test',
    BOT_API_TOKEN: 'bot-token-test',
  });
});

beforeEach(() => {
  sendCommandWithResponseMock.mockReset();
  consumeLinkCodeMock.mockReset();
  upsertDiscordLinkMock.mockReset();
  isAlreadyLinkedMock.mockReset();
  getNameByUuidMock.mockReset();
  // Defaults: web-flow code record carrying both identities, no prior link,
  // a fresh insert, a reachable plugin, and a resolvable username.
  consumeLinkCodeMock.mockResolvedValue({ uuid: UUID, discordId: DISCORD_ID });
  isAlreadyLinkedMock.mockResolvedValue(null);
  upsertDiscordLinkMock.mockResolvedValue(true);
  sendCommandWithResponseMock.mockResolvedValue({ ok: true, status: 'OK', request_id: 'req_1' });
  getNameByUuidMock.mockResolvedValue('TestPlayer');
});

let requestSeq = 0;

async function postConfirm(body: Record<string, unknown>): Promise<Response> {
  const { api } = await import('../api/routes.js');
  requestSeq += 1;
  return api.request('/link/confirm', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-bot-token': 'bot-token-test',
      // distinct IP per request so the global D1 rate limiter never trips
      'cf-connecting-ip': `198.51.100.${100 + requestSeq}`,
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/link/confirm — B-C31 first-link reward dispatch', () => {
  it('a FIRST link dispatches exactly one CONFIRM_DISCORD_LINK with {player_uuid, discord_id}', async () => {
    const res = await postConfirm({ code: 'ABC123' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; rewardDispatched?: boolean };
    expect(body.ok).toBe(true);
    expect(body.rewardDispatched).toBe(true);

    expect(sendCommandWithResponseMock).toHaveBeenCalledTimes(1);
    const [type, payload, timeoutMs] = sendCommandWithResponseMock.mock.calls[0]!;
    expect(type).toBe('CONFIRM_DISCORD_LINK');
    // Exact payload shape the plugin-side handler consumes — no extra fields
    // to version-gate, no missing fields to NPE on.
    expect(payload).toEqual({ player_uuid: UUID, discord_id: DISCORD_ID });
    expect(timeoutMs).toBeLessThanOrEqual(10_000); // bounded — never hangs the confirm
  });

  it('a RE-link (upsert updated an existing row) dispatches NOTHING', async () => {
    isAlreadyLinkedMock.mockResolvedValue(DISCORD_ID); // already linked to the same Discord
    upsertDiscordLinkMock.mockResolvedValue(false); // ON CONFLICT DO UPDATE — not a first link
    const res = await postConfirm({ code: 'ABC123' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; rewardDispatched?: boolean };
    expect(body.ok).toBe(true);
    expect(body.rewardDispatched).toBe(false);
    expect(sendCommandWithResponseMock).not.toHaveBeenCalled();
  });

  it('a dispatch failure (plugin offline) does NOT fail the confirm — the link is already persisted', async () => {
    sendCommandWithResponseMock.mockRejectedValue(new Error('Timed out waiting for response'));
    const res = await postConfirm({ code: 'ABC123' });
    // The upsert succeeded and the code was single-use-consumed: a 500 would
    // make the bot report failure for a link that actually succeeded, and the
    // player's retry would be a 404 (code gone) — the link must answer ok.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; linked?: boolean; rewardDispatched?: boolean };
    expect(body.ok).toBe(true);
    expect(body.linked).toBe(true);
    expect(body.rewardDispatched).toBe(false);
  });

  it('a plugin-side ERROR ack keeps the confirm ok but flags the reward as not dispatched', async () => {
    sendCommandWithResponseMock.mockResolvedValue({ ok: false, status: 'ERROR', error: 'player offline', request_id: 'req_2' });
    const res = await postConfirm({ code: 'ABC123' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok?: boolean; rewardDispatched?: boolean };
    expect(body.ok).toBe(true);
    expect(body.rewardDispatched).toBe(false);
  });

  it('the in-game flow (code record without a discord id) dispatches with the bot-supplied discord id', async () => {
    consumeLinkCodeMock.mockResolvedValue({ uuid: UUID }); // in-game /link code: uuid only
    upsertDiscordLinkMock.mockResolvedValue(true);
    const res = await postConfirm({ code: 'XYZ789', discordId: DISCORD_ID });
    expect(res.status).toBe(200);
    expect(sendCommandWithResponseMock).toHaveBeenCalledTimes(1);
    const [, payload] = sendCommandWithResponseMock.mock.calls[0]!;
    expect(payload).toEqual({ player_uuid: UUID, discord_id: DISCORD_ID });
  });
});
