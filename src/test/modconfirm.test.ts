import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B-22 — moderation confirmations:
 *   1. Nonces are CSPRNG (crypto.randomUUID), not the Math.random+timestamp
 *      concat a forger could enumerate.
 *   2. Consume re-runs the staff gate (TOCTOU): a rank drop between the
 *      button request and the click voids the punishment.
 *   3. Missing/expired nonces get an explanatory embed, not a silent ack
 *      (post-isolate-recycle clicks used to no-op with the user told nothing).
 *   4. Single-use: the second click on the same nonce explains itself.
 *   5. A click from anyone but the initiator is refused (ephemeral).
 *
 * apiClient + db/pool are mocked (the backend bus never runs); Discord REST
 * (shim editReply/reply followups) goes through a stubbed global fetch.
 */

const { profileByDiscord, permsByDiscord, punishCalls } = vi.hoisted(() => ({
  profileByDiscord: new Map<string, { ok: true; data: { uuid: string; username: string } } | { ok: false }>(),
  permsByDiscord: new Map<string, { ok: true; data: { isAdmin: boolean; isMod: boolean; isHelper: boolean } } | { ok: false }>(),
  punishCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock('../bot/apiClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../bot/apiClient.js')>();
  return {
    ...actual,
    getProfile: vi.fn(async (q: { discordId?: string }) => {
      const key = q.discordId ?? '';
      return profileByDiscord.get(key) ?? { ok: false as const };
    }),
    getPermissions: vi.fn(async (discordId: string) => {
      return permsByDiscord.get(discordId) ?? { ok: false as const };
    }),
    punishAdmin: vi.fn(async (payload: Record<string, unknown>) => {
      punishCalls.push(payload);
      return { ok: true as const, data: { result: 'applied by plugin' } };
    }),
  };
});

// Breaks the import cycle test → moderation → apiClient → app → commands →
// moderation (the in-flight module's exports read as undefined inside
// commands/index.ts otherwise). apiClient's real module never runs createApp
// at load time; this only stops the chain from pulling the whole app in.
vi.mock('../app.js', () => ({
  createApp: vi.fn(() => ({ request: vi.fn() })),
}));

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    // bot_mod_log ledger writes — succeed, return an id for the UPDATE path.
    query: vi.fn(async (sql: string) => {
      if (sql.startsWith('INSERT INTO bot_mod_log')) return { rows: [{ id: '42' }] };
      return { rows: [] };
    }),
  };
});

import { InteractionShim, type RawInteraction } from '../bot/interactionShim.js';
import { banCommand, consumeModConfirm, tempbanCommand } from '../bot/commands/moderation.js';

const MOD_ID = '900000000000000001';
const OTHER_ID = '900000000000000002';
const MOD_PROFILE = { uuid: 'actor-uuid-mod', username: 'ActorMod' };

/** Captured Discord REST calls made by the shim (editReply PATCH / reply POST). */
let restCalls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];

beforeEach(() => {
  restCalls = [];
  punishCalls.length = 0;
  profileByDiscord.clear();
  permsByDiscord.clear();
  profileByDiscord.set(MOD_ID, { ok: true, data: MOD_PROFILE });
  permsByDiscord.set(MOD_ID, { ok: true, data: { isAdmin: false, isMod: true, isHelper: true } });
  permsByDiscord.set(OTHER_ID, { ok: true, data: { isAdmin: false, isMod: false, isHelper: true } });
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    restCalls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }));
});

function commandInteraction(userId: string): InteractionShim {
  const raw: RawInteraction = {
    id: 'i1',
    token: 'tok',
    application_id: 'app',
    type: 2,
    data: {
      name: 'tempban',
      options: [
        { name: 'name', type: 3, value: 'griefer01' },
        { name: 'duration', type: 3, value: '7d' },
        { name: 'reason', type: 3, value: 'xray, confessed' },
      ],
    },
    member: { user: { id: userId, username: 'moderator' }, roles: [] },
    guild_id: 'g',
  };
  return new InteractionShim(raw, 'bot-token');
}

function componentInteraction(userId: string, nonce: string): InteractionShim {
  const raw: RawInteraction = {
    id: 'i2',
    token: 'tok2',
    application_id: 'app',
    type: 3,
    data: { name: 'button-click', custom_id: `modconfirm:${nonce}` },
    member: { user: { id: userId, username: 'moderator' }, roles: [] },
    guild_id: 'g',
  };
  return new InteractionShim(raw, 'bot-token');
}

