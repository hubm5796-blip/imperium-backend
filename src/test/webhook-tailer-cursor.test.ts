import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

// The tailer's SQL runs against a real (in-process) Postgres so the cursor
// comparison has real semantics. web_events matches the plugin DDL
// (WebFeedService.kt: id BIGSERIAL PRIMARY KEY).
const { state, db } = vi.hoisted(() => ({
  state: new Map<string, string>(),
  db: { pg: null as unknown as import('@electric-sql/pglite').PGlite },
}));

vi.mock('../db/pool.js', () => ({
  query: async (sql: string, params: unknown[]) => db.pg.query(sql, params as never[]),
}));
vi.mock('../webhooks/store.js', () => ({
  getState: async (k: string) => {
    if (state.get('__fail_reads') === '1') throw new Error('D1 down');
    return state.get(k) ?? null;
  },
  setState: async (k: string, v: string) => void state.set(k, v),
}));
vi.mock('../webhooks/deliver.js', () => ({ emit: vi.fn(async () => 1) }));

import { runEventsTailer } from '../webhooks/tailer.js';

const CURSOR_KEY = 'web_events_tailer_cursor';

async function insertRankups(fromId: number, toId: number): Promise<void> {
  await db.pg.query(
    `INSERT INTO web_events (id, event_type, uuid, message)
     SELECT g, 'player_rankup', 'abcdef0123456789abcdef0123456789', 'player=Tester from=1 to=2'
       FROM generate_series($1::int, $2::int) g`,
    [fromId, toId],
  );
}

describe('webhook tailer cursor', () => {
  beforeAll(async () => {
    db.pg = new PGlite();
    await db.pg.exec(`CREATE TABLE web_events (
      id BIGSERIAL PRIMARY KEY,
      event_type VARCHAR(32) NOT NULL,
      uuid VARCHAR(32) NOT NULL,
      message VARCHAR(255) NOT NULL,
      at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  });

  beforeEach(async () => {
    state.clear();
    await db.pg.exec('TRUNCATE web_events');
  });

  it('keeps advancing across a digit boundary (cursor 999 → ids 1000+)', async () => {
    await insertRankups(990, 1010);
    state.set(CURSOR_KEY, '999');
    const report = await runEventsTailer();
    expect(report.scanned).toBe(11);
    expect(state.get(CURSOR_KEY)).toBe('1010');
  });

  it('does not rescan ids below the cursor that sort after it as text (cursor 10 → id 9)', async () => {
    await insertRankups(1, 12);
    state.set(CURSOR_KEY, '10');
    const report = await runEventsTailer();
    expect(report.scanned).toBe(2);
    expect(state.get(CURSOR_KEY)).toBe('12');
  });

  it('a fresh start seeds the cursor at MAX(id) instead of replaying history', async () => {
    await insertRankups(1, 5);
    const first = await runEventsTailer();
    expect(first.scanned).toBe(0);
    expect(state.get(CURSOR_KEY)).toBe('5');
    await insertRankups(6, 7);
    const second = await runEventsTailer();
    expect(second.scanned).toBe(2);
    expect(state.get(CURSOR_KEY)).toBe('7');
  });

  it('a garbage stored cursor is treated as a fresh start', async () => {
    await insertRankups(1, 3);
    state.set(CURSOR_KEY, '');
    const report = await runEventsTailer();
    expect(report.scanned).toBe(0);
    expect(state.get(CURSOR_KEY)).toBe('3');
  });

  it('a fresh start on an empty table leaves the cursor unset', async () => {
    const report = await runEventsTailer();
    expect(report.scanned).toBe(0);
    expect(state.has(CURSOR_KEY)).toBe(false);
  });

  it('a failed cursor read skips the tick and keeps the stored cursor', async () => {
    await insertRankups(1, 9);
    state.set(CURSOR_KEY, '4');
    state.set('__fail_reads', '1');
    const report = await runEventsTailer();
    expect(report.scanned).toBe(0);
    expect(state.get(CURSOR_KEY)).toBe('4');
  });
});
