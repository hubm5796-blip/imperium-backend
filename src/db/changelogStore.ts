/**
 * Backend-owned changelog store — LEGACY half of the two-module split.
 *
 * Since Romanica-MC/romanica-frontend#9 the canonical store is
 * src/changelog/store.ts (changelog_entry: product/version/links/related,
 * one table for site-curated + Discord-posted + release-synced entries; the
 * product vocabulary lives in src/changelog/types.ts and nowhere else).
 * This module keeps the pre-#9 changelog_post table and its write path:
 *   - recordChangelogPost still writes changelog_post (write-only history +
 *     the prune lever below) AND dual-writes the canonical table with the
 *     same id, so Discord posts appear in the unified store immediately.
 *   - listChangelogPosts DELEGATES to the canonical store — the bot's
 *     /changelog command and the v2 list route see every entry (imported
 *     site updates included) through one read path.
 *   - The one-time empty-table seed of the October 2026 backfill still runs
 *     against changelog_post; its `seed-<slug>` rows are mapped to `<slug>`
 *     by the canonical backfill, then overwritten by the site import.
 *
 * Doctrine (mirrors actionLog.ts): rows are written AFTER the Discord post
 * succeeded, and a store failure NEVER fails the post — it is logged loudly.
 */
import { getD1 } from './pool.js';
import { logger } from '../utils/logger.js';
import { listChangelogEntries, upsertChangelogEntry } from '../changelog/store.js';
import type { ChangelogProduct } from '../changelog/types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS changelog_post (
  id text primary key,
  ts integer not null,
  title text not null,
  lead text,
  body_json text
)`;

export interface ChangelogPostRow {
  id: string;
  ts: number;
  title: string;
  lead: string | null;
  /** Sections [{name, changes[]}] or flat {changes[]} — rendered best-effort. */
  body: { sections?: { name: string; changes: string[] }[]; changes?: string[] } | null;
}

/** The October 2026 backfill (mirrors the frontend changelog blog seed). */
const SEED: { id: string; ts: number; title: string; lead: string; changes: string[] }[] = [
  {
    id: 'seed-last-two-frozen-mines-open',
    ts: Date.UTC(2026, 9, 11, 3, 32),
    title: 'The last two frozen mines are open, all fifty await',
    lead: 'The Augustan Forum Mine and the Marcus Aurelius Memorial passed their repairs and inspection, completing the ladder from Mine I to the Golden Milestone.',
    changes: [
      'The Augustan Forum Mine (Rank 41) and the Marcus Aurelius Memorial (Rank 48) were held back from the big expansion because their entry points dropped you into the floor instead of onto it.',
      'Their entry platforms are fixed and both mines passed a block-by-block inspection of the whole dig site before opening.',
      'Every mine from I to L is now enterable: fifty in total, the complete ladder up to the Golden Milestone at Rank 50.',
    ],
  },
  {
    id: 'seed-faster-website-honest-map',
    ts: Date.UTC(2026, 9, 11, 3, 32),
    title: 'A faster website, an honest map, and proper link cards',
    lead: 'The website got a full speed pass, the live map can no longer get stuck showing an old copy, and sharing Romanica links now shows a proper card.',
    changes: [
      'Pages you visit often now open almost instantly instead of being rebuilt from scratch every time.',
      'The live player counter refreshes without the wait, and images ship in a much lighter format.',
      'The map now forces a fresh load every visit, so a browser can never replay a broken old copy again.',
      'Romanica links on Discord and socials now show a proper card with the emblem instead of a gray rectangle.',
    ],
  },
  {
    id: 'seed-site-speaks-three-languages',
    ts: Date.UTC(2026, 9, 10, 22, 0),
    title: 'The website now speaks Portuguese, German and Spanish',
    lead: 'The landing pages are available in three more languages, picked automatically from your browser, with a switcher in the footer.',
    changes: [
      'The homepage, the vote page, the beginner guide and the FAQ are available in Brazilian Portuguese, German and Spanish.',
      'English always stays at romanica.net.',
    ],
  },
  {
    id: 'seed-frozen-mine-band-opens',
    ts: Date.UTC(2026, 9, 10, 20, 44),
    title: 'The Sabine Ridge and beyond: 22 new mines open',
    lead: 'The biggest expansion since launch - 22 new mines from Rank 27 to Rank 50, each one ground-verified before opening.',
    changes: [
      'Twenty-two new mines opened in one release, from The Sabine Ridge at Rank 27 to The Golden Milestone at Rank 50.',
      'Every site was checked on the ground before unlocking - entry points, ore fills and floors verified mine by mine.',
    ],
  },
  {
    id: 'seed-263-clients-and-lighter-mobile-data',
    ts: Date.UTC(2026, 9, 10, 4, 25),
    title: 'Minecraft 26.3 clients welcome, lighter data on mobile',
    lead: 'Newer Java editions can join directly, Bedrock support runs on the newest translation build, and phones download less.',
    changes: [
      'Minecraft 26.3 clients can now join - the cross-version layer accepts every newer Java edition.',
      'Bedrock support covers the latest console and phone versions.',
      'Data use on mobile is lighter across the board.',
    ],
  },
  {
    id: 'seed-smoother-first-minutes-on-touch',
    ts: Date.UTC(2026, 9, 8, 0, 0),
    title: 'Smoother first minutes on touch and new accounts',
    lead: 'Playing on touchscreens no longer trips the cheat detection, and new accounts get a fair learning window.',
    changes: [
      'Fast touch mining no longer trips the cheat detection anywhere on the map.',
      'Tapping beds and chests through doorways works reliably.',
      'The adaptive detector learns your personal style for ten minutes before it can flag anything.',
    ],
  },
  {
    id: 'seed-faster-joins-during-busy-periods',
    ts: Date.UTC(2026, 9, 6, 0, 0),
    title: 'Faster joins during busy periods',
    lead: 'A wave of players logging in at once no longer stalls everyone - joins got their own dedicated handling.',
    changes: [
      'Joins now run on their own dedicated handling instead of queuing behind background work.',
      'Getting in is fast no matter how many others are arriving with you.',
    ],
  },
  {
    id: 'seed-praeneste-shaft-and-first-hour-gifts',
    ts: Date.UTC(2026, 9, 9, 0, 0),
    title: 'The Praeneste Shaft opens, and the first hour learns to greet you',
    lead: 'A new mid-ladder mine opened, and the opening hour of a new account hands you what a fresh prisoner actually needs.',
    changes: [
      'The Praeneste Shaft joined the ladder with its own ore table.',
      'First-hour gifts now arrive as you hit early milestones instead of all at once.',
    ],
  },
];

let schemaReady = false;

/** Test hook: force the next ensure to re-run (per-test D1 swaps). */
export function __resetChangelogSchemaForTests(): void {
  schemaReady = false;
}

/** Lazy CREATE TABLE IF NOT EXISTS + one-time empty-table seed (dms.ts pattern). */
export async function ensureChangelogSchema(): Promise<void> {
  if (schemaReady) return;
  try {
    const d1 = getD1();
    await d1.prepare(SCHEMA).run();
    const count = await d1.prepare('SELECT COUNT(*) AS n FROM changelog_post').first<{ n: number }>();
    if ((count?.n ?? 0) === 0) {
      const stmts = SEED.map((s) =>
        d1
          .prepare('INSERT OR IGNORE INTO changelog_post (id, ts, title, lead, body_json) VALUES (?, ?, ?, ?, ?)')
          .bind(s.id, s.ts, s.title, s.lead, JSON.stringify({ changes: s.changes })),
      );
      await d1.batch(stmts);
      logger.info({ seeded: SEED.length }, 'changelog_post: seeded October 2026 backfill');
    }
    // Re-post hygiene (2026-10-13): replacing a Discord post (delete + repost through
    // this route) records a second row for the same title. Keep the newest row per
    // title so /changelog and the list API never show a duplicate.
    await d1
      .prepare(
        'DELETE FROM changelog_post WHERE id IN (' +
          'SELECT p.id FROM changelog_post p WHERE p.ts < ' +
          '(SELECT MAX(p2.ts) FROM changelog_post p2 WHERE p2.title = p.title))',
      )
      .run();
    schemaReady = true;
  } catch (err) {
    logger.error({ err: String(err) }, 'changelog_post schema/seed failed');
  }
}

/** The legacy post id scheme (S2-L10: generated in the route so the embed
 *  permalink and the stored row share one id). */
export function newChangelogPostId(): string {
  return `post-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Record a successful changelog post. Never throws (write-after-action doctrine).
 *  The optional product/version ride into the canonical store; the legacy
 *  changelog_post shape ignores them. The optional `id` lets the caller pin
 *  the row to an id it already rendered into the embed (same scheme, one id
 *  for the post + both store rows). */
