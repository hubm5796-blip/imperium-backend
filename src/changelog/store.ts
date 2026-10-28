/**
 * The canonical changelog store — issue Romanica-MC/romanica-frontend#9.
 *
 * ONE D1 table (changelog_entry) holds every changelog entry regardless of
 * origin: the site's curated updates (imported once by
 * scripts/import-site-changelog.mts, slugs preserved as ids), Discord-posted
 * server changelogs (/changelog/post dual-writes here) and GitHub release
 * syncs (POST /changelog/release upserts here, stamped synced_at).
 *
 * Migration, not break: rows from the legacy changelog_post table
 * (src/db/changelogStore.ts, the pre-#9 store) are backfilled into
 * changelog_entry on first ensure. The legacy table's eight `seed-*` rows are
 * known to be `seed-` + the site slug of the same update, so the backfill maps
 * `seed-<slug>` -> `<slug>` — the import then overwrites those rows with the
 * site's richer hand-written prose and the honest product. At every step
 * (backfilled only, or imported) every historical row stays served; nothing
 * is deleted.
 *
 * Failure doctrine (mirrors db/changelogStore.ts): reads degrade to empty and
 * never throw; upserts THROW — the release-sync route must report a failed
 * sync honestly (an idempotent upsert that lies about success is worse than a
 * 502), while the Discord post path keeps its write-after-action absorb.
 */
import { getD1 } from '../db/pool.js';
import { logger } from '../utils/logger.js';
import type { ChangelogEntryInput, ChangelogEntryRecord, ChangelogEntryRow, ChangelogProduct } from './types.js';
import { rowToRecord } from './types.js';

export const CHANGELOG_ENTRY_DDL = `
CREATE TABLE IF NOT EXISTS changelog_entry (
  id        TEXT PRIMARY KEY,
  date      INTEGER NOT NULL,
  product   TEXT NOT NULL,
  version   TEXT,
  title     TEXT NOT NULL,
  summary   TEXT NOT NULL,
  body      TEXT NOT NULL DEFAULT '{}',
  links     TEXT NOT NULL DEFAULT '{}',
  related   TEXT NOT NULL DEFAULT '[]',
  synced_at INTEGER
)`;

const IDX_DATE = `CREATE INDEX IF NOT EXISTS idx_changelog_entry_date ON changelog_entry(date DESC, id DESC)`;
const IDX_PRODUCT = `CREATE INDEX IF NOT EXISTS idx_changelog_entry_product ON changelog_entry(product, date DESC, id DESC)`;

/**
 * Legacy backfill. Every historical changelog_post row keeps working:
 *   id:      verbatim (post-* rows); `seed-<slug>` mapped to `<slug>` so the
 *            site import can own the canonical row under the permalink id.
 *   date:    the legacy ts (ms epoch).
 *   product: 'server' — the legacy store only held Discord-posted server
 *            changelogs (and the seed backfill, corrected to its real product
 *            when the site import upserts the same slug).
 *   summary: the legacy lead (title as fallback — summary is NOT NULL).
 * INSERT OR IGNORE keeps this idempotent across cold isolates and safe when
 * the import already wrote the richer row.
 */
const BACKFILL_SQL = `
INSERT OR IGNORE INTO changelog_entry (id, date, product, version, title, summary, body, links, related, synced_at)
SELECT
  CASE WHEN id LIKE 'seed-%' THEN substr(id, 6) ELSE id END,
  ts,
  'server',
  NULL,
  title,
  COALESCE(NULLIF(lead, ''), title),
  COALESCE(NULLIF(body_json, ''), '{}'),
  '{}',
  '[]',
  NULL
FROM changelog_post`;

let schemaReady = false;
let backfillSettled = false;