/** Runs the command, returns the nonce embedded in the confirm button. */
async function requestConfirm(command: typeof tempbanCommand, userId = MOD_ID): Promise<string> {
  const shim = commandInteraction(userId);
  await command.execute(shim);
  const patch = restCalls.find((c) => c.method === 'PATCH');
  expect(patch, 'confirm message PATCH').toBeDefined();
  const components = patch!.body.components as Array<{
    components: Array<{ custom_id: string }>;
  }>;
  const customId = components?.[0]?.components?.[0]?.custom_id as string;
  expect(customId).toMatch(/^modconfirm:/);
  return customId.slice('modconfirm:'.length);
}

describe('B-22 moderation confirmations', () => {
  it('uses a CSPRNG nonce (uuid-shaped, not the Math.random concat)', async () => {
    const nonce = await requestConfirm(tempbanCommand);
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  it('expired/unknown nonce explains itself instead of silently acking', async () => {
    const shim = componentInteraction(MOD_ID, 'ffffffffffffffffffffffffffffffff');
    await consumeModConfirm('ffffffffffffffffffffffffffffffff', shim);
    expect(shim.deferred || shim.replied).toBe(true);
    const patch = restCalls.find((c) => c.method === 'PATCH');
    expect(patch).toBeDefined();
    const embeds = patch!.body.embeds as Array<{ description?: string }>;
    expect(embeds[0]?.description).toMatch(/expired or was already used/i);
  });

  it('single-use: the second click on a consumed nonce is refused', async () => {
    const nonce = await requestConfirm(tempbanCommand);
    await consumeModConfirm(nonce, componentInteraction(MOD_ID, nonce));
    expect(punishCalls).toHaveLength(1);
    await consumeModConfirm(nonce, componentInteraction(MOD_ID, nonce));
    expect(punishCalls).toHaveLength(1); // NOT dispatched twice
    const patch = restCalls.filter((c) => c.method === 'PATCH').pop();
    const embeds = patch!.body.embeds as Array<{ description?: string }>;
    expect(embeds[0]?.description).toMatch(/expired or was already used/i);
  });

  it('TOCTOU: a rank drop between request and click voids the punishment', async () => {
    // banCommand demands 'admin' — promote for the button request, demote
    // before the click: the consume-time re-check must refuse.
    permsByDiscord.set(MOD_ID, { ok: true, data: { isAdmin: true, isMod: true, isHelper: true } });
    const nonce = await requestConfirm(banCommand);
    permsByDiscord.set(MOD_ID, { ok: true, data: { isAdmin: false, isMod: true, isHelper: true } });
    await consumeModConfirm(nonce, componentInteraction(MOD_ID, nonce));
    expect(punishCalls).toHaveLength(0);
    const patch = restCalls.filter((c) => c.method === 'PATCH').pop();
    const embeds = patch!.body.embeds as Array<{ description?: string }>;
    expect(embeds[0]?.description).toMatch(/NOT applied/i);
  });

  it('a click from a different user is refused without touching the original message', async () => {
    const nonce = await requestConfirm(tempbanCommand);
    restCalls = [];
    await consumeModConfirm(nonce, componentInteraction(OTHER_ID, nonce));
    expect(punishCalls).toHaveLength(0);
    // Ephemeral followup (POST to the webhook endpoint), no PATCH of the
    // initiator's message.
    const post = restCalls.find((c) => c.method === 'POST' && c.url.includes('/webhooks/'));
    expect(post).toBeDefined();
    expect((post!.body.flags as number) & 64).toBe(64); // ephemeral
    const embeds = post!.body.embeds as Array<{ description?: string }>;
    expect(embeds[0]?.description).toMatch(/Only the staff member/i);
  });

  it('happy path: rank still valid at click time → punishment dispatches', async () => {
    const nonce = await requestConfirm(tempbanCommand);
    await consumeModConfirm(nonce, componentInteraction(MOD_ID, nonce));
    expect(punishCalls).toHaveLength(1);
    expect(punishCalls[0]).toMatchObject({ target: 'griefer01', action: 'tempban' });
    const patch = restCalls.filter((c) => c.method === 'PATCH').pop();
    const embeds = patch!.body.embeds as Array<{ title?: string; description?: string }>;
    expect(embeds[0]?.title).toMatch(/tempban applied/i);
    expect(embeds[0]?.description).toMatch(/applied by plugin/i);
  });
});
