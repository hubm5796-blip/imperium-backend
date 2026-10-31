/**
 * Changelog domain types — issue Romanica-MC/romanica-frontend#9.
 *
 * ONE changelog for everything: the site's curated updates, Discord-posted
 * server changelogs and GitHub release syncs land in a single D1 store
 * (changelog_entry) shaped as:
 *
 *   { id, date, product, version?, title, summary, body, links, related, syncedAt? }
 *
 * THE PRODUCT VOCABULARY LIVES ONLY HERE. The website, the launcher news
 * panel, the client title screen and the bot all consume it through
 * GET /api/v2/changelog/list (whose response carries `products` straight from
 * this constant) — no consumer hardcodes a second copy.
 */

/** The closed product vocabulary. Adding a product means editing THIS line and nothing else. */
export const CHANGELOG_PRODUCTS = ['server', 'client', 'launcher', 'website', 'pack'] as const;
export type ChangelogProduct = (typeof CHANGELOG_PRODUCTS)[number];

export function isChangelogProduct(value: string): value is ChangelogProduct {
  return (CHANGELOG_PRODUCTS as readonly string[]).includes(value);
}

/*
 * The five closed entry categories (S2-L10, STYLE.md), new to the store with
 * the per-entry embed work: `changelog_entry.category` is NULL on legacy
 * rows (the site renders those with the area chip only). The label/colour/
 * emoji display metadata lives in src/changelog/embed.ts.
 */
export const CHANGELOG_CATEGORY_IDS = ['fix', 'new', 'improvement', 'announcement', 'correction'] as const;
export type ChangelogCategory = (typeof CHANGELOG_CATEGORY_IDS)[number];

export function isChangelogCategory(value: string): value is ChangelogCategory {
  return (CHANGELOG_CATEGORY_IDS as readonly string[]).includes(value);
}

/**
 * Body payload, stored as JSON in `changelog_entry.body`. A union of the three
 * writer shapes, rendered best-effort by consumers:
 *  - curated/import entries (the site's changelog.ts): keyChanges/action/tags/readHref
 *  - Discord-posted entries (/changelog/post): sections/changes
 *  - release syncs (POST /changelog/release): markdown
 */
export interface ChangelogBody {
  /** Site-import narrative bullets (problem -> impact -> fix -> action). */
  keyChanges?: string[];
  /** Standalone player action line, when the entry has one. */
  action?: string;
  /** Site-import tags (drive the site's related-entries feature). */
  tags?: string[];
  /** Related site page path (e.g. "/progression"). */
  readHref?: string;
  /** Discord-style grouped bullets. */
  sections?: { name: string; changes: string[] }[];
  /** Discord-style flat bullets. */
  changes?: string[];
  /** GitHub release notes (markdown), from the release sync. */
  markdown?: string;
  /** S2-L10 v2 entries: the 1-3 embed bullets (the embed body). */
  bullets?: string[];
  /** S2-L10 v2 entries: fuller paragraphs, entry page only. */
  body?: string[];
  /** S2-L10 correction entries: permalink of the corrected entry. */
  correctionOf?: string;
}

export interface ChangelogLinks {
  /** GitHub release URL (release syncs). */
  release?: string;
  /** PR reference — number string or full URL. */
  pr?: string;
  /** Issue reference — number string or full URL. */
  issue?: string;
}

/** A canonical changelog row as stored/served. `date`/`syncedAt` are ms epoch.
 *  `category` is NULL on legacy rows (pre-S2-L10) — the site renders those
 *  with the area chip only. */
export interface ChangelogEntryRecord {
  id: string;
  date: number;
  product: ChangelogProduct;
  version: string | null;
  category: ChangelogCategory | null;
  title: string;
  summary: string;
  body: ChangelogBody;
  links: ChangelogLinks;
  related: string[];
  syncedAt: number | null;
}

/** Everything a writer must supply to upsert an entry (id + product + title + summary minimum). */
export interface ChangelogEntryInput {
  id: string;
  date: number;
  product: ChangelogProduct;
  version?: string | null;
  /** S2-L10 entry category; null/undefined = legacy-shaped row (no embed). */
  category?: ChangelogCategory | null;
  title: string;
  summary: string;
  body: ChangelogBody;
  links?: ChangelogLinks;
  related?: string[];
  /** Stamp set by the release sync; null/undefined for curated + Discord posts. */
  syncedAt?: number | null;
}

/** Column shape of the D1 row (JSON columns serialized). */
export interface ChangelogEntryRow {
  id: string;
  date: number;
  product: string;
  version: string | null;
  category: string | null;
  title: string;
  summary: string;
  body: string;
  links: string;
  related: string;
  synced_at: number | null;
}

export function rowToRecord(row: ChangelogEntryRow): ChangelogEntryRecord {
  return {
    id: row.id,
    date: row.date,
    product: isChangelogProduct(row.product) ? row.product : 'server',
    version: row.version,
    category: isChangelogCategory(row.category ?? '') ? (row.category as ChangelogCategory) : null,
    title: row.title,
    summary: row.summary,
    body: safeParse<ChangelogBody>(row.body, {}),
    links: safeParse<ChangelogLinks>(row.links, {}),
    related: safeParse<string[]>(row.related, []),
    syncedAt: row.synced_at,
  };
}

function safeParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as T;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}