/**
 * Lazy DDL + one-way legacy backfill. The legacy ensure (create + seed of
 * changelog_post) is deliberately NOT called from here — src/db/changelogStore.ts
 * delegates to THIS module, so the dependency stays one-way (legacy -> canonical).
 * A missing changelog_post means a fresh D1 with no history to carry over; the
 * import script owns seeding history there, so that case settles the backfill
 * without log spam. Any OTHER backfill failure is retried on the next ensure.
 */
export async function ensureChangelogEntrySchema(): Promise<void> {
  if (schemaReady) return;
  const d1 = getD1();
  await d1.prepare(CHANGELOG_ENTRY_DDL).run();
  await d1.prepare(IDX_DATE).run();
  await d1.prepare(IDX_PRODUCT).run();
  if (!backfillSettled) {
    try {
      await d1.prepare(BACKFILL_SQL).run();
      backfillSettled = true;
    } catch (err) {
      if (/no such table/i.test(String(err))) {
        backfillSettled = true; // fresh D1 — nothing to migrate, import owns history
      } else {
        logger.error({ err: String(err) }, 'changelog_entry legacy backfill failed (retried on next ensure)');
      }
    }
  }
  schemaReady = true;
}

/** Test hook: force the next ensure to re-run (schema migrations in long-lived processes/tests). */
export function __resetChangelogEntrySchemaForTests(): void {
  schemaReady = false;
  backfillSettled = false;
}

/** Upsert one entry by id. Returns whether the row was created (vs updated). THROWS on failure. */
export async function upsertChangelogEntry(entry: ChangelogEntryInput): Promise<{ id: string; created: boolean }> {
  await ensureChangelogEntrySchema();
  const d1 = getD1();
  const existing = await d1
    .prepare('SELECT id FROM changelog_entry WHERE id = ?')
    .bind(entry.id)
    .first<{ id: string }>();
  const created = !existing;
  if (created) {
    await d1
      .prepare(
        'INSERT INTO changelog_entry (id, date, product, version, title, summary, body, links, related, synced_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        entry.id,
        entry.date,
        entry.product,
        entry.version ?? null,
        entry.title,
        entry.summary,
        JSON.stringify(entry.body),
        JSON.stringify(entry.links ?? {}),
        JSON.stringify(entry.related ?? []),
        entry.syncedAt ?? null,
      )
      .run();
  } else {
    await d1
      .prepare(
        'UPDATE changelog_entry SET date = ?, product = ?, version = ?, title = ?, summary = ?, body = ?, links = ?, related = ?, synced_at = ? WHERE id = ?',
      )
      .bind(
        entry.date,
        entry.product,
        entry.version ?? null,
        entry.title,
        entry.summary,
        JSON.stringify(entry.body),
        JSON.stringify(entry.links ?? {}),
        JSON.stringify(entry.related ?? []),
        entry.syncedAt ?? null,
        entry.id,
      )
      .run();
  }
  return { id: entry.id, created };
}

/** Newest first, stable tiebreak on id. Optional exact product filter. Degrades to []. */
export async function listChangelogEntries(options: {
  limit: number;
  product?: ChangelogProduct;
}): Promise<ChangelogEntryRecord[]> {
  const limit = Math.min(Math.max(1, Math.floor(options.limit) || 1), 200);
  try {
    await ensureChangelogEntrySchema();
    const d1 = getD1();
    const rows = options.product
      ? await d1
          .prepare('SELECT id, date, product, version, title, summary, body, links, related, synced_at FROM changelog_entry WHERE product = ? ORDER BY date DESC, id DESC LIMIT ?')
          .bind(options.product, limit)
          .all<ChangelogEntryRow>()
      : await d1
          .prepare('SELECT id, date, product, version, title, summary, body, links, related, synced_at FROM changelog_entry ORDER BY date DESC, id DESC LIMIT ?')
          .bind(limit)
          .all<ChangelogEntryRow>();
    return (rows.results ?? []).map(rowToRecord);
  } catch (err) {
    logger.error({ err: String(err) }, 'changelog_entry list failed');
    return [];
  }
}
