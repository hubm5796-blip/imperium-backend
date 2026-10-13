/**
 * Backend-owned changelog store (2026-10-11) — the durable record of every
 * changelog posted through /api/v2/changelog/post, plus an idempotent seed of
 * the October 2026 backfill (the same entries the site renders at
 * imperiummc.net/changelog — src/lib/changelog.ts in the frontend repo is the
 * presentation twin; keep both in sync when a new update ships).
 *
 * Doctrine (mirrors actionLog.ts): rows are written AFTER the Discord post
 * succeeded, and a store failure NEVER fails the post — it is logged loudly.
 * The table is additive backend-owned D1; the seed only runs when the table is
 * empty so it can never duplicate or resurrect deleted history.
 */
import { getD1 } from './pool.js';
import { logger } from '../utils/logger.js';

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
    lead: 'The website got a full speed pass, the live map can no longer get stuck showing an old copy, and sharing ImperiumMC links now shows a proper card.',
    changes: [
      'Pages you visit often now open almost instantly instead of being rebuilt from scratch every time.',
      'The live player counter refreshes without the wait, and images ship in a much lighter format.',
      'The map now forces a fresh load every visit, so a browser can never replay a broken old copy again.',
      'ImperiumMC links on Discord and socials now show a proper card with the emblem instead of a gray rectangle.',
    ],
  },
  {
    id: 'seed-site-speaks-three-languages',
    ts: Date.UTC(2026, 9, 10, 22, 0),
    title: 'The website now speaks Portuguese, German and Spanish',
    lead: 'The landing pages are available in three more languages, picked automatically from your browser, with a switcher in the footer.',
    changes: [
      'The homepage, the vote page, the beginner guide and the FAQ are available in Brazilian Portuguese, German and Spanish.',
      'English always stays at imperiummc.net.',
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

/** Record a successful changelog post. Never throws (write-after-action doctrine). */
export async function recordChangelogPost(entry: {
  title: string;
  lead: string;
  sections?: { name: string; changes: string[] }[];
  changes?: string[];
}): Promise<void> {
  try {
    await ensureChangelogSchema();
    const id = `post-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await getD1()
      .prepare('INSERT INTO changelog_post (id, ts, title, lead, body_json) VALUES (?, ?, ?, ?, ?)')
      .bind(id, Date.now(), entry.title, entry.lead, JSON.stringify({ sections: entry.sections, changes: entry.changes }))
      .run();
  } catch (err) {
    logger.error({ err: String(err), title: entry.title }, 'changelog_post store write failed (post already delivered)');
  }
}

/** Latest posts, newest first. */
export async function listChangelogPosts(limit = 5): Promise<ChangelogPostRow[]> {
  try {
    await ensureChangelogSchema();
    const rows = await getD1()
      .prepare('SELECT id, ts, title, lead, body_json FROM changelog_post ORDER BY ts DESC, id DESC LIMIT ?')
      .bind(Math.min(Math.max(1, limit), 25))
      .all<{ id: string; ts: number; title: string; lead: string | null; body_json: string | null }>();
    return (rows.results ?? []).map((r) => ({
      id: r.id,
      ts: r.ts,
      title: r.title,
      lead: r.lead,
      body: r.body_json ? safeParse(r.body_json) : null,
    }));
  } catch (err) {
    logger.error({ err: String(err) }, 'changelog_post list failed');
    return [];
  }
}

function safeParse(raw: string): ChangelogPostRow['body'] {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
