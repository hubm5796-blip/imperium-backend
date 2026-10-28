/**
 * One-shot generator for the golden import input: reads the website's
 * hand-written changelog array (src/lib/changelog.ts in the frontend repo)
 * and dumps it verbatim as JSON for scripts/import-site-changelog.mts.
 *
 * The frontend file is the source of the 40+ curated entries; this script only
 * serializes it. Re-run when the site gains entries BEFORE the next import:
 *
 *   npx tsx scripts/dump-site-changelog.mts <path-to-frontend>/src/lib/changelog.ts \
 *     scripts/data/site-changelog-2026-10-28.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const src = process.argv[2];
const out = process.argv[3];
if (!src || !out) {
  console.error('usage: tsx scripts/dump-site-changelog.mts <frontend>/src/lib/changelog.ts <out.json>');
  process.exit(2);
}

// The frontend module is plain exports (no imports of its own), so a regex-free
// dynamic import through tsx works even though the file lives in another repo.
const mod = (await import(pathToFileURL(src).href)) as {
  CHANGELOG: Array<Record<string, unknown>>;
};
if (!Array.isArray(mod.CHANGELOG) || mod.CHANGELOG.length === 0) {
  throw new Error(`no CHANGELOG array found in ${src}`);
}
writeFileSync(out, JSON.stringify(mod.CHANGELOG, null, 2) + '\n');
console.log(`wrote ${mod.CHANGELOG.length} entries to ${out}`);
