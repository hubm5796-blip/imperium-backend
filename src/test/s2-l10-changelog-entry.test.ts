/**
 * S2-L10 (Lane D backend half) — per-entry Discord embeds generated from the
 * ONE changelog store, plus the POST /api/v2/changelog/entry surface.
 *
 * Contract: docs/changelog/EMBED-FORMAT.md (frontend repo) — the embed is a
 * pure function of the entry, byte-identical to the owner-approved samples in
 * docs/changelog/samples/. The category/area/emoji vocabularies are pinned
 * against the frontend source file itself (they are defined once there and
 * must never be re-typed divergently here).
 *
 * NOTHING HERE POSTS LIVE: notify defaults to false (dry-run) and the test
 * fetch stub asserts dry-run never reaches Discord at all.
 *
 * Covered:
 *   1. buildChangelogEmbedMessage pinned against the three sample JSONs
 *      (deep-equal AND identical JSON key order) + limit clamps + the
 *      no-emoji-outside-author.name rule.
 *   2. Vocabulary drift guards: categories (label/colour/emoji) and area
 *      labels parsed out of the frontend src/lib/changelog.ts source.
 *   3. POST /api/v2/changelog/entry: service-token gate, closed-vocabulary
 *      + STYLE.md caps validation, upsert-by-slug idempotency, dry-run
 *      default (embed JSON returned, ZERO Discord calls), notify:true posts
 *      the exact built message, the empty-bullets notification guard, and
 *      the 502/503 failure modes.
 *   4. Legacy POST /changelog/post: still accepts the old body, renders it
 *      through the new embed template (category announcement, colour from
 *      the table, Area field, Romanica Changelog footer).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let db: DatabaseSync;

function d1FromDb() {
  return {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            run: async () => {
              const info = db.prepare(sql).run(...(params as never[]));
              return { meta: { changes: Number(info.changes) } };
            },
            first: async <T>() => (db.prepare(sql).get(...(params as never[])) as T | undefined) ?? null,
            all: async <T>() => ({ results: db.prepare(sql).all(...(params as never[])) as T[] }),
          };
        },
        run: async () => {
          const info = db.prepare(sql).run();
          return { meta: { changes: Number(info.changes) } };
        },
        first: async <T>() => (db.prepare(sql).get() as T | undefined) ?? null,
        all: async <T>() => ({ results: db.prepare(sql).all() as T[] }),
      };
    },
    batch: async (stmts: Array<{ run: () => Promise<unknown> }>) => {
      for (const stmt of stmts) await stmt.run();
      return [];
    },
  };
}

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return { ...actual, getD1: vi.fn(() => d1FromDb()) };
});
vi.mock('../db/redis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/redis.js')>();
  return {
    ...actual,
    getOnlinePlayerCount: vi.fn(async () => 0),
    getCachedJson: vi.fn(async () => null),
    setCachedJson: vi.fn(async () => undefined),
  };
});

import { changelogApi } from '../api/v2/dms.js';
import {
  CHANGELOG_AREA_LABELS,
  CHANGELOG_CATEGORIES,
  buildChangelogEmbedMessage,
  buildLegacyPostEmbed,
  type EmbedEntry,
} from '../changelog/embed.js';
import { __resetChangelogEntrySchemaForTests, listChangelogEntries } from '../changelog/store.js';
import { __resetChangelogSchemaForTests } from '../db/changelogStore.js';
import { CHANGELOG_PRODUCTS } from '../changelog/types.js';
import { __resetEnvForTests, initEnvFromBindings } from '../env.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(HERE, '..', '..', '..', 'imperium-frontend-fresh');
const SAMPLES = join(FRONTEND, 'docs', 'changelog', 'samples');

const SERVICE = { 'X-Bot-Token': 'service-token-0123456789' };

/** The three owner-approval sample entries, copied verbatim from the frontend
 *  archive (src/lib/changelog.ts) — the same data the samples were rendered
 *  from, so pinning builder(fixture) === sample proves the mirror. */
