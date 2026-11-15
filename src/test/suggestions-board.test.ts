/**
 * Q9 — the season suggestion board contract, pinned through the real app:
 * list (public, top-voted first, hidden excluded, viewer voted-flags),
 * create (identity + validation + cooldown + quota), upvote (one per
 * account, atomic score recompute, hidden 404s), moderate (staff-only
 * hide/show with an audit row).
 *
 * The D1 fake models suggestions + suggestion_votes with the exact statement
 * shapes suggestions.ts emits (same approach as guide-vote-atomic.test.ts);
 * unknown statements (rate limiter) succeed without modeling.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type SuggestionRow = { id: string; author_uuid: string; body: string; hidden: number; score: number; created_at: number };

const { fakeD1, suggestionsTable, votesTable, batchLog } = vi.hoisted(() => {
  const suggestionsTable = new Map<string, SuggestionRow>();
  /** key: `${suggestion_id}:${voter_uuid}` */
  const votesTable = new Map<string, number>();
  const batchLog: Array<Array<{ sql: string; params: unknown[] }>> = [];

  function apply(sql: string, params: unknown[]): { changes: number } {
    if (sql.includes('CREATE TABLE')) return { changes: 1 };
    if (sql.includes('INSERT INTO suggestions')) {
      const [id, uuid, body, createdAt] = params as [string, string, string, number];
      suggestionsTable.set(id, { id, author_uuid: uuid, body, hidden: 0, score: 0, created_at: Number(createdAt) });
      return { changes: 1 };
    }
    if (sql.includes('INSERT INTO suggestion_votes') && sql.includes('ON CONFLICT')) {
      const [sid, voter, createdAt] = params as [string, string, number];
      const key = `${sid}:${voter}`;
      if (votesTable.has(key)) return { changes: 0 }; // idempotent: PK conflict
      votesTable.set(key, Number(createdAt));
      return { changes: 1 };
    }
    if (sql.includes('UPDATE suggestions') && sql.includes('COUNT(*)')) {
      const [sid, sid2] = params as [string, string];
      const row = suggestionsTable.get(sid2);
      if (!row) return { changes: 0 };
      let n = 0;
      for (const key of votesTable.keys()) if (key.startsWith(`${sid}:`)) n += 1;
      row.score = n;
      return { changes: 1 };
    }
    if (sql.includes('UPDATE suggestions') && sql.includes('SET hidden = ?')) {
      const [hidden, id] = params as [number, string];
      const row = suggestionsTable.get(id);
      if (!row) return { changes: 0 };
      row.hidden = Number(hidden);
      return { changes: 1 };
    }
    return { changes: 1 }; // rate limiter etc.
  }

  function makeStmt(sql: string, params: unknown[] = []) {
    const stmt = {
      sql,
      params,
      async first() {
        if (sql.includes('SELECT id FROM suggestions WHERE id = ? AND hidden = 0')) {
          const row = suggestionsTable.get(String(params[0]));
          return row && row.hidden === 0 ? { id: row.id } : null;
        }
        if (sql.includes('SELECT id FROM suggestions WHERE author_uuid = ? AND created_at > ?')) {
          // Cooldown probe: any row by this author newer than the bound.
          const [uuid, since] = params as [string, number];
          for (const row of suggestionsTable.values()) {
            if (row.author_uuid === uuid && row.created_at > Number(since)) return { id: row.id };
          }
          return null;
        }
        return null; // rate-limiter RETURNING etc. -> caller defaults
      },
      async run() {
        return { meta: apply(sql, params) };
      },
      async all() {
        if (sql.includes('FROM suggestions WHERE hidden = 0')) {
          const rows = [...suggestionsTable.values()]
            .filter((r) => r.hidden === 0)
            .sort((a, b) => b.score - a.score || b.created_at - a.created_at)
            .slice(0, 100);
          return { results: rows.map((r) => ({ ...r })) };
        }
        if (sql.includes('SELECT COUNT(*) AS n FROM suggestions')) {
          const [uuid, since] = params as [string, number];
          let n = 0;
          for (const row of suggestionsTable.values()) {
            if (row.author_uuid === uuid && row.created_at > Number(since)) n += 1;
          }
          return { results: [{ n }] };
        }
        if (sql.includes('SELECT suggestion_id FROM suggestion_votes WHERE voter_uuid = ?')) {
          const voter = String(params[0]);
          const ids: Array<{ suggestion_id: string }> = [];
          for (const key of votesTable.keys()) {
            const [sid, v] = key.split(/:(?=[^:]*$)/);
            if (v === voter) ids.push({ suggestion_id: sid });
          }
          return { results: ids.slice(0, 500) };
        }
        return { results: [] };
      },
      bind(...next: unknown[]) {
        return makeStmt(sql, next);
      },
    };
    return stmt;
  }

  const fakeD1 = {
    prepare(sql: string) {
      return makeStmt(sql);
    },
    async batch(statements: Array<{ sql: string; params: unknown[] }>) {
      batchLog.push(statements.map((s) => ({ sql: s.sql, params: s.params })));
      return statements.map((s) => ({ meta: apply(s.sql, s.params) }));
    },
  };
  return { fakeD1, suggestionsTable, votesTable, batchLog };
});

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    getD1: () => fakeD1,
    getUuidByDiscordId: vi.fn(async () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
  };
});

