/**
 * B-15 — guide vote score must be maintained atomically.
 *
 * The old handler was a four-statement read-modify-write: SELECT existing
 * vote → INSERT/UPDATE vote → separate `UPDATE guides SET score = score + ?`.
 * Concurrent votes interleaved the read and the increment, losing updates and
 * drifting `score` off the true vote sum with nothing to reconcile it — while
 * the module header claimed the score was "maintained on the same statement
 * as the vote insert".
 *
 * These tests pin the post-fix contract through the real route:
 *   1. The vote upsert and the score maintenance arrive in ONE D1 batch()
 *      (D1 runs a batch as a transaction — the two statements can no longer
 *      interleave with another voter's pair).
 *   2. The score statement RECOMPUTES the sum from guide_votes (self-healing:
 *      any interleaving converges to the true sum), never increments from a
 *      separately-read delta.
 *   3. End-to-end over the modeled tables: N voters → score == exact sum,
 *      vote changes (including flipping to the opposite value) converge.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * In-memory model of the two D1 tables the vote path touches. The fake's
 * `prepare` recognizes exactly the statement shapes guides.ts emits and
 * applies them synchronously — batch() applies its statements in order and
 * records the call so the test can assert transactional shape.
 */
type GuideRow = { author_uuid: string; score: number };
type VoteKey = string; // `${guide_id}:${voter_uuid}`