export async function recordChangelogPost(entry: {
  id?: string;
  title: string;
  lead: string;
  sections?: { name: string; changes: string[] }[];
  changes?: string[];
  product?: ChangelogProduct;
  version?: string | null;
}): Promise<void> {
  // One id + one timestamp for both rows: the canonical backfill (INSERT OR
  // IGNORE) can then never re-import a row the dual-write already placed.
  const id = entry.id ?? newChangelogPostId();
  const ts = Date.now();
  try {
    await ensureChangelogSchema();
    await getD1()
      .prepare('INSERT INTO changelog_post (id, ts, title, lead, body_json) VALUES (?, ?, ?, ?, ?)')
      .bind(id, ts, entry.title, entry.lead, JSON.stringify({ sections: entry.sections, changes: entry.changes }))
      .run();
  } catch (err) {
    logger.error({ err: String(err), title: entry.title }, 'changelog_post store write failed (post already delivered)');
  }
  // Canonical dual-write. Same failure doctrine: a store outage must never
  // break the already-delivered Discord post.
  try {
    await upsertChangelogEntry({
      // The route validates product against the vocabulary before calling.
      product: entry.product ?? 'server',
      version: entry.version ?? null,
      id,
      date: ts,
      title: entry.title,
      summary: entry.lead || entry.title,
      body: { sections: entry.sections, changes: entry.changes },
      links: {},
      related: [],
      syncedAt: null,
    });
  } catch (err) {
    logger.error({ err: String(err), title: entry.title }, 'changelog_entry dual-write failed (post already delivered)');
  }
}

