/**
 * /mine data + changelog store integrity.
 *
 * mines.json is a snapshot of the live public_mines.yml — the test pins the
 * properties the /mine command and its embed rely on (complete live mines,
 * sane values, no emoji leaking into Discord output per the house rule).
 */
import { describe, expect, it } from 'vitest';
import minesSnapshot from '../bot/data/mines.json';
import { listChangelogPosts, recordChangelogPost } from '../db/changelogStore.js';

const snap = minesSnapshot as { contentCap: number; mines: { id: number; numeral: string; name: string; unlockRank: number; autoGenerate?: boolean; blocks: { m: string; v: number; s?: string }[] }[] };

describe('mines snapshot (/mine command data)', () => {
  it('covers the full live ladder I-L', () => {
    for (let id = 1; id <= snap.contentCap; id++) {
      const m = snap.mines.find((x) => x.id === id);
      expect(m, `mine id ${id} missing from snapshot`).toBeDefined();
    }
  });

  it('every live mine has a complete, sane record', () => {
    for (const m of snap.mines.filter((x) => x.id <= snap.contentCap)) {
      expect(m.numeral).toMatch(/^[IVXLC]+$/);
      expect(m.name.length).toBeGreaterThan(3);
      expect(m.unlockRank).toBeGreaterThanOrEqual(0);
      expect(m.blocks.length).toBeGreaterThanOrEqual(3);
      for (const b of m.blocks) {
        expect(b.m).toMatch(/^[A-Z_]+$/);
        expect(b.v).toBeGreaterThan(0);
      }
    }
  });

  it('mines 41 and 48 are marked live (unfrozen 2026-10-11)', () => {
    for (const id of [41, 48]) {
      const m = snap.mines.find((x) => x.id === id);
      expect(m?.autoGenerate).toBe(true);
    }
  });

  it('carries no emoji (house rule for anything rendered to Discord)', () => {
    const text = snap.mines.map((m) => m.name + (m.blocks.map((b) => b.s ?? '').join(''))).join('');
    expect(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)).toBe(false);
  });
});

describe('changelog store failure doctrine', () => {
  it('never throws when D1 is unavailable — reads degrade to empty', async () => {
    // No D1 binding in tests: getD1() throws inside the store, which must
    // absorb it (a store outage can never break /changelog or the post route).
    await expect(listChangelogPosts(5)).resolves.toEqual([]);
    await expect(
      recordChangelogPost({ title: 't', lead: 'l', changes: ['c'] }),
    ).resolves.toBeUndefined();
  });
});
