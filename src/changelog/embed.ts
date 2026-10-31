/**
 * The per-entry Discord embed builder (S2-L10) — the backend mirror of the
 * frontend src/lib/changelog-embed.ts, specified by docs/changelog/EMBED-
 * FORMAT.md (frontend repo).
 *
 * ONE CHANGE, ONE ENTRY, ONE EMBED: the embed is a pure function of the
 * stored changelog entry, so the site page and the Discord post are renders
 * of the same data and cannot drift. The category/area vocabularies (labels,
 * colours, emoji) are DEFINED ONCE in the frontend src/lib/changelog.ts; the
 * copies below are pinned against that source by test
 * (s2-l10-changelog-entry.test.ts "vocabulary drift guard") so a change on
 * either side fails the suite instead of silently diverging.
 *
 * This module never posts anything — the route owns the transport.
 */

/** The store's product + category vocabularies (defined once, in types.ts). */
import type { ChangelogCategory, ChangelogProduct } from './types.js';

/** label/colour/emoji mirrored from frontend CHANGELOG_CATEGORIES (drift-pinned by test). */
export const CHANGELOG_CATEGORIES: Record<ChangelogCategory, { label: string; color: number; emoji: string }> = {
  fix: { label: 'Fix', color: 0xb93608, emoji: '\u{1F527}' }, // wrench
  new: { label: 'New', color: 0xd0b488, emoji: '\u2728' }, // sparkles
  improvement: { label: 'Improvement', color: 0x55ef9f, emoji: '\u2B06\uFE0F' }, // up arrow
  announcement: { label: 'Announcement', color: 0xece7df, emoji: '\u{1F4E3}' }, // megaphone
  correction: { label: 'Correction', color: 0xf5a623, emoji: '\u{1F504}' }, // counterclockwise arrows
};

/** Area labels mirrored from frontend CHANGELOG_AREAS (drift-pinned by test). */
export const CHANGELOG_AREA_LABELS: Record<ChangelogProduct, string> = {
  server: 'Server',
  client: 'Client',
  launcher: 'Launcher',
  website: 'Website',
  pack: 'Resource pack',
};

export const CHANGELOG_SITE_BASE = 'https://romanica.net';

/** The site icon, served by the site itself at a stable URL (embed footer icon). */
export const CHANGELOG_FOOTER_ICON = `${CHANGELOG_SITE_BASE}/icon.png`;

/** Stable permalink of an entry — the embed title and read-more link point here. */
export function changelogEntryUrl(slug: string): string {
  return `${CHANGELOG_SITE_BASE}/changelog/${slug}`;
}

/**
 * Owner-facing garble guard (identical to the frontend asciify and the
 * legacy dms.ts one): some clients render em-dashes, middle dots, curly
 * quotes and multiplication signs as replacement characters. Every string
 * that reaches a Discord embed passes through this first — plain ASCII
 * regardless of what the caller composed.
 */
export function asciify(input: string): string {
  return input
    .replace(/[\u2014\u2013]/g, '-')
    .replace(/[\u2022\u00b7]/g, '-')
    .replace(/\u00d7/g, 'x')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7e]/g, '');
}

/** Discord embed limits the builder must respect (validated by tests). */
export const DISCORD_LIMITS = {
  title: 256,
  description: 4096,
  authorName: 256,
  fieldName: 256,
  fieldValue: 1024,
  footerText: 2048,
  bullets: 3,
} as const;

export interface DiscordEmbed {
  title: string;
  url: string;
  color: number;
  author: { name: string };
  description: string;
  fields: { name: string; value: string; inline: boolean }[];
  footer: { text: string; icon_url: string };
  timestamp: string;
}

/** The full message payload the bot endpoint accepts (one embed per change). */
export interface DiscordEmbedMessage {
  embeds: DiscordEmbed[];
  allowed_mentions: { parse: [] };
}

/** The entry fields the embed renders (the store record's embed projection). */
export interface EmbedEntry {
  slug: string;
  /** ISO date 'YYYY-MM-DD' — the deterministic embed timestamp source. */
  sortKey: string;
  category: ChangelogCategory;
  area: ChangelogProduct;
  title: string;
  summary: string;
  bullets: string[];
}

/** Deterministic timestamp for an entry: its own date, never the post clock —
 *  posts are re-runnable and always render identically. */
