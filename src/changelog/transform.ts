/**
 * Site-entry -> canonical-entry transform for the one-time import
 * (scripts/import-site-changelog.mts). Pure, no I/O — the golden-file test
 * pins it against the real dumped site data.
 *
 * PERMALINK CONTRACT: the site entry's slug becomes the canonical id, so
 * /changelog/<slug> keeps resolving when the site switches to the API. Never
 * rename a slug here or in the site array without a redirect.
 *
 * PRODUCT MAPPING (judgment calls, entry by entry — the site entries often mix
 * products; each is marked by its HEADLINE change, the thing the title leads
 * with; the body JSON keeps the full picture either way):
 *
 *   server (default — most site entries describe game-server changes):
 *     bedrock-nethernet                     Bedrock protocol compat lives in the server translation layer
 *     store-link-rank-protection-anticheat  in-game /store link, rank-load retry, anticheat — all server
 *     cassius-guide-at-spawn                in-world NPC at spawn
 *     romanica-name-everywhere              in-game strings in 45 languages (site guide links are a rider)
 *     legion-commands-and-navy-map          tab completion is the headline; the map restyle rides along
 *     faster-joins-smoother-onboarding      pack caching + anticheat + tab completion — server behavior
 *     story-guidance-mine-restoration       story line + NPC compass targets in the game
 *     mine-restoration-underway             game world state
 *     objective-bar-always-on               in-game HUD guidance
 *     bug-report-command                    in-game /bug command
 *     discord-bot-three-new-commands        the bot ships from the backend; the vocabulary has no
 *                                           'bot', and its commands mirror server data — server
 *     last-two-frozen-mines-open            mine ladder (game world)
 *     frozen-mine-band-opens                mine ladder (game world)
 *     263-clients-and-lighter-mobile-data   cross-version compat layer is the headline (pack/client
 *                                           data weights ride along)
 *     smoother-first-minutes-on-touch       anticheat behavior
 *     faster-joins-during-busy-periods      server join pipeline
 *     praeneste-shaft-and-first-hour-gifts  mine + new-account economy
 *
 *   client:
 *     client-beta-24-breadcrumbs, romanica-client-beta12, romanica-client-beta11,
 *     imperium-client-beta9, imperium-client-beta8, imperium-client-beta7,
 *     imperium-client-beta6, imperium-client-beta5, imperium-client-beta2
 *
 *   launcher:
 *     launcher-0-2-7, launcher-0-2-6, launcher-0-1-2, launcher-0-1-1
 *
 *   website:
 *     sign-in-with-microsoft                website login
 *     honest-store-page                     store tier copy is site content
 *     store-leaderboard-guides-polish       site pages
 *     site-wide-polish-pass                 site theme
 *     romanica-net-live-store-fixed         domain cutover + web checkout is the headline
 *                                           (launcher/client art riders keep their own entries)
 *     romanica-new-emblem                   the emblem's canonical home is the site/brand
 *     romanica-rename                       the rebrand announcement (permalink anchors the rebrand)
 *     faster-website-honest-map             site performance + map
 *     site-speaks-three-languages           site i18n
 */
import type { ChangelogEntryInput, ChangelogProduct } from './types.js';

/** Shape of one entry in the site's src/lib/changelog.ts CHANGELOG array. */
export interface SiteChangelogEntry {
  slug: string;
  date: string; // display date, e.g. '27 October 2026'
  sortKey: string; // ISO date, e.g. '2026-10-27' — the authoritative sort date
  type: 'Fix' | 'Update' | 'Announcement';
  title: string;
  summary: string;
  keyChanges: string[];
  action?: string;
  tags: string[];
  readHref?: string;
}

/** Site slugs whose headline product is the client. */
const CLIENT_SLUGS = new Set([
  'client-beta-24-breadcrumbs',
  'romanica-client-beta12',
  'romanica-client-beta11',
  'imperium-client-beta9',
  'imperium-client-beta8',
  'imperium-client-beta7',
  'imperium-client-beta6',
  'imperium-client-beta5',
  'imperium-client-beta2',
]);

/** Site slugs whose headline product is the launcher. */
const LAUNCHER_SLUGS = new Set(['launcher-0-2-7', 'launcher-0-2-6', 'launcher-0-1-2', 'launcher-0-1-1']);

/** Site slugs whose headline product is the website. */
const WEBSITE_SLUGS = new Set([
  'sign-in-with-microsoft',
  'honest-store-page',
  'store-leaderboard-guides-polish',
  'site-wide-polish-pass',
  'romanica-net-live-store-fixed',
  'romanica-new-emblem',
  'romanica-rename',
  'faster-website-honest-map',
  'site-speaks-three-languages',
]);

/** The honest product for a site entry (see the mapping notes above). */
export function siteEntryProduct(site: Pick<SiteChangelogEntry, 'slug'>): ChangelogProduct {
  if (CLIENT_SLUGS.has(site.slug)) return 'client';
  if (LAUNCHER_SLUGS.has(site.slug)) return 'launcher';
  if (WEBSITE_SLUGS.has(site.slug)) return 'website';
  return 'server';
}

/**
 * Version string when the slug/title states one unambiguously:
 *   launcher-0-2-7          -> 0.2.7
 *   "Romanica Client beta.24" -> 0.2.0-beta.24 (the client's own semver line,
 *                                per the romanica-new-emblem entry text)
 * Anything else -> null (most site entries are not versioned releases).
 */
export function siteEntryVersion(site: Pick<SiteChangelogEntry, 'slug' | 'title'>): string | null {
  const launcher = /^launcher-(\d+-\d+-\d+)$/.exec(site.slug);
  if (launcher) return launcher[1]!.replaceAll('-', '.');
  if (CLIENT_SLUGS.has(site.slug)) {
    const beta = /beta\.(\d+)/i.exec(site.title);
    if (beta) return `0.2.0-beta.${beta[1]}`;
  }
  return null;
}

/** Sort-key date -> ms epoch (UTC midnight; the site's sortKey is date-only). */
export function siteEntryDateMs(site: Pick<SiteChangelogEntry, 'sortKey'>): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(site.sortKey)) {
    throw new Error(`site entry has malformed sortKey: ${JSON.stringify(site.sortKey)}`);
  }
  return Date.parse(`${site.sortKey}T00:00:00.000Z`);
}

/** Transform one site entry into the canonical input shape. Throws on structurally broken input. */
export function siteEntryToChangelogEntry(site: SiteChangelogEntry): ChangelogEntryInput {
  if (!site.slug || !site.title || !site.summary) {
    throw new Error(`site entry missing slug/title/summary: ${JSON.stringify(site.slug ?? site)}`);
  }
  if (!Array.isArray(site.keyChanges)) {
    throw new Error(`site entry ${site.slug}: keyChanges must be an array`);
  }
  const body: ChangelogEntryInput['body'] = {
    keyChanges: site.keyChanges,
    tags: Array.isArray(site.tags) ? site.tags : [],
  };
  if (site.action) body.action = site.action;
  if (site.readHref) body.readHref = site.readHref;
  return {
    id: site.slug,
    date: siteEntryDateMs(site),
    product: siteEntryProduct(site),
    version: siteEntryVersion(site),
    title: site.title,
    summary: site.summary,
    body,
    links: {}, // curated site entries carry no release/PR links
    related: [], // the site computes related-by-tags at render time; the field exists for cross-product links
    syncedAt: null, // curated content, not a synced release
  };
}