import { createApp } from '../app.js';
import { initEnvFromBindings } from '../env.js';
import { signJwt } from '../auth/jwt.js';

let app: ReturnType<typeof createApp>;

const PLAYER_A = '11111111-2222-4333-8444-555555555555';
const PLAYER_B = '99999999-8888-7777-6666-555555555555';
const DELEGATED_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function delegated(uuid: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-Bot-Token': 'test-service-token',
    'X-Mc-Uuid': uuid,
  };
}

async function linkedSessionCookie(): Promise<string> {
  const jwt = await signJwt({ authMethod: 'discord', discordId: '111111111111111111' });
  return `imperium_session=${jwt}`;
}

async function create(text: string, uuid: string = PLAYER_A): Promise<Response> {
  return app.request('/api/v2/suggestions', {
    method: 'POST',
    headers: delegated(uuid),
    body: JSON.stringify({ text }),
  });
}

async function list(uuid?: string): Promise<{ status: number; body: { data?: { suggestions?: Array<{ id: string; score: number; voted: boolean; body: string }> } } }> {
  const res = await app.request('/api/v2/suggestions', {
    headers: uuid ? delegated(uuid) : {},
  });
  return { status: res.status, body: (await res.json()) as never };
}

beforeAll(() => {
  initEnvFromBindings({
    JWT_SECRET: 'test-jwt-secret-0123456789abcdef0123456789abcdef',
    WEBPANEL_HMAC_SECRET: 'test-hmac-secret-0123456789abcdef0123456789abcdef',
    DISCORD_CLIENT_ID: 'test-client-id',
    DISCORD_CLIENT_SECRET: 'test-client-secret',
    BOT_API_TOKEN: 'test-bot-token',
    INTERNAL_SERVICE_TOKEN: 'test-service-token',
    PAYNOW_API_KEY: 'test-paynow-key',
    PAYNOW_STORE_ID: 'test-store',
    PAYNOW_WEBHOOK_SECRETS: 'test-webhook-secret',
    NODE_ENV: 'test',
  } as unknown as Record<string, unknown>);
  app = createApp();
});

beforeEach(() => {
  suggestionsTable.clear();
  votesTable.clear();
  batchLog.length = 0;
});

