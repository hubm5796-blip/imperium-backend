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
import type { ChangelogEntryInput, ChangelogProduct, ChangelogCategory } from './types.js';
import { isChangelogCategory, isChangelogProduct } from './types.js';

/**
 * Shape of one entry in the site's src/lib/changelog.ts CHANGELOG array.
 *
 * v2 (S2-L10, 2026-10-30 reshape): category/area/bullets/body/correctionOf;
 * the v1 fields (type/keyChanges) stay accepted so the pre-reshape golden
 * dump keeps transforming. A v2 entry carries NO keyChanges — its three
 * strongest changes ARE the bullets.
 */
export interface SiteChangelogEntry {
  slug: string;
  date: string; // display date, e.g. '27 October 2026'
  sortKey: string; // ISO date, e.g. '2026-10-27' — the authoritative sort date
  type?: 'Fix' | 'Update' | 'Announcement'; // v1 only
  category?: ChangelogCategory; // v2: the five closed categories
  area?: ChangelogProduct; // v2: the five-product vocabulary (honest per-entry)
  title: string;
  summary: string;
  keyChanges?: string[]; // v1: narrative bullets
  bullets?: string[]; // v2: the 1-3 embed bullets
  body?: string[]; // v2: fuller paragraphs, entry page only
  action?: string;
  tags: string[];
  readHref?: string;
  correctionOf?: string; // v2: correction entries cite the corrected permalink
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
  const isV2 = site.category !== undefined || site.bullets !== undefined;
  if (isV2) {
    // v2 guards: the closed vocabularies are validated at import time so a
    // hand-edited dump can never land a junk category/area in the store.
    if (!isChangelogCategory(String(site.category))) {
      throw new Error(`site entry ${site.slug}: category '${site.category}' outside the closed vocabulary`);
    }
    if (site.area !== undefined && !isChangelogProduct(site.area)) {
      throw new Error(`site entry ${site.slug}: area '${site.area}' outside the product vocabulary`);
    }
    if (!Array.isArray(site.bullets) || site.bullets.length < 1 || site.bullets.length > 3) {
      throw new Error(`site entry ${site.slug}: v2 entries carry 1-3 bullets`);
    }
  } else if (!Array.isArray(site.keyChanges)) {
    throw new Error(`site entry ${site.slug}: keyChanges must be an array`);
  }
  const body: ChangelogEntryInput['body'] = isV2
    ? {
        bullets: site.bullets!,
        tags: Array.isArray(site.tags) ? site.tags : [],
      }
    : {
        keyChanges: site.keyChanges!,
        tags: Array.isArray(site.tags) ? site.tags : [],
      };
  if (isV2 && site.body) body.body = site.body;
  if (isV2 && site.correctionOf) body.correctionOf = site.correctionOf;
  if (site.action) body.action = site.action;
  if (site.readHref) body.readHref = site.readHref;
  return {
    id: site.slug,
    date: siteEntryDateMs(site),
    // v2 entries carry their own honest area — it wins over the v1 slug map.
    product: (isV2 && site.area) || siteEntryProduct(site),
    version: siteEntryVersion(site),
    category: isV2 ? (site.category as ChangelogCategory) : null,
    title: site.title,
    summary: site.summary,
    body,
    links: {}, // curated site entries carry no release/PR links
    related: [], // the site computes related-by-tags at render time; the field exists for cross-product links
    syncedAt: null, // curated content, not a synced release
  };
}