const {
  fakeD1,
  guidesTable,
  votesTable,
  batchLog,
} = vi.hoisted(() => {
  const guidesTable = new Map<string, GuideRow>();
  const votesTable = new Map<VoteKey, number>();
  const batchLog: Array<Array<{ sql: string; params: unknown[] }>> = [];

  type Stmt = { sql: string; params: unknown[] };

  function apply(stmt: Stmt): { changes: number } {
    const { sql, params } = stmt;
    if (sql.includes('CREATE TABLE')) return { changes: 1 };
    if (sql.includes('SELECT author_uuid FROM guides')) {
      return { changes: guidesTable.has(String(params[0])) ? 1 : 0 };
    }
    // Vote upsert (the fix): INSERT ... ON CONFLICT (guide_id, voter_uuid)
    // DO UPDATE SET value = excluded.value
    if (sql.includes('INSERT INTO guide_votes') && sql.includes('ON CONFLICT')) {
      const [guideId, voter, value] = params as [string, string, number];
      votesTable.set(`${guideId}:${voter}`, Number(value));
      return { changes: 1 };
    }
    // Score maintenance (the fix): recompute from guide_votes.
    if (sql.includes('UPDATE guides') && sql.includes('SUM(value)')) {
      const [guideId, guideId2] = params as [string, string];
      let sum = 0;
      for (const [key, value] of votesTable) {
        if (key.startsWith(`${guideId}:`)) sum += value;
      }
      const row = guidesTable.get(guideId2);
      if (row) row.score = sum;
      return { changes: row ? 1 : 0 };
    }
    // Anything else (rate limiter, view counter) succeeds without modeling.
    return { changes: 1 };
  }

  function makeStmt(sql: string, params: unknown[] = []): {
    sql: string; params: unknown[];
    first: () => Promise<unknown>;
    run: () => Promise<{ meta: { changes: number } }>;
    all: () => Promise<{ results: unknown[] }>;
    bind: (...next: unknown[]) => ReturnType<typeof makeStmt>;
  } {
    const stmt = {
      sql,
      params,
      async first() {
        if (sql.includes('SELECT author_uuid FROM guides')) {
          const row = guidesTable.get(String(params[0]));
          return row ? { author_uuid: row.author_uuid } : null;
        }
        return null;
      },
      async run() {
        return { meta: apply({ sql, params }) };
      },
      async all() {
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
      const entry = statements.map((s) => ({ sql: s.sql, params: s.params }));
      batchLog.push(entry);
      // D1 semantics: a batch is a transaction — statements apply in order,
      // all-or-nothing. The synchronous model applies them atomically by
      // construction; what the route must guarantee is that the vote write
      // and the score recompute are submitted TOGETHER (asserted below).
      return statements.map((s) => ({ meta: apply(s) }));
    },
  };

  return { fakeD1, guidesTable, votesTable, batchLog };
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
import { initEnvFromBindings, __resetEnvForTests } from '../env.js';
import { signJwt } from '../auth/jwt.js';

let app: ReturnType<typeof createApp>;

const GUIDE_ID = 'g_testguide';
const AUTHOR_UUID = '11111111-2222-4333-8444-555555555555';

async function sessionCookie(): Promise<string> {
  const jwt = await signJwt({ authMethod: 'discord', discordId: '111111111111111111' });
  return `imperium_session=${jwt}`;
}

async function vote(value: 1 | -1): Promise<Response> {
  return app.request(`/api/v2/community/guides/${GUIDE_ID}/vote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: await sessionCookie() },
    body: JSON.stringify({ value }),
  });
}

/** Distinct voter identities: attachUser resolves ONE uuid for the session,
 *  so model different voters by varying the linked uuid via a fresh app import
 *  is overkill — instead simulate concurrent same-voter flips plus distinct
 *  voters through the modeled table directly where needed. */
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
  guidesTable.clear();
  votesTable.clear();
  batchLog.length = 0;
  guidesTable.set(GUIDE_ID, { author_uuid: AUTHOR_UUID, score: 0 });
});

describe('B-15 — guide vote score maintained atomically', () => {
  /** The batch containing the vote upsert — middleware (e.g. the D1 rate
   *  limiter) also batches, so filter rather than assume a single batch. */
  function voteBatch(): Array<{ sql: string; params: unknown[] }> {
    const entry = batchLog.find((stmts) => stmts.some((s) => s.sql.includes('INSERT INTO guide_votes')));
    return entry ?? [];
  }

  it('a vote submits the upsert and the score recompute in ONE batch (transaction)', async () => {
    const res = await vote(1);
    expect(res.status).toBe(200);
    const entry = voteBatch();
    expect(entry.length).toBe(2);
    const [upsert, score] = entry;
    expect(upsert.sql).toMatch(/INSERT INTO guide_votes/);
    expect(upsert.sql).toMatch(/ON CONFLICT \(guide_id, voter_uuid\) DO UPDATE SET value = excluded\.value/);
    expect(score.sql).toMatch(/UPDATE guides\s+SET score = \(SELECT COALESCE\(SUM\(value\), 0\) FROM guide_votes WHERE guide_id = \?\)\s+WHERE id = \?/);
  });

  it('the score statement recomputes from guide_votes — no read-modify-write increment', async () => {
    await vote(1);
    const scoreStmt = voteBatch()[1]!;
    expect(scoreStmt.sql).not.toMatch(/score = score \+/);
    expect(scoreStmt.sql).toMatch(/SUM\(value\)/);
  });

  it('end-to-end: three votes land and the score equals the exact sum of guide_votes', async () => {
    // One vote through the route (the session's voter) ...
    const res = await vote(1);
    expect(res.status).toBe(200);
    expect(res.json).toBeTruthy();
    // ... plus two modeled voters (distinct uuids) applied through the same
    // upsert/recompute pair the route emits.
    const entry = voteBatch();
    const upsertSql = entry[0]!.sql;
    const recomputeSql = entry[1]!.sql;
    fakeD1.batch([
      makeBound(upsertSql, [GUIDE_ID, '99999999-8888-7777-6666-555555555555', 1]),
      makeBound(recomputeSql, [GUIDE_ID, GUIDE_ID]),
    ]);
    fakeD1.batch([
      makeBound(upsertSql, [GUIDE_ID, '99999999-8888-7777-6666-555555555556', -1]),
      makeBound(recomputeSql, [GUIDE_ID, GUIDE_ID]),
    ]);
    expect(guidesTable.get(GUIDE_ID)!.score).toBe(1);
    let sum = 0;
    for (const v of votesTable.values()) sum += v;
    expect(guidesTable.get(GUIDE_ID)!.score).toBe(sum);
  });

  it('a vote flip converges: same voter flips 1 → -1, score follows exactly', async () => {
    await vote(1);
    expect(guidesTable.get(GUIDE_ID)!.score).toBe(1);
    const res = await vote(-1);
    expect(res.status).toBe(200);
    expect(votesTable.get(`${GUIDE_ID}:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`)).toBe(-1);
    expect(guidesTable.get(GUIDE_ID)!.score).toBe(-1);
  });

  it('the self-vote guard still applies before any write is submitted', async () => {
    guidesTable.set(GUIDE_ID, { author_uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', score: 0 });
    const res = await vote(1);
    expect(res.status).toBe(400);
    // No VOTE batch was submitted (middleware batches may exist — the guard
    // runs before the route's own write).
    expect(voteBatch()).toHaveLength(0);
    expect(votesTable.size).toBe(0);
  });
});

/** Rebuild a bound statement from a captured (sql, params) pair. */
function makeBound(sql: string, params: unknown[]): { sql: string; params: unknown[] } {
  return { sql, params };
}