describe('Q9 suggestions — create', () => {
  it('a linked session creates a suggestion (201, visible, not hidden)', async () => {
    const res = await app.request('/api/v2/suggestions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: await linkedSessionCookie(),
        Origin: 'https://romanica.net',
      },
      body: JSON.stringify({ text: 'Season 2 idea: a Colosseum tournament ladder' }),
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    expect(data.id).toMatch(/^s_/);
    expect(suggestionsTable.get(data.id)?.hidden).toBe(0);
  });

  it('anonymous create is 401', async () => {
    const res = await app.request('/api/v2/suggestions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'anon should not post' }),
    });
    expect(res.status).toBe(401);
  });

  it('too-short text is rejected; over-length text is capped at 300 chars', async () => {
    const short = await create('ab');
    expect(short.status).toBe(400);
    const long = await create('x'.repeat(5000), PLAYER_B);
    expect(long.status).toBe(201);
    const { data } = (await long.json()) as { data: { id: string } };
    expect(suggestionsTable.get(data.id)?.body.length).toBe(300);
  });

  it('the per-author cooldown rejects a second post inside 30 seconds', async () => {
    const first = await create('first idea', PLAYER_A);
    expect(first.status).toBe(201);
    const second = await create('second idea too fast', PLAYER_A);
    expect(second.status).toBe(429);
    // A different author is not affected.
    const other = await create('another author is fine', PLAYER_B);
    expect(other.status).toBe(201);
  });
});

describe('Q9 suggestions — list', () => {
  it('is public, top-voted first, and marks the viewer already-voted rows', async () => {
    await create('idea one', PLAYER_A);
    await create('idea two', PLAYER_B);
    const rows = [...suggestionsTable.values()];
    // Give idea one two votes, idea two one vote.
    for (const voter of [PLAYER_A, PLAYER_B]) {
      const res = await app.request(`/api/v2/suggestions/${rows[0]!.id}/upvote`, { method: 'POST', headers: delegated(voter) });
      expect(res.status).toBe(200);
    }
    await app.request(`/api/v2/suggestions/${rows[1]!.id}/upvote`, { method: 'POST', headers: delegated(PLAYER_A) });

    const anon = await list();
    expect(anon.status).toBe(200);
    const suggestions = anon.body.data!.suggestions!;
    expect(suggestions.length).toBe(2);
    expect(suggestions[0]!.body).toBe('idea one'); // score 2 first
    expect(suggestions[0]!.score).toBe(2);
    expect(anon.body.data!.suggestions![0]!.voted).toBe(false); // anon: no flags

    const asB = await list(PLAYER_B);
    const flagged = asB.body.data!.suggestions!;
    expect(flagged.find((s) => s.body === 'idea one')!.voted).toBe(true);
    expect(flagged.find((s) => s.body === 'idea two')!.voted).toBe(false);
  });

  it('hidden rows never appear', async () => {
    await create('soon hidden', PLAYER_A);
    const row = [...suggestionsTable.values()][0]!;
    row.hidden = 1; // direct table state: staff hid it
    const { body } = await list();
    expect(body.data!.suggestions!.length).toBe(0);
  });
});

