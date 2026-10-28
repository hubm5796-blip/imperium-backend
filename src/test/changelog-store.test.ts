/**
 * The ONE changelog store — Romanica-MC/romanica-frontend#9.
 *
 * These tests execute the store's REAL SQL: the fake D1 is a thin adapter over
 * in-process SQLite (node:sqlite — the same dialect D1 speaks), so the
 * migration DDL, the legacy changelog_post backfill, the product-filtered
 * list query and the release upsert all run for real instead of being
 * simulated. Each area also asserts non-empty coverage (a filter that
 * returned nothing, or an import that imported nothing, fails the test).
 *
 * Covered:
 *   1. Schema migration — target columns, legacy backfill (seed-<slug> mapping),
 *      idempotent re-ensure, fresh D1 without a legacy table.
 *   2. List filtering — ?product= exact filter + 400 on junk, stable
 *      newest-first ordering (date DESC, id DESC), limit, per-entry badge
 *      fields (product/version/links/related/syncedAt).
 *   3. Import transformation — the golden site dump transforms losslessly
 *      (slug ids, honest product mapping, version extraction, dates) and
 *      imports over backfilled legacy rows without duplicates.
 *   4. Release upsert — service-token gate, deterministic id, idempotent
 *      re-sync (one row, updated body, refreshed syncedAt), validation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
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
    // Legacy seed path only; D1 batches are transactional, sequential runs are
    // equivalent for the seed's independent INSERT OR IGNOREs.
    batch: async (stmts: Array<{ run: () => Promise<unknown> }>) => {
      for (const stmt of stmts) await stmt.run();
      return [];
    },
  };
}

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    getD1: vi.fn(() => d1FromDb()),
  };
});

import { changelogApi } from '../api/v2/dms.js';
import {
  __resetChangelogEntrySchemaForTests,
  listChangelogEntries,
  upsertChangelogEntry,
} from '../changelog/store.js';
import { __resetChangelogSchemaForTests } from '../db/changelogStore.js';
import {
  siteEntryToChangelogEntry,
  type SiteChangelogEntry,
} from '../changelog/transform.js';
import { CHANGELOG_PRODUCTS } from '../changelog/types.js';
import { __resetEnvForTests, initEnvFromBindings } from '../env.js';

const SERVICE = { 'X-Bot-Token': 'service-token-0123456789' };

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

/** The golden site dump this branch ships (generated from the frontend repo's
 *  src/lib/changelog.ts — regenerate with scripts/dump-site-changelog.mts). */
const GOLDEN = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'data', 'site-changelog-2026-10-28.json'),
    'utf8',
  ),
) as SiteChangelogEntry[];

/** Create the LEGACY changelog_post table exactly as production has it and
 *  drop in historical rows, including `seed-` rows whose ids are `seed-` + the
 *  site slug (the shape the canonical backfill relies on). */
function seedLegacyTable(): void {
  db.exec(
    'CREATE TABLE changelog_post (id text primary key, ts integer not null, title text not null, lead text, body_json text)',
  );
  const ins = db.prepare('INSERT INTO changelog_post (id, ts, title, lead, body_json) VALUES (?, ?, ?, ?, ?)');
  ins.run(
    'post-legacy1',
    Date.UTC(2026, 9, 15, 12, 0),
    'A legacy Discord post',
    'The legacy lead.',
    JSON.stringify({ sections: [{ name: 'Section A', changes: ['did a thing'] }] }),
  );
  ins.run(
    'seed-last-two-frozen-mines-open',
    Date.UTC(2026, 9, 11, 3, 32),
    'The last two frozen mines are open, all fifty await',
    'Seed-level lead.',
    JSON.stringify({ changes: ['seed bullet'] }),
  );
  ins.run(
    'seed-faster-website-honest-map',
    Date.UTC(2026, 9, 11, 3, 32),
    'A faster website, an honest map, and proper link cards',
    'Seed-level lead.',
    JSON.stringify({ changes: ['seed bullet'] }),
  );
}

