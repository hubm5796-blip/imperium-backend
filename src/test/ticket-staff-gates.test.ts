import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Ticket staff gates (B-12 + X-03 + B-40):
 *   - GET /api/tickets: staff (helper+) sees all; a non-staff session is
 *     scoped to its own uuid; no identity at all → 403 (never a full dump).
 *   - POST /api/tickets/:id/respond: mod+ only, status allowlisted,
 *     responded_by carries the attributed staff actor, unknown ticket → 404.
 *   - Discord /ticket reply: the backend LuckPerms lookup (requireStaff) is
 *     the gate — a user WITHOUT the Discord staff role but WITH backend
 *     helper perms passes; a user with neither is refused.
 */
const { queries } = vi.hoisted(() => ({ queries: [] as Array<{ sql: string; params: unknown[] }> }));
vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    getUuidByDiscordId: vi.fn(async (discordId: string) =>
      discordId === '111111111111111111'
        ? 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        : discordId === '333333333333333333'
          ? '33333333-3333-3333-3333-333333333333'
          : null,
    ),
    query: vi.fn(async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes('luckperms_players')) {
        // The staff gate's linked-role lookup: uuid A is staff, others are not.
        const uuid = String(params[0] ?? '');
        return { rows: [{ primary_group: uuid === 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' ? 'admin' : 'default' }] };
      }
      if (sql.startsWith('UPDATE support_tickets')) {
        return params[3] === 'known-ticket' ? { rows: [{ id: 'known-ticket' }] } : { rows: [] };
      }
      if (sql.includes('COUNT(*)')) return { rows: [{ count: '1' }] };
      return { rows: [{ id: 't1', uuid: 'x', username: 'x', category: 'general', subject: 's', status: 'open', priority: 'normal', staff_response: null, responded_at: null, created_at: new Date() }] };
    }),
  };
});

import { createApp } from '../app.js';
import { initEnvFromBindings } from '../env.js';
import { signJwt } from '../auth/jwt.js';

let app: ReturnType<typeof createApp>;

async function discordSessionCookie(discordId: string): Promise<string> {
  const jwt = await signJwt({ authMethod: 'discord', discordId });
  return `imperium_session=${jwt}`;
}

describe('v1 ticket staff gates', () => {
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
      D1_RATE_LIMIT: { stub: true },
    } as unknown as Record<string, unknown>);
    app = createApp();
  });

  it('staff session (linked LuckPerms mod) lists ALL tickets — no uuid filter', async () => {
    queries.length = 0;
    const cookie = await discordSessionCookie('111111111111111111');
    const res = await app.request('/api/tickets', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const listQuery = queries.find((q) => q.sql.includes('FROM support_tickets') && q.sql.includes('LIMIT'));
    expect(listQuery?.sql).not.toContain('uuid = $');
  });

  it('non-staff session is scoped to its own uuid (WHERE uuid = $n)', async () => {
    queries.length = 0;
    const cookie = await discordSessionCookie('333333333333333333');
    const res = await app.request('/api/tickets', { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const listQuery = queries.find((q) => q.sql.includes('FROM support_tickets') && q.sql.includes('LIMIT'));
    expect(listQuery?.sql).toContain('uuid = $');
    expect(listQuery?.params).toContain('33333333-3333-3333-3333-333333333333');
  });

  it('unlinked non-staff session with no identity → 403, never a full dump', async () => {
    const cookie = await discordSessionCookie('222222222222222222');
    const res = await app.request('/api/tickets', { headers: { Cookie: cookie } });
    expect(res.status).toBe(403);
  });

  it('respond is mod+ — a plain linked player session is refused (403)', async () => {
    queries.length = 0;
    const cookie = await discordSessionCookie('333333333333333333');
    const res = await app.request('/api/tickets/known-ticket/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ response: 'handled' }),
    });
    expect(res.status).toBe(403);
    expect(queries.find((q) => q.sql.startsWith('UPDATE support_tickets'))).toBeUndefined();
  });

  it('staff session responds: attributed actor in responded_by, status allowlisted, 404 on unknown ticket', async () => {
    queries.length = 0;
    const cookie = await discordSessionCookie('111111111111111111');
    const ok = await app.request('/api/tickets/known-ticket/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ response: 'handled' }),
    });
    expect(ok.status).toBe(200);
    const update = queries.find((q) => q.sql.startsWith('UPDATE support_tickets'));
    expect(update?.params[1]).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'); // attributed actor
    expect(update?.params[2]).toBe('responded');

    const badStatus = await app.request('/api/tickets/known-ticket/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ response: 'handled', status: 'nonsense-state' }),
    });
    expect(badStatus.status).toBe(400);

    const missing = await app.request('/api/tickets/no-such-ticket/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ response: 'handled' }),
    });
    expect(missing.status).toBe(404);
  });

  it('unauthenticated caller cannot list or respond (401)', async () => {
    expect((await app.request('/api/tickets')).status).toBe(401);
    expect(
      (
        await app.request('/api/tickets/known-ticket/respond', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ response: 'x' }),
        })
      ).status,
    ).toBe(401);
  });
});