describe('Q9 suggestions — upvote', () => {
  it('one vote per account: repeat upvotes are idempotent, two voters score 2', async () => {
    await create('vote me', PLAYER_A);
    const id = [...suggestionsTable.values()][0]!.id;
    const first = await app.request(`/api/v2/suggestions/${id}/upvote`, { method: 'POST', headers: delegated(PLAYER_A) });
    expect(first.status).toBe(200);
    const again = await app.request(`/api/v2/suggestions/${id}/upvote`, { method: 'POST', headers: delegated(PLAYER_A) });
    expect(again.status).toBe(200);
    expect(suggestionsTable.get(id)!.score).toBe(1);
    await app.request(`/api/v2/suggestions/${id}/upvote`, { method: 'POST', headers: delegated(PLAYER_B) });
    expect(suggestionsTable.get(id)!.score).toBe(2);
  });

  it('the vote insert and the score recompute arrive in ONE batch (B-15 discipline)', async () => {
    await create('batch me', PLAYER_A);
    const id = [...suggestionsTable.values()][0]!.id;
    await app.request(`/api/v2/suggestions/${id}/upvote`, { method: 'POST', headers: delegated(PLAYER_A) });
    const entry = batchLog.find((stmts) => stmts.some((s) => s.sql.includes('INSERT INTO suggestion_votes')));
    expect(entry).toBeDefined();
    expect(entry!.length).toBe(2);
    expect(entry![0]!.sql).toMatch(/ON CONFLICT \(suggestion_id, voter_uuid\) DO NOTHING/);
    expect(entry![1]!.sql).toMatch(/score = \(SELECT COUNT\(\*\) FROM suggestion_votes WHERE suggestion_id = \?\)/);
    expect(entry![1]!.sql).not.toMatch(/score = score \+/);
  });

  it('hidden and nonexistent suggestions 404 on upvote', async () => {
    await create('hide me', PLAYER_A);
    const row = [...suggestionsTable.values()][0]!;
    row.hidden = 1;
    const hidden = await app.request(`/api/v2/suggestions/${row.id}/upvote`, { method: 'POST', headers: delegated(PLAYER_B) });
    expect(hidden.status).toBe(404);
    const missing = await app.request('/api/v2/suggestions/s_nope/upvote', { method: 'POST', headers: delegated(PLAYER_B) });
    expect(missing.status).toBe(404);
    expect(votesTable.size).toBe(0); // no vote was written for either
  });

  it('anonymous upvote is 401', async () => {
    await create('anon vote target', PLAYER_A);
    const id = [...suggestionsTable.values()][0]!.id;
    const res = await app.request(`/api/v2/suggestions/${id}/upvote`, { method: 'POST' });
    expect(res.status).toBe(401);
  });
});

describe('Q9 suggestions — moderation', () => {
  async function moderate(id: string, hidden: boolean, headers: Record<string, string>): Promise<Response> {
    return app.request(`/api/v2/suggestions/${id}/moderate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ hidden }),
    });
  }

  it('staff (session + X-Staff-Role: admin) hides and shows; the flag drives the list', async () => {
    await create('borderline idea', PLAYER_A);
    const id = [...suggestionsTable.values()][0]!.id;
    const staffHeaders = { Cookie: await linkedSessionCookie(), 'X-Staff-Role': 'admin', Origin: 'https://romanica.net' };

    const hide = await moderate(id, true, staffHeaders);
    expect(hide.status).toBe(200);
    expect(((await hide.json()) as { data: { hidden: boolean } }).data.hidden).toBe(true);
    expect(suggestionsTable.get(id)!.hidden).toBe(1);
    expect((await list()).body.data!.suggestions!.length).toBe(0);

    const show = await moderate(id, false, staffHeaders);
    expect(show.status).toBe(200);
    expect(suggestionsTable.get(id)!.hidden).toBe(0);
    expect((await list()).body.data!.suggestions!.length).toBe(1);
  });

  it('a session without the staff header is 403; anon is 401; bad body is 400', async () => {
    await create('gate checks', PLAYER_A);
    const id = [...suggestionsTable.values()][0]!.id;
    const plain = await moderate(id, true, { Cookie: await linkedSessionCookie(), Origin: 'https://romanica.net' });
    expect(plain.status).toBe(403);
    const anon = await moderate(id, true, {});
    expect(anon.status).toBe(401);
    const bad = await moderate(id, 'yes' as unknown as boolean, { Cookie: await linkedSessionCookie(), 'X-Staff-Role': 'admin', Origin: 'https://romanica.net' });
    expect(bad.status).toBe(400);
    expect(suggestionsTable.get(id)!.hidden).toBe(0); // nothing flipped
  });

  it('moderating a nonexistent suggestion is 404', async () => {
    const res = await moderate('s_ghost', true, { Cookie: await linkedSessionCookie(), 'X-Staff-Role': 'admin', Origin: 'https://romanica.net' });
    expect(res.status).toBe(404);
  });
});