function entryCount(): number {
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='changelog_entry'").get();
  if (!t) return 0; // not ensured yet — nothing written
  return Number(db.prepare('SELECT COUNT(*) AS n FROM changelog_entry').get()!.n);
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  __resetChangelogEntrySchemaForTests();
  __resetChangelogSchemaForTests();
  initEnv(true);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: '1' }), { status: 200 })));
});

describe('changelog_entry schema migration', () => {
  it('creates exactly the target shape (#9): id, date, product, version, title, summary, body, links, related, synced_at', async () => {
    await listChangelogEntries({ limit: 5 }); // triggers lazy ensure
    const cols = (
      db.prepare("SELECT name FROM pragma_table_info('changelog_entry') ORDER BY cid").all() as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toEqual(['id', 'date', 'product', 'version', 'title', 'summary', 'body', 'links', 'related', 'synced_at']);
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='changelog_entry'").all() as { name: string }[];
    const idxNames = idx.map((i) => i.name);
    expect(idxNames).toContain('idx_changelog_entry_date');
    expect(idxNames).toContain('idx_changelog_entry_product');
  });

  it('backfills legacy changelog_post rows (they keep working), mapping seed-<slug> to <slug>', async () => {
    seedLegacyTable();
    const entries = await listChangelogEntries({ limit: 25 });
    // Non-empty coverage: every legacy row arrived.
    expect(entries).toHaveLength(3);
    const post = entries.find((e) => e.id === 'post-legacy1')!;
    expect(post.product).toBe('server');
    expect(post.summary).toBe('The legacy lead.');
    expect(post.body.sections).toEqual([{ name: 'Section A', changes: ['did a thing'] }]);
    expect(post.syncedAt).toBeNull();
    // The seed rows surface under their site slug (the permalink id)...
    const mapped = entries.find((e) => e.id === 'last-two-frozen-mines-open')!;
    expect(mapped).toBeDefined();
    expect(mapped!.product).toBe('server'); // corrected by the site import below
    expect(mapped!.body.changes).toEqual(['seed bullet']);
    // ...and no `seed-` id ever exists in the canonical store.
    expect(entries.some((e) => e.id.startsWith('seed-'))).toBe(false);
  });

  it('re-running the migration is idempotent (no duplicate rows)', async () => {
    seedLegacyTable();
    await listChangelogEntries({ limit: 25 });
    expect(entryCount()).toBe(3);
    __resetChangelogEntrySchemaForTests();
    await listChangelogEntries({ limit: 25 });
    expect(entryCount()).toBe(3);
  });

  it('a fresh D1 without a legacy table settles cleanly (import owns history there)', async () => {
    // db has NO changelog_post — the backfill must not wedge the store.
    const entries = await listChangelogEntries({ limit: 10 });
    expect(entries).toEqual([]);
    // ...and the store still works afterwards.
    await upsertChangelogEntry({
      id: 'first', date: Date.now(), product: 'server', title: 't', summary: 's', body: {},
    });
    expect(entryCount()).toBe(1);
  });
});

describe('changelog list filtering + ordering', () => {
  const T = Date.UTC(2026, 9, 20, 10, 0);
  async function seedMixed(): Promise<void> {
    const mk = (id: string, date: number, product: 'server' | 'client' | 'launcher' | 'website' | 'pack', version: string | null = null) =>
      upsertChangelogEntry({
        id, date, product, version, title: `title ${id}`, summary: `summary ${id}`,
        body: { keyChanges: [`bullet ${id}`] }, links: { release: `https://github.com/Romanica-MC/x/releases/tag/${id}` },
        related: ['other'], syncedAt: product === 'launcher' ? T : null,
      });
    await mk('server-a', T, 'server');
    await mk('launcher-0.2.8', T - 1_000, 'launcher', '0.2.8');
    await mk('launcher-0.2.7', T - 2_000, 'launcher', '0.2.7');
    await mk('website-b', T - 3_000, 'website');
    // Same-date tiebreaker pair: id DESC must order b-tie above a-tie.
    await mk('a-tie', T - 4_000, 'server');
    await mk('b-tie', T - 4_000, 'client', '0.2.0-beta.24');
  }

  it('orders newest first with a stable id tiebreak, and every entry carries its badge fields', async () => {
    await seedMixed();
    const res = await changelogApi.request('/changelog/list?limit=10');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { products: string[]; count: number; posts: Array<Record<string, unknown>> };
    expect(json.products).toEqual([...CHANGELOG_PRODUCTS]); // vocabulary served from the store's single source
    expect(json.count).toBe(6);
    expect(json.posts.map((p) => p.id)).toEqual([
      'server-a', 'launcher-0.2.8', 'launcher-0.2.7', 'website-b', 'b-tie', 'a-tie',
    ]);
    const launcher = json.posts.find((p) => p.id === 'launcher-0.2.8')!;
    expect(launcher).toMatchObject({
      product: 'launcher',
      version: '0.2.8',
      links: { release: 'https://github.com/Romanica-MC/x/releases/tag/launcher-0.2.8' },
      related: ['other'],
    });
    expect(typeof launcher.syncedAt).toBe('string');
    expect(launcher.keyChanges).toEqual(['bullet launcher-0.2.8']);
    // Legacy aliases survive for pre-#9 consumers.
    expect(launcher.lead).toBe('summary launcher-0.2.8');
    expect(typeof launcher.postedAt).toBe('string');
  });

  it('filters by product exactly (?product=launcher) and the filter is never empty here', async () => {
    await seedMixed();
    const res = await changelogApi.request('/changelog/list?limit=50&product=launcher');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { count: number; posts: Array<{ id: string; product: string }> };
    expect(json.count).toBe(2); // non-empty coverage
    expect(json.posts.every((p) => p.product === 'launcher')).toBe(true);
    expect(json.posts.map((p) => p.id)).toEqual(['launcher-0.2.8', 'launcher-0.2.7']);
  });

  it('rejects a product outside the vocabulary with 400 + the allowlist', async () => {
    const res = await changelogApi.request('/changelog/list?product=saas');
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain('website');
    expect(json.error).toContain('launcher');
  });

  it('respects the limit and defaults to 5', async () => {
    await seedMixed();
    const limited = await changelogApi.request('/changelog/list?limit=2');
    expect(((await limited.json()) as { count: number }).count).toBe(2);
    const defaulted = await changelogApi.request('/changelog/list');
    expect(((await defaulted.json()) as { count: number }).count).toBe(5);
  });
});

describe('site import transformation (golden file)', () => {
  it('the golden dump has 39 unique-slug entries — the permalink contract input', () => {
    expect(GOLDEN.length).toBe(39);
    expect(new Set(GOLDEN.map((e) => e.slug)).size).toBe(39);
  });

  it('transforms every entry: slug id, honest product mapping, date epoch, body preserved', () => {
    const transformed = GOLDEN.map(siteEntryToChangelogEntry);
    expect(transformed).toHaveLength(GOLDEN.length);

    // Product distribution pinned to the documented mapping (transform.ts):
    // 17 server, 9 client, 4 launcher, 9 website.
    const byProduct = (p: string) => transformed.filter((e) => e.product === p).length;
    expect(byProduct('server')).toBe(17);
    expect(byProduct('client')).toBe(9);
    expect(byProduct('launcher')).toBe(4);
    expect(byProduct('website')).toBe(9);
    expect(transformed.every((e) => (CHANGELOG_PRODUCTS as readonly string[]).includes(e.product))).toBe(true);

    // Slugs are the ids (permalinks never break) and dates come from sortKey at UTC midnight.
    const bedrock = transformed.find((e) => e.id === 'bedrock-nethernet')!;
    expect(bedrock).toMatchObject({
      product: 'server',
      title: 'Bedrock players keep joining through the protocol change',
      summary: expect.stringContaining('Bedrock Edition switched'),
    });
    expect(bedrock.date).toBe(Date.parse('2026-10-27T00:00:00.000Z'));
    expect(bedrock.body.keyChanges!.length).toBeGreaterThanOrEqual(5);
    expect(bedrock.body.action).toBeTruthy();
    expect(bedrock.body.tags).toContain('bedrock');
    expect(bedrock.body.readHref).toBe('/wiki/bedrock');

    // Spot-check the judgment calls a reviewer would question.
    expect(transformed.find((e) => e.id === 'sign-in-with-microsoft')!.product).toBe('website');
    expect(transformed.find((e) => e.id === 'cassius-guide-at-spawn')!.product).toBe('server');
    expect(transformed.find((e) => e.id === 'discord-bot-three-new-commands')!.product).toBe('server');
    expect(transformed.find((e) => e.id === 'romanica-rename')!.product).toBe('website');
    expect(transformed.find((e) => e.id === 'imperium-client-beta2')!.product).toBe('client');
  });

  it('extracts versions only where the slug/title states one', () => {
    const transformed = GOLDEN.map(siteEntryToChangelogEntry);
    expect(transformed.find((e) => e.id === 'launcher-0-2-7')!.version).toBe('0.2.7');
    expect(transformed.find((e) => e.id === 'launcher-0-1-2')!.version).toBe('0.1.2');
    expect(transformed.find((e) => e.id === 'romanica-client-beta12')!.version).toBe('0.2.0-beta.12');
    expect(transformed.find((e) => e.id === 'client-beta-24-breadcrumbs')!.version).toBe('0.2.0-beta.24');
    expect(transformed.find((e) => e.id === 'praeneste-shaft-and-first-hour-gifts')!.version).toBeNull();
    const versioned = transformed.filter((e) => e.version !== null).length;
    expect(versioned).toBe(12); // 4 launchers + 8 titled client betas (beta.5-.9, .11, .12, .24)
  });

  it('rejects structurally broken site entries instead of importing them', () => {
    expect(() => siteEntryToChangelogEntry({ ...GOLDEN[0]!, slug: '' })).toThrow();
    expect(() =>
      siteEntryToChangelogEntry({ ...GOLDEN[0]!, sortKey: '27/10/2026' }),
    ).toThrow(/sortKey/);
  });

  it('end-to-end: importing over backfilled legacy rows converges (no duplicates, rich prose wins, site filter works)', async () => {
    seedLegacyTable();
    const entries = await listChangelogEntries({ limit: 25 }); // triggers backfill
    expect(entries).toHaveLength(3);

    for (const site of GOLDEN) {
      await upsertChangelogEntry(siteEntryToChangelogEntry(site));
    }

    const all = await listChangelogEntries({ limit: 200 });
    // 39 imported + 1 legacy post (the 2 seed twins were overwritten, not duplicated).
    expect(all).toHaveLength(40);
    expect(all.some((e) => e.id.startsWith('seed-'))).toBe(false);
    // The imported twin owns the slug with the site's fuller prose + product.
    const mines = all.find((e) => e.id === 'last-two-frozen-mines-open')!;
    expect(mines.product).toBe('server');
    expect(mines.body.keyChanges!.length).toBeGreaterThanOrEqual(3);
    expect(mines.body.changes).toBeUndefined(); // seed body replaced
    const map = all.find((e) => e.id === 'faster-website-honest-map')!;
    expect(map.product).toBe('website');

    // Non-empty coverage on the API surface: the site's whole website set is filterable.
    const res = await changelogApi.request('/changelog/list?limit=200&product=website');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { count: number };
    expect(json.count).toBe(9);
  });
});

describe('release sync upsert (POST /changelog/release)', () => {
  const release = {
    product: 'launcher',
    version: '0.2.8',
    title: 'Launcher 0.2.8',
    summary: 'Self-update hardening.',
    body: '## Fixes\n- updater verifies signatures\n- smaller downloads',
    date: '2026-10-28T00:00:00.000Z',
    releaseUrl: 'https://github.com/Romanica-MC/imperium-launcher/releases/tag/v0.2.8',
    pr: 123,
  };

  it('requires the service token', async () => {
    const res = await changelogApi.request('/changelog/release', {
      method: 'POST',
      headers: { 'X-Bot-Token': 'bot-token-0123456789', 'content-type': 'application/json' },
      body: JSON.stringify(release),
    });
    expect(res.status).toBe(401);
    expect(entryCount()).toBe(0);
  });

  it('upserts by the deterministic <product>-<version> id, stamped syncedAt', async () => {
    const res = await changelogApi.request('/changelog/release', {
      method: 'POST',
      headers: { ...SERVICE, 'content-type': 'application/json' },
      body: JSON.stringify(release),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { upserted: boolean; id: string; created: boolean };
    expect(json).toMatchObject({ upserted: true, id: 'launcher-0.2.8', created: true });

    const all = await listChangelogEntries({ limit: 10 });
    expect(all).toHaveLength(1); // non-empty coverage
    expect(all[0]).toMatchObject({
      id: 'launcher-0.2.8',
      product: 'launcher',
      version: '0.2.8',
      links: { release: release.releaseUrl, pr: '123' },
    });
    expect(all[0]!.body.markdown).toBe(release.body);
    expect(all[0]!.syncedAt).not.toBeNull();
    expect(all[0]!.date).toBe(Date.parse(release.date));
  });

  it('replaying the same release updates the one row and refreshes syncedAt (idempotency)', async () => {
    const first = await changelogApi.request('/changelog/release', {
      method: 'POST',
      headers: { ...SERVICE, 'content-type': 'application/json' },
      body: JSON.stringify(release),
    });
    expect(first.status).toBe(200);
    const before = (await listChangelogEntries({ limit: 10 }))[0]!.syncedAt!;
    await new Promise((r) => setTimeout(r, 20));

    const replay = await changelogApi.request('/changelog/release', {
      method: 'POST',
      headers: { ...SERVICE, 'content-type': 'application/json' },
      body: JSON.stringify({ ...release, summary: 'Updated summary.', body: release.body + '\n- one more' }),
    });
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { created: boolean }).created).toBe(false);

    const rows = await listChangelogEntries({ limit: 10 });
    expect(rows).toHaveLength(1); // no duplicate
    expect(rows[0]!.summary).toBe('Updated summary.');
    expect(rows[0]!.body.markdown).toBe(release.body + '\n- one more');
    expect(rows[0]!.syncedAt!).toBeGreaterThan(before); // stamp refreshed
  });

  it('an explicit slug id makes version optional (website entries carry none)', async () => {
    // Issue #9 site import: /changelog/<slug> permalinks anchor on the id alone;
    // the store's version column is nullable and website entries legitimately
    // have no version. The REQUIRED-version rule exists for the auto-derived
    // <product>-<version> anchor only.
    const res = await changelogApi.request('/changelog/release', {
      method: 'POST',
      headers: { ...SERVICE, 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'store-link-rank-protection-anticheat',
        date: '2026-10-28T00:00:00.000Z',
        product: 'server',
        title: 'Store link restored, your rank protected',
        summary: 'The in-game store link works again.',
        body: '- fixed the dead-domain link',
      }),
    });
    const dbg = await res.text();
    expect(res.status, dbg).toBe(200);
    const json = JSON.parse(dbg) as { id: string; created: boolean };
    expect(json.id).toBe('store-link-rank-protection-anticheat');
    const row = (await listChangelogEntries({ limit: 10 }))[0]!;
    expect(row.version).toBeNull();
    expect(row.body.markdown).toContain('dead-domain link');
  });

  it('still requires version when the id is auto-derived', async () => {
    const res = await changelogApi.request('/changelog/release', {
      method: 'POST',
      headers: { ...SERVICE, 'content-type': 'application/json' },
      body: JSON.stringify({ product: 'launcher', title: 'No version given', summary: 's', markdown: '- x' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain('version is required');
  });

  it('different versions coexist as separate entries', async () => {
    for (const version of ['0.2.8', '0.2.9']) {
      const res = await changelogApi.request('/changelog/release', {
        method: 'POST',
        headers: { ...SERVICE, 'content-type': 'application/json' },
        body: JSON.stringify({ ...release, version }),
      });
      expect(res.status).toBe(200);
    }
    const launchers = await listChangelogEntries({ limit: 50, product: 'launcher' });
    expect(launchers.map((e) => e.version)).toEqual(['0.2.9', '0.2.8']); // newest first
  });

  it('validates: product vocabulary, version charset, body presence, https-only releaseUrl', async () => {
    const post = (payload: Record<string, unknown>) =>
      changelogApi.request('/changelog/release', {
        method: 'POST',
        headers: { ...SERVICE, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    expect((await post({ ...release, product: 'saas' })).status).toBe(400);
    expect((await post({ ...release, version: 'not a version!' })).status).toBe(400);
    expect((await post({ ...release, body: '   ' })).status).toBe(400);
    expect((await post({ ...release, releaseUrl: 'http://insecure.example.com/x' })).status).toBe(400);
    expect((await post({ ...release, pr: 'not-a-number' })).status).toBe(400);
    expect((await post({ ...release, date: 'the day before yesterday' })).status).toBe(400);
    expect(entryCount()).toBe(0); // nothing partially written
  });

  it('a synced release is immediately visible through the public list with its badge', async () => {
    await changelogApi.request('/changelog/release', {
      method: 'POST',
      headers: { ...SERVICE, 'content-type': 'application/json' },
      body: JSON.stringify(release),
    });
    const res = await changelogApi.request('/changelog/list?limit=10&product=launcher');
    const json = (await res.json()) as { count: number; posts: Array<Record<string, unknown>> };
    expect(json.count).toBe(1);
    expect(json.posts[0]).toMatchObject({ id: 'launcher-0.2.8', product: 'launcher', version: '0.2.8' });
  });
});

describe('/changelog/post stamps product + version into the canonical store', () => {
  it('a Discord post dual-writes changelog_entry with the chosen product', async () => {
    const res = await changelogApi.request('/changelog/post', {
      method: 'POST',
      headers: { ...SERVICE, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Web fixes', description: 'site lead', changes: ['fixed a thing'], product: 'website' }),
    });
    expect(res.status).toBe(200);
    // The canonical store holds the new post AND the October 2026 seed history
    // (recordChangelogPost's legacy ensure seeds changelog_post; the canonical
    // backfill maps those seed-<slug> rows in) — 8 seeds + 1 post.
    const rows = await listChangelogEntries({ limit: 25 });
    expect(rows).toHaveLength(9);
    const post = rows.find((r) => r.id.startsWith('post-'))!;
    expect(post.product).toBe('website');
    expect(post.summary).toBe('site lead');
    expect(post.syncedAt).toBeNull(); // hand-posted, not synced
    expect(rows.filter((r) => r.id.startsWith('seed-'))).toHaveLength(0); // seeds surface under slugs
  });

  it('rejects a product outside the vocabulary', async () => {
    const res = await changelogApi.request('/changelog/post', {
      method: 'POST',
      headers: { ...SERVICE, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 't', changes: ['c'], product: 'saas' }),
    });
    expect(res.status).toBe(400);
    expect(entryCount()).toBe(0);
  });
});
