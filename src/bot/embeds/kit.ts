/**
 * V6 02-02 — The Rich Embed Kit: rank-tinted colors, avatars, progress bars,
 * and pagination. Every bot command renders through these helpers so the
 * entire product feels designed, not assembled.
 *
 * Palette doctrine (01-DESIGN-SYSTEM): gold is the brand; rank tier determines
 * embed color so a player's card gets more regal as they climb.
 */
import { EmbedBuilder } from '@discordjs/builders';
import { BRANDING } from '../config.js';

// ── Palette ─────────────────────────────────────────────────────────────────
export const PALETTE = {
  brand: 0xd4af37,      // Roman gold
  danger: 0xdc2626,
  success: 0x16a34a,
  info: 0x3b82f6,
  warning: 0xf59e0b,
  premium: 0x9b59b6,
} as const;

/** Rank-tinted embed color: the card gets more regal as the player climbs. */
export function rankColor(rank: number, prestige: number = 0): number {
  if (prestige >= 5) return 0x9d174d;  // deep magenta — multi-prestige royalty
  if (prestige >= 1) return 0x7c3aed;  // violet — prestige nobility
  if (rank >= 90) return 0x9d174d;     // near-max rank
  if (rank >= 50) return 0x7c3aed;     // high nobility
  if (rank >= 10) return PALETTE.brand; // the gold standard
  return 0x64748b;                     // slate — the honest plebeian
}

// ── Avatar URLs ─────────────────────────────────────────────────────────────
export function avatarUrl(uuidOrName: string): string {
  return `https://mc-heads.net/avatar/${uuidOrName}/128`;
}
export function bodyUrl(uuidOrName: string): string {
  return `https://mc-heads.net/body/${uuidOrName}/128`;
}
export function bustUrl(uuidOrName: string): string {
  return `https://crafatar.com/renders/head/${uuidOrName}?overlay&scale=4`;
}

// ── Progress bar ────────────────────────────────────────────────────────────
const FILLED = '▰';
const EMPTY = '▱';

/** A visual progress bar (0..1 fraction). */
export function progressBar(fraction: number, width = 10): string {
  const f = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(f * width);
  return FILLED.repeat(filled) + EMPTY.repeat(width - filled);
}

/** Progress bar with a percentage label. */
export function progressLabel(fraction: number, width = 10): string {
  const pct = Math.round(Math.max(0, Math.min(1, fraction)) * 100);
  return `${progressBar(fraction, width)} ${pct}%`;
}

// ── Chrome ──────────────────────────────────────────────────────────────────
export function branded(embed: EmbedBuilder, color: number = PALETTE.brand): EmbedBuilder {
  return embed
    .setColor(color)
    .setFooter({ text: `${BRANDING.serverIp} • ${BRANDING.inviteBlurb}` })
    .setTimestamp();
}

/** A player-card embed with avatar thumbnail, rank-tinted color, and branding. */
export function playerCard(username: string, uuid: string, rank: number, prestige: number = 0): EmbedBuilder {
  return branded(new EmbedBuilder(), rankColor(rank, prestige))
    .setAuthor({ name: username, iconURL: avatarUrl(uuid) })
    .setThumbnail(avatarUrl(uuid));
}

// ── Pagination ──────────────────────────────────────────────────────────────
export interface Page<T> {
  items: T[];
  page: number;
  totalPages: number;
  total: number;
}

export function paginate<T>(items: T[], page: number, perPage: number): Page<T> {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const clampedPage = Math.max(1, Math.min(page, totalPages));
  const start = (clampedPage - 1) * perPage;
  return {
    items: items.slice(start, start + perPage),
    page: clampedPage,
    totalPages,
    total,
  };
}

/** Footer text for a paginated view. */
export function pageFooter(page: Page<unknown>): string {
  return `Page ${page.page}/${page.totalPages} • ${page.total} total`;
}

// ── Relative time ───────────────────────────────────────────────────────────
export function relativeTime(iso: string): string {
  return `<t:${Math.floor(Date.parse(iso) / 1000)}:R>`;
}

export function shortDate(iso: string): string {
  return `<t:${Math.floor(Date.parse(iso) / 1000)}:d>`;
}