/** Explicit same-title dedup pass (the ensure() hygiene, runnable on demand).
 *  Returns the number of stale rows removed. */
export async function pruneDuplicateChangelogPosts(): Promise<number> {
  try {
    const d1 = getD1();
    await d1.prepare(SCHEMA).run();
    const res = await d1
      .prepare(
        'DELETE FROM changelog_post WHERE id IN (' +
          'SELECT p.id FROM changelog_post p WHERE p.ts < ' +
          '(SELECT MAX(p2.ts) FROM changelog_post p2 WHERE p2.title = p.title))',
      )
      .run();
    return res.meta?.changes ?? 0;
  } catch (err) {
    logger.error({ err: String(err) }, 'changelog_post prune failed');
    return -1;
  }
}

/** Latest posts, newest first — DELEGATED to the canonical store so every
 *  consumer (bot /changelog, v2 list route) sees imported site entries and
 *  synced releases too, not just Discord posts. The returned body keeps the
 *  legacy {sections, changes} shape, mapping imported keyChanges into a flat
 *  changes list so legacy renderers still show bullets. */
export async function listChangelogPosts(limit = 5): Promise<ChangelogPostRow[]> {
  const entries = await listChangelogEntries({ limit: Math.min(Math.max(1, limit), 25) });
  return entries.map((e) => ({
    id: e.id,
    ts: e.date,
    title: e.title,
    lead: e.summary,
    body: {
      sections: e.body.sections,
      changes:
        e.body.changes ??
        (e.body.sections ? undefined : (e.body.keyChanges && e.body.keyChanges.length > 0 ? e.body.keyChanges : undefined)),
    },
  }));
}