const FIXTURES: EmbedEntry[] = [
  {
    slug: 'ambient-crowd-removed',
    sortKey: '2026-10-30',
    category: 'correction',
    area: 'server',
    title: 'The streets of Rome are quiet again - the background crowd is gone',
    summary:
      'The nameless locals who wandered Rome have been removed. Every character with a real role is exactly where they were.',
    bullets: [
      'The background crowd of wandering locals is gone - it filled the streets without adding anything to them.',
      'Every named character keeps their post: story figures, the spawn guide, shopkeepers and event characters are untouched.',
      'This corrects the October 28 note that the streets of Rome are populated - that no longer describes Rome.',
    ],
  },
  {
    slug: 'first-hour-walkthrough',
    sortKey: '2026-10-30',
    category: 'new',
    area: 'server',
    title: 'Your first half hour in Rome now walks you through everything',
    summary:
      'A new account is guided step by step from the gates to the first rank-up. The game points at your next move the whole way.',
    bullets: [
      'Eight milestones walk you through the opening - the first mine, the first sale, the first rank-up with its full celebration, your first enchantment choice, a free crate with a cosmetic to wear, and the story hook.',
      'The sidebar starts small and grows as you go: it always names your single next step instead of a wall of tasks.',
      'The walk runs the same on Java and Bedrock, with nothing to type and no permissions needed.',
    ],
  },
  {
    slug: 'vote-rewards-exactly-once',
    sortKey: '2026-10-30',
    category: 'fix',
    area: 'server',
    title: 'Voting rewards now pay exactly once',
    summary:
      'A leftover flaw could pay the top-voter bonus twice, and a replayed vote signal could pay out again. Both are fixed, and reward delivery has been checked end to end.',
    bullets: [
      'Fixed a flaw that could pay the monthly top-voter bonus a second time.',
      'A repeated or replayed vote signal is now ignored - one vote, one reward, every time.',
      'Reward delivery was verified end to end before any vote website listing goes live.',
    ],
  },
];

/** The full endpoint body for a fixture (the entry-page-only fields the
 *  builder ignores ride along so the store round-trip is exercised too). */
function fixtureBody(f: EmbedEntry): Record<string, unknown> {
  return {
    slug: f.slug,
    sortKey: f.sortKey,
    category: f.category,
    area: f.area,
    title: f.title,
    summary: f.summary,
    bullets: [...f.bullets],
    body: ['Overflow narrative lives on the entry page only.'],
    action: 'Walk the city.',
    tags: ['correction', 'spawn'],
    ...(f.slug === 'ambient-crowd-removed'
      ? { correctionOf: 'https://romanica.net/changelog/post-mvs77hl0-jfjb78' }
      : {}),
  };
}

const fetchMock = vi.fn();