/* ── Discord /ticket command: requireStaff is the gate (B-40) ─────────────── */

const { shim } = vi.hoisted(() => {
  return {
    shim: {
      user: { id: '111111111111111111' },
      memberRoles: [] as string[],
      subcommandName: 'reply',
      options: {
        getString: (name: string) => (name === 'id' ? 'known-ticket' : name === 'text' ? 'a reply' : undefined),
      },
      deferReply: vi.fn(async (_opts?: unknown) => {}),
      editReply: vi.fn(async (_payload?: { embeds?: Array<{ data?: { title?: string; description?: string } }> }) => {}),
    },
  };
});
vi.mock('../bot/apiClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../bot/apiClient.js')>();
  return {
    ...actual,
    getProfile: vi.fn(async () => ({
      ok: true,
      status: 200,
      data: { uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', username: 'Staffer' },
    })),
    getPermissions: vi.fn(async () => ({
      ok: true,
      status: 200,
      data: { isAdmin: false, isMod: false, isHelper: true },
    })),
    appendTicketNoteV2: vi.fn(async () => ({ ok: true, status: 201, data: { appended: true } })),
    listTicketsV2: vi.fn(async () => ({ ok: true, status: 200, data: { tickets: [] } })),
    createTicketV2: vi.fn(async () => ({ ok: true, status: 201, data: { id: '1', status: 'open' } })),
  };
});
vi.mock('../bot/cronConfig.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../bot/cronConfig.js')>();
  return {
    ...actual,
    getCronConfig: () => ({
      ...(typeof actual.getCronConfig === 'function' ? {} : {}),
      botToken: 'test-bot-token',
      ticketEnabled: true,
      ticketCategoryId: '123456789012345678',
      ticketStaffRoleId: '999999999999999999',
    }),
  };
});

describe('discord /ticket staff gate (B-40)', () => {
  it('passes without the Discord staff role when backend LuckPerms says helper (requireStaff is the gate)', async () => {
    const { ticketCommand } = await import('../bot/commands/ticket.js');
    // memberRoles is EMPTY — the Discord role check would refuse; requireStaff must let it through.
    await ticketCommand.execute(shim as never);
    const { appendTicketNoteV2 } = await import('../bot/apiClient.js');
    expect(appendTicketNoteV2).toHaveBeenCalledWith('known-ticket', 'staff', expect.stringContaining('a reply'));
  });

  it('refuses when the backend permission lookup denies (no Discord role AND no LuckPerms staff group)', async () => {
    const apiClient = await import('../bot/apiClient.js');
    vi.mocked(apiClient.getPermissions).mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { isAdmin: false, isMod: false, isHelper: false },
    } as never);
    const { ticketCommand } = await import('../bot/commands/ticket.js');
    shim.editReply.mockClear();
    await ticketCommand.execute(shim as never);
    const call = vi.mocked(shim.editReply).mock.calls[0];
    expect(call?.[0]?.embeds?.[0]?.data?.description).toContain('Staff only');
  });
});
