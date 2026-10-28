-- changelog_entry: the ONE changelog store (Romanica-MC/romanica-frontend#9).
-- Backend-only D1. Holds every changelog entry regardless of origin:
--   - the website's curated updates (imported once by
--     scripts/import-site-changelog.mts; each site slug is preserved as the
--     row id so /changelog/<slug> permalinks survive the site's switch to
--     this API),
--   - Discord-posted server changelogs (POST /api/v2/changelog/post
--     dual-writes here; product 'server'),
--   - GitHub release syncs (POST /api/v2/changelog/release upserts here,
--     stamped synced_at, deterministic id `<product>-<version>`).
--
-- The product vocabulary (server|client|launcher|website|pack) lives ONLY in
-- src/changelog/types.ts (CHANGELOG_PRODUCTS) — this table is its storage,
-- not its definition.
--
-- Migration, not break: the pre-#9 store (changelog_post, see
-- src/db/changelogStore.ts) is backfilled into this table by
-- ensureChangelogEntrySchema() (src/changelog/store.ts) with
-- `seed-<slug>` ids mapped to `<slug>`; changelog_post itself is kept
-- write-only for history and the legacy prune lever.
--
-- The route ALSO ensures this schema lazily (CREATE TABLE IF NOT EXISTS on
-- first use) because deploys are git-push autobuilds and nothing runs
-- `wrangler d1 migrations apply` -- this file documents the canonical shape.
CREATE TABLE IF NOT EXISTS changelog_entry (
  id        TEXT PRIMARY KEY,      -- site slug (curated), `<product>-<version>` (release sync), `post-<rand>` (Discord post)
  date      INTEGER NOT NULL,      -- publication/release date, ms epoch
  product   TEXT NOT NULL,         -- 'server' | 'client' | 'launcher' | 'website' | 'pack' (vocabulary: src/changelog/types.ts)
  version   TEXT,                  -- e.g. "0.2.7", "0.2.0-beta.24"; NULL for unversioned entries
  title     TEXT NOT NULL,
  summary   TEXT NOT NULL,         -- one-line lead
  body      TEXT NOT NULL DEFAULT '{}', -- JSON ChangelogBody: keyChanges/action/tags/readHref (curated), sections/changes (Discord), markdown (releases)
  links     TEXT NOT NULL DEFAULT '{}', -- JSON { release?, pr?, issue? }
  related   TEXT NOT NULL DEFAULT '[]', -- JSON [id, ...]
  synced_at INTEGER                -- ms epoch of the last release sync; NULL = curated/hand-posted
);
CREATE INDEX IF NOT EXISTS idx_changelog_entry_date ON changelog_entry(date DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_changelog_entry_product ON changelog_entry(product, date DESC, id DESC);