function initEnv(withChannel: boolean): void {
  __resetEnvForTests();
  initEnvFromBindings({
    JWT_SECRET: 'test-jwt-secret-0123456789abcdef',
    DISCORD_CLIENT_ID: '1',
    DISCORD_CLIENT_SECRET: 'x',
    DISCORD_BOT_TOKEN: 'discord-bot-token',
    WEBPANEL_HMAC_SECRET: 'test-hmac-secret',
    PAYNOW_API_KEY: 'pk_test',
    PAYNOW_STORE_ID: '1',
    PAYNOW_WEBHOOK_SECRETS: 'whsec_test',
    BOT_API_TOKEN: 'bot-token-0123456789',
    INTERNAL_SERVICE_TOKEN: 'service-token-0123456789',
    ...(withChannel ? { CHANGELOG_CHANNEL_ID: '1234567890' } : {}),
  } as unknown as Record<string, unknown>);
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS rate_limit_windows (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, hits INTEGER NOT NULL DEFAULT 0)');
  db.exec('CREATE TABLE IF NOT EXISTS rate_limit_v2_windows (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, cost INTEGER NOT NULL DEFAULT 0)');
  __resetChangelogEntrySchemaForTests();
  __resetChangelogSchemaForTests();
  initEnv(true);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () => new Response(JSON.stringify({ id: '1' }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});

/* ── 1. The builder pinned against the owner-approved samples ─────────────── */

describe('buildChangelogEmbedMessage (the EMBED-FORMAT.md contract)', () => {
  it.for(FIXTURES)('is identical to the sample JSON for %s (deep-equal AND key order)', async (f) => {
    const samplePath = join(SAMPLES, `${f.slug}.json`);
    if (!existsSync(samplePath)) throw new Error(`missing sample fixture: ${samplePath}`);
    const sample = JSON.parse(readFileSync(samplePath, 'utf8')) as unknown;
    const built = buildChangelogEmbedMessage(f) as unknown;
    expect(built).toEqual(sample);
    // Key order pinned too — "byte-identical" modulo whitespace.
    expect(JSON.stringify(built)).toBe(JSON.stringify(sample));
  });

  it('no emoji reaches any string except author.name (the owner format rule)', () => {
    for (const f of FIXTURES) {
      const embed = buildChangelogEmbedMessage(f).embeds[0]!;
      // eslint-disable-next-line no-control-regex
      const ascii = /^[\x20-\x7e]*$/;
      // eslint-disable-next-line no-control-regex
      const asciiMultiline = /^[\x20-\x7e\n]*$/;
      expect(embed.title).toMatch(ascii);
      expect(embed.description).toMatch(asciiMultiline);
      expect(embed.fields[0]!.name).toMatch(ascii);
      expect(embed.fields[0]!.value).toMatch(ascii);
      expect(embed.footer.text).toMatch(ascii);
      // author.name is the ONLY place the category emoji may appear.
      expect(embed.author.name).not.toMatch(ascii);
      expect(embed.author.name).toContain(CHANGELOG_CATEGORIES[f.category].emoji);
    }
  });

  it('clamps to the Discord limits: >3 bullets render as 3, oversize title as 256, description as 4096', () => {
    const long: EmbedEntry = {
      slug: 'a'.repeat(20),
      sortKey: '2026-10-30',
      category: 'announcement',
      area: 'server',
      title: 'T'.repeat(300),
      summary: 'S'.repeat(4000),
      bullets: ['b1'.padEnd(1500, '1'), 'b2'.padEnd(1500, '2'), 'b3'.padEnd(1500, '3'), 'b4-excluded'],
    };
    const embed = buildChangelogEmbedMessage(long).embeds[0]!;
    expect(embed.title).toHaveLength(256);
    expect(embed.description).toHaveLength(4096); // 4000 + separators + 3x1500 bullets exceeds the limit
    expect(embed.description).not.toContain('b4-excluded'); // the 4th bullet never renders
    expect(embed.timestamp).toBe('2026-10-30T12:00:00.000Z'); // the ENTRY date, never a clock
  });

  it('colours are parseInt(hex) of the category table (the samples pin the truth)', () => {
    // NOTE: the DECIMAL column in EMBED-FORMAT.md's category table carries
    // typos for four of five rows (e.g. it lists #b93608 as 12132360; the
    // int is 12137992). The binding artifacts are the hex column, the
    // frontend builder's parseInt(color.slice(1), 16), and the owner-approved
    // sample JSONs — the fix-category sample carries 12137992. These pins are
    // the true values.
    expect(CHANGELOG_CATEGORIES.fix.color).toBe(0xb93608);
    expect(CHANGELOG_CATEGORIES.new.color).toBe(0xd0b488);
    expect(CHANGELOG_CATEGORIES.improvement.color).toBe(0x55ef9f);
    expect(CHANGELOG_CATEGORIES.announcement.color).toBe(0xece7df);
    expect(CHANGELOG_CATEGORIES.correction.color).toBe(0xf5a623);
    expect(CHANGELOG_CATEGORIES.correction.color).toBe(16098851); // the one the sample JSON carries verbatim
  });
});

/* ── 2. Vocabulary drift guards against the frontend source of truth ──────── */

/** Unescape the TS unicode escapes the frontend source uses ('\u{1F527}', '\u2B06'). */
function unescapeTs(raw: string): string {
  return raw.replace(/\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})/g, (_m, braced, plain) =>
    String.fromCodePoint(parseInt(braced ?? plain, 16)),
  );
}

