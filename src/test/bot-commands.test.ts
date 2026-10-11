/**
 * Command-level smoke harness (2026-09-13): every registered slash command's
 * execute() must complete against the in-process app without throwing, and
 * must attempt exactly one terminal reply (editReply after defer, or reply).
 *
 * This is the "does every command actually work" sweep — it catches dead
 * imports, broken embed shapes, unhandled option parsing and handler crashes
 * that per-command unit tests miss (most commands had none).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  return { ...actual, query };
});

vi.mock('../db/redis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/redis.js')>();
  return {
    ...actual,
    getCachedJson: vi.fn(async () => null),
    setCachedJson: vi.fn(async () => undefined),
    getOnlinePlayerCount: vi.fn(async () => 7),
  };
});

import { initEnvFromBindings } from '../env.js';
import { commands } from '../bot/commands/index.js';
import { InteractionShim, type RawInteraction } from '../bot/interactionShim.js';
import { query as queryMock } from '../db/pool.js';

const USER = { id: '900000000000000001', username: 'tester', discriminator: '0001' };
const GUILD_ID = '900000000000000009';

function rawFor(name: string, options: Record<string, unknown> = {}): RawInteraction {
  return {
    id: '1',
    application_id: '2',
    token: 'tok',
    type: 2,
    version: 1,
    user: USER,
    guild_id: GUILD_ID,
    channel_id: { id: '3', type: 0 },
    data: {
      id: '4',
      name,
      type: 1,
      options: Object.entries(options).map(([n, v]) => ({ name: n, type: 3, value: String(v) })),
    },
  } as unknown as RawInteraction;
}

/** Records every outbound shim response without touching Discord REST. */
function instrumented(shim: InteractionShim) {
  const calls: Array<{ method: string; payload: unknown }> = [];
  for (const method of ['reply', 'editReply', 'deferReply'] as const) {
    const holder = shim as unknown as Record<string, unknown>;
    if (typeof holder[method] !== 'function') continue;
    holder[method] = async (payload: unknown) => {
      calls.push({ method, payload });
      if (method === 'deferReply') (shim as { deferred: boolean }).deferred = true;
      if (method === 'reply' || method === 'editReply') (shim as { replied: boolean }).replied = true;
      return { id: 'm' } as never;
    };
  }
  return calls;
}

/** db rows the commands most commonly read — keyed by SQL snippet. */
function stubRows(handlers: Array<{ match: (sql: string) => boolean; rows: unknown[] }>) {
  vi.mocked(queryMock).mockImplementation(async (sql: string) => {
    for (const h of handlers) {
      if (h.match(String(sql))) return { rows: h.rows, rowCount: h.rows.length } as never;
    }
    return { rows: [], rowCount: 0 } as never;
  });
}

beforeAll(async () => {
  initEnvFromBindings({
    JWT_SECRET: 'test-secret-that-is-at-least-32-characters!',
    WEBPANEL_HMAC_SECRET: 'test-hmac',
    DISCORD_CLIENT_ID: 'test-client-id',
    DISCORD_CLIENT_SECRET: 'test-client-secret',
    BOT_API_TOKEN: 'test-bot-token',
    PAYNOW_API_KEY: 'test-paynow-key',
    PAYNOW_STORE_ID: 'test-store',
    PAYNOW_WEBHOOK_SECRETS: 'test-webhook-secret',
    NODE_ENV: 'test',
  } as never);
});

beforeEach(() => {
  vi.mocked(queryMock).mockReset();
  stubRows([]);
});

describe('every registered command executes without throwing', () => {
  // Commands whose execute needs a linked player profile (most). The profile
  // route reads via the mocked query — the game-mysql path is unavailable in
  // tests, so the Postgres fallback answers with a plausible row.
  const PLAYER_ROWS = [
    {
      match: (sql: string) => /FROM player_balances/i.test(String(sql)),
      rows: [{ uuid: '11111111-2222-4333-8444-555555555555', currency: 'denarius', balance: '1500' }],
    },
  ];

  // Commands with REQUIRED options — fed a minimal valid option set so the
  // handler actually runs (a required-option rejection would prove nothing).
  const REQUIRED_OPTIONS: Record<string, Record<string, string>> = {
    link: { code: 'IMPERIUS-42' },
    mine: { mine: 'XLI' },
    leaderboard: { type: 'denarius' },
    lookup: { player: 'Yxrqy' },
    warn: { player: 'Yxrqy', reason: 'testing' },
    mute: { player: 'Yxrqy' },
    kick: { player: 'Yxrqy' },
    ban: { player: 'Yxrqy' },
    tempban: { player: 'Yxrqy' },
    ticket: { category: 'question', subject: 'test', body: 'test' },
  };

  for (const cmd of commands) {
    it(`/${cmd.name} completes and replies exactly once`, { timeout: 10_000 }, async () => {
      stubRows(PLAYER_ROWS);
      const shim = new InteractionShim(rawFor(cmd.name, REQUIRED_OPTIONS[cmd.name] ?? {}), 'test-token');
      const calls = instrumented(shim);

      let threw: unknown = null;
      try {
        await cmd.execute(shim);
      } catch (err) {
        threw = err;
      }

      expect(threw, `/${cmd.name} threw: ${String(threw)}`).toBeNull();
      // Exactly one TERMINAL response (reply or editReply) — a command that
      // defers but never edits leaves the user with "thinking..." forever.
      const terminals = calls.filter((c) => c.method === 'reply' || c.method === 'editReply');
      expect(terminals.length, `/${cmd.name} terminal replies: ${terminals.length} (defer=${calls.some((c) => c.method === 'deferReply')})`).toBe(1);
    });
  }
});

describe('command registration hygiene', () => {
  it('every command is uniquely named and JSON-serializable for registration', () => {
    const names = commands.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    for (const c of commands) {
      expect(() => JSON.stringify(c.toJSON())).not.toThrow();
      expect(c.toJSON().name).toBe(c.name);
    }
  });
});