function entryTimestamp(sortKey: string): string {
  return `${sortKey}T12:00:00.000Z`;
}

/** Build the owner-style embed for one entry (EMBED-FORMAT.md section 1). */
export function buildChangelogEmbed(entry: EmbedEntry): DiscordEmbed {
  const category = CHANGELOG_CATEGORIES[entry.category];
  const areaLabel = CHANGELOG_AREA_LABELS[entry.area];
  const url = changelogEntryUrl(entry.slug);

  const lines: string[] = [asciify(entry.summary), ''];
  for (const bullet of entry.bullets.slice(0, DISCORD_LIMITS.bullets)) {
    lines.push(`- ${asciify(bullet)}`);
  }
  lines.push('', `Read the full update: ${url}`);

  return {
    title: asciify(entry.title).slice(0, DISCORD_LIMITS.title),
    url,
    color: category.color,
    author: {
      // The category emoji is Discord-only; asciify keeps the label after it intact.
      name: `${category.emoji} ${asciify(category.label)}`.slice(0, DISCORD_LIMITS.authorName),
    },
    description: lines.join('\n').slice(0, DISCORD_LIMITS.description),
    fields: [
      { name: 'Area', value: asciify(areaLabel).slice(0, DISCORD_LIMITS.fieldValue), inline: true },
    ],
    footer: { text: 'Romanica Changelog', icon_url: CHANGELOG_FOOTER_ICON },
    timestamp: entryTimestamp(entry.sortKey),
  };
}

/** The message payload wrapping one embed (what the bot endpoint accepts verbatim). */
export function buildChangelogEmbedMessage(entry: EmbedEntry): DiscordEmbedMessage {
  return {
    embeds: [buildChangelogEmbed(entry)],
    allowed_mentions: { parse: [] },
  };
}

/**
 * The TRANSITION render for legacy POST /changelog/post bodies (EMBED-FORMAT
 * section 2.3): keep accepting the old title/description/sections/changes
 * shape, but render it through the new embed template — category inferred
 * `announcement`, colour from the table, Area field, Romanica Changelog
 * footer — so even old-style posts look like the new format.
 *
 * Differences from the per-entry builder, by design (labeled in the packet):
 *  - the legacy body is NOT an entry in the STYLE.md schema, so ALL its
 *    changes/sections render (the <=3 bullet cap is an entry rule); the
 *    description keeps the 4096 clamp,
 *  - there is no entry date, so the timestamp is the post clock,
 *  - the url is the store row's permalink (id `post-*`, served by the site).
 */
export function buildLegacyPostEmbed(input: {
  title: string;
  description: string;
  sections: { name: string; changes: string[] }[];
  changes: string[];
  product: ChangelogProduct;
  slug: string;
  nowIso: string;
}): DiscordEmbedMessage {
  const category = CHANGELOG_CATEGORIES.announcement;
  const url = changelogEntryUrl(input.slug);
  // Per-line 500 clamp preserved from the pre-S2-L10 render (a wall-of-text
  // change could otherwise eat the whole 4096 budget alone).
  const bullet = (c: string): string => `- ${asciify(c).slice(0, 500)}`;
  const sectionText = input.sections
    .map((sec) => `**${asciify(sec.name)}**\n${sec.changes.map(bullet).join('\n')}`)
    .join('\n\n');
  const flatText = input.changes.map(bullet).join('\n');
  const lead = input.description ? asciify(input.description) + '\n\n' : '';
  const description = `${lead}${sectionText || flatText}\n\nRead the full update: ${url}`;

  return {
    embeds: [
      {
        title: asciify(input.title).slice(0, DISCORD_LIMITS.title),
        url,
        color: category.color,
        author: { name: `${category.emoji} ${asciify(category.label)}`.slice(0, DISCORD_LIMITS.authorName) },
        description: description.slice(0, DISCORD_LIMITS.description),
        fields: [
          { name: 'Area', value: asciify(CHANGELOG_AREA_LABELS[input.product]).slice(0, DISCORD_LIMITS.fieldValue), inline: true },
        ],
        footer: { text: 'Romanica Changelog', icon_url: CHANGELOG_FOOTER_ICON },
        timestamp: input.nowIso,
      },
    ],
    allowed_mentions: { parse: [] },
  };
}