describe('vocabulary drift guard (frontend src/lib/changelog.ts is the source)', () => {
  const source = readFileSync(join(FRONTEND, 'src', 'lib', 'changelog.ts'), 'utf8');

  it('every category label, colour and emoji matches the frontend definition', () => {
    const categoriesSource = source.slice(source.indexOf('CHANGELOG_CATEGORIES'));
    for (const [id, def] of Object.entries(CHANGELOG_CATEGORIES)) {
      const re = new RegExp(
        `${id}:\\s*\\{\\s*label:\\s*'([^']+)',\\s*color:\\s*'#([0-9a-fA-F]{6})',\\s*emoji:\\s*'((?:\\\\u\\{[0-9a-fA-F]+\\}|\\\\u[0-9a-fA-F]{4})+)'`,
      );
      const m = re.exec(categoriesSource);
      expect(m, `frontend category ${id} not found`).toBeTruthy();
      expect(def.label).toBe(m![1]);
      expect(def.color).toBe(parseInt(m![2]!, 16));
      expect(def.emoji).toBe(unescapeTs(m![3]!));
    }
  });

  it('every area label matches the frontend CHANGELOG_AREAS definition', () => {
    for (const product of CHANGELOG_PRODUCTS) {
      const re = new RegExp(`${product}:\\s*\\{\\s*label:\\s*'([^']+)'`);
      const m = re.exec(source.slice(source.indexOf('CHANGELOG_AREAS')));
      expect(m, `frontend area ${product} not found`).toBeTruthy();
      expect(CHANGELOG_AREA_LABELS[product]).toBe(m![1]);
    }
  });
});

/* ── 3. POST /api/v2/changelog/entry ──────────────────────────────────────── */

async function postEntry(body: unknown, headers: Record<string, string> = SERVICE): Promise<Response> {
  return changelogApi.request('/changelog/entry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('POST /api/v2/changelog/entry — gates and validation', () => {
  it('is service-token gated: anonymous 401, wrong token 401, service token OK', async () => {
    const body = fixtureBody(FIXTURES[0]!);
    expect((await postEntry(body, {})).status).toBe(401);
    expect((await postEntry(body, { 'X-Bot-Token': 'wrong' })).status).toBe(401);
    expect((await postEntry(body)).status).toBe(200);
  });

  it('junk JSON and junk categories/areas are 400, nothing stored', async () => {
    expect((await postEntry('not json')).status).toBe(400);
    const base = fixtureBody(FIXTURES[0]!);
    expect((await postEntry({ ...base, category: 'hotfix' })).status).toBe(400);
    expect((await postEntry({ ...base, area: 'bot' })).status).toBe(400);
    const entries = await listChangelogEntries({ limit: 50 });
    expect(entries).toHaveLength(0);
  });

  it('enforces the STYLE.md caps: title 11-90, summary 21-300, bullets 1-3', async () => {
    const base = fixtureBody(FIXTURES[0]!);
    expect((await postEntry({ ...base, title: 'T'.repeat(10) })).status).toBe(400);
    expect((await postEntry({ ...base, title: 'T'.repeat(91) })).status).toBe(400);
    expect((await postEntry({ ...base, summary: 'S'.repeat(20) })).status).toBe(400);
    expect((await postEntry({ ...base, summary: 'S'.repeat(301) })).status).toBe(400);
    expect((await postEntry({ ...base, bullets: ['b1', 'b2', 'b3', 'b4'] })).status).toBe(400);
    expect((await postEntry({ ...base, bullets: ['b1', 42] })).status).toBe(400);
    // A slug must be a lowercase slug (it is the permalink).
    expect((await postEntry({ ...base, slug: 'Not_A_Slug' })).status).toBe(400);
    expect((await postEntry({ ...base, sortKey: '2026-13-99' })).status).toBe(400);
  });

  it('correction entries must cite correctionOf; other categories must not carry one', async () => {
    const correction = fixtureBody(FIXTURES[0]!); // category 'correction'
    expect((await postEntry({ ...correction, correctionOf: undefined })).status).toBe(400);
    const plain = fixtureBody(FIXTURES[1]!); // category 'new'
    expect((await postEntry({ ...plain, correctionOf: 'https://romanica.net/changelog/x' })).status).toBe(400);
  });
});

describe('POST /api/v2/changelog/entry — dry-run is the default and posts NOTHING', () => {
  it('no notify flag: stores the entry, returns the embed JSON, and makes ZERO Discord calls', async () => {
    const res = await postEntry(fixtureBody(FIXTURES[0]!));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { upserted: boolean; id: string; created: boolean; posted: boolean; message: unknown };
    expect(json.upserted).toBe(true);
    expect(json.id).toBe('ambient-crowd-removed');
    expect(json.created).toBe(true);
    expect(json.posted).toBe(false); // DRY-RUN — nothing posts without the explicit flag
    // The returned message is byte-identical to what WOULD be posted.
    const sample = JSON.parse(readFileSync(join(SAMPLES, 'ambient-crowd-removed.json'), 'utf8')) as unknown;
    expect(json.message).toEqual(sample);
    expect(JSON.stringify(json.message)).toBe(JSON.stringify(sample));
    // The live-post proof: Discord was never contacted.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('notify:false is the same explicit dry-run (site-only entry)', async () => {
    const res = await postEntry({ ...fixtureBody(FIXTURES[1]!), notify: false });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { posted: boolean }).posted).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    const entries = await listChangelogEntries({ limit: 10 });
    expect(entries.find((e) => e.id === 'first-hour-walkthrough')).toBeDefined();
  });

  it('upserts by slug: re-posting the same entry updates, never duplicates (permalink stability)', async () => {
    await postEntry(fixtureBody(FIXTURES[0]!));
    const second = await postEntry({ ...fixtureBody(FIXTURES[0]!), summary: FIXTURES[0]!.summary + ' Updated.' });
    expect(((await second.json()) as { created: boolean }).created).toBe(false);
    const entries = await listChangelogEntries({ limit: 50 });
    expect(entries.filter((e) => e.id === 'ambient-crowd-removed')).toHaveLength(1);
    expect(entries[0]!.summary).toContain('Updated.');
  });

  it('the store row carries category + the v2 body fields', async () => {
    await postEntry(fixtureBody(FIXTURES[0]!));
    const stored = (await listChangelogEntries({ limit: 10 })).find((e) => e.id === 'ambient-crowd-removed')!;
    expect(stored.category).toBe('correction');
    expect(stored.body.bullets).toEqual(FIXTURES[0]!.bullets);
    expect(stored.body.correctionOf).toBe('https://romanica.net/changelog/post-mvs77hl0-jfjb78');
    expect(stored.body.action).toBe('Walk the city.');
    expect(stored.date).toBe(Date.parse('2026-10-30T00:00:00.000Z'));
  });
});

describe('POST /api/v2/changelog/entry — notify:true (the explicit live-post flag)', () => {
  it('posts exactly the built message to the configured channel and records the audit', async () => {
    const res = await postEntry({ ...fixtureBody(FIXTURES[2]!), notify: true });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { posted: boolean };
    expect(json.posted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://discord.com/api/v10/channels/1234567890/messages');
    const sent = JSON.parse(String(init.body)) as unknown;
    const sample = JSON.parse(readFileSync(join(SAMPLES, 'vote-rewards-exactly-once.json'), 'utf8')) as unknown;
    expect(sent).toEqual(sample); // the embed the owner approved, verbatim
    const audit = db.prepare("SELECT action, target FROM action_log WHERE action = 'changelog.entry'").all() as Array<{ action: string; target: string }>;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.target).toBe('vote-rewards-exactly-once');
  });

  it('rejects notify:true with no player-visible content (empty bullets) — the notification policy guard', async () => {
    const body = { ...fixtureBody(FIXTURES[0]!), notify: true };
    delete (body as Record<string, unknown>).bullets;
    const res = await postEntry(body);
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await listChangelogEntries({ limit: 50 })).find((e) => e.id === 'ambient-crowd-removed')).toBeUndefined();
  });

  it('unconfigured channel: 503 (no fallback audience), the entry row survives for the idempotent retry', async () => {
    initEnv(false); // no CHANGELOG_CHANNEL_ID
    const res = await postEntry({ ...fixtureBody(FIXTURES[1]!), notify: true });
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await listChangelogEntries({ limit: 50 })).find((e) => e.id === 'first-hour-walkthrough')).toBeDefined();
  });

  it('a Discord failure answers 502 and reports honestly (the store row stays for retry)', async () => {
    fetchMock.mockImplementation(async () => new Response('nope', { status: 403 }));
    const res = await postEntry({ ...fixtureBody(FIXTURES[1]!), notify: true });
    expect(res.status).toBe(502);
    expect((await listChangelogEntries({ limit: 50 })).find((e) => e.id === 'first-hour-walkthrough')).toBeDefined();
  });
});

/* ── 4. The legacy /changelog/post renders through the new template ───────── */

describe('legacy POST /changelog/post (transition render)', () => {
  const OLD_BODY = {
    title: 'Mines and ranks - October wrap',
    description: 'The October ladder work is live.',
    changes: ['Two frozen mines opened.', 'Rank protection landed.'],
  };

  it('still accepts the old body, in the new look: announcement category, Area field, changelog footer', async () => {
    const res = await changelogApi.request('/changelog/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...SERVICE },
      body: JSON.stringify(OLD_BODY),
    });
    expect(res.status).toBe(200);
    const sent = JSON.parse(String((fetchMock.mock.calls[0]![1] as { body: string }).body)) as {
      embeds: Array<Record<string, unknown>>;
      allowed_mentions: { parse: string[] };
    };
    expect(sent.allowed_mentions).toEqual({ parse: [] });
    const embed = sent.embeds[0]!;
    expect(embed.author).toEqual({ name: `${CHANGELOG_CATEGORIES.announcement.emoji} Announcement` });
    expect(embed.color).toBe(0xece7df); // announcement from the category table (parseInt of the hex)
    expect(embed.fields).toEqual([{ name: 'Area', value: 'Server', inline: true }]);
    expect(embed.footer).toEqual({ text: 'Romanica Changelog', icon_url: 'https://romanica.net/icon.png' });
    expect(String(embed.url)).toMatch(/^https:\/\/romanica\.net\/changelog\/post-/);
    const description = String(embed.description);
    expect(description).toContain('The October ladder work is live.');
    expect(description).toContain('- Two frozen mines opened.');
    expect(description).toContain('- Rank protection landed.');
    expect(description).toContain('Read the full update: https://romanica.net/changelog/post-');
    expect(String(embed.timestamp)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/); // post clock (no entry date)
    // No-glyph rule holds everywhere except the category line.
    // eslint-disable-next-line no-control-regex
    expect(description).toMatch(/^[\x20-\x7e\n]*$/);
    expect(String(embed.title)).toMatch(/^[\x20-\x7e]*$/);
  });

  it('sections render as bold headers over bullets and garbled glyphs are asciified', async () => {
    const res = await changelogApi.request('/changelog/post', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...SERVICE },
      body: JSON.stringify({
        title: 'Store — updates',
        description: '',
        sections: [{ name: 'Store', changes: ['Checkout fix — faster now'] }],
      }),
    });
    expect(res.status).toBe(200);
    const sent = JSON.parse(String((fetchMock.mock.calls[0]![1] as { body: string }).body)) as { embeds: Array<{ title: string; description: string }> };
    const embed = sent.embeds[0]!;
    expect(embed.title).toBe('Store - updates'); // em-dash asciified
    expect(embed.description).toContain('**Store**');
    expect(embed.description).toContain('- Checkout fix - faster now');
  });

  it('keeps the old validation: no title/no changes is 400, junk product is 400', async () => {
    expect(
      (await changelogApi.request('/changelog/post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...SERVICE },
        body: JSON.stringify({ title: 'x' }),
      })).status,
    ).toBe(400);
    expect(
      (await changelogApi.request('/changelog/post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...SERVICE },
        body: JSON.stringify({ ...OLD_BODY, product: 'bot' }),
      })).status,
    ).toBe(400);
  });
});

/* ── 5. The legacy builder is exported pure (for the bot /changelog command) ─ */

describe('buildLegacyPostEmbed (pure)', () => {
  it('derives the Area label from the product', () => {
    const msg = buildLegacyPostEmbed({
      title: 'T',
      description: 'D',
      changes: ['c'],
      sections: [],
      product: 'launcher',
      slug: 'post-x',
      nowIso: '2026-10-30T12:00:00.000Z',
    });
    expect(msg.embeds[0]!.fields).toEqual([{ name: 'Area', value: 'Launcher', inline: true }]);
  });
});
