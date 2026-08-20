/**
 * Shared configuration and constants for the ImperiumMC Discord bot.
 */

/** Roman-themed color palette (hex literals for EmbedBuilder).
 *  Aligned to the locked design-system tokens (01-DESIGN-SYSTEM §2): gold is
 *  #D4AF37, the same value used on the web frontend and the plugin GUI theme. */
import { env } from '../env.js';

export const COLORS = {
  gold: 0xd4af37,
  darkGray: 0x2c2c2c,
  deepRed: 0x8b0000,
  green: 0x2ecc71,
  red: 0xe74c3c,
} as const;

/** Themed emojis used across embeds and command output. */
export const EMOJI = {
  eagle: '⚔',
  colosseum: '🏛',
  crown: '👑',
  coin: '🪙',
  blocks: '⛏',
  helm: '⎈',
  chart: '📊',
  shield: '🛡',
  trophy: '🏆',
  clock: '⏱',
  gem: '💎',
  scroll: '📜',
  cross: '❌',
  check: '✅',
  user: '👤',
  star: '⭐',
} as const;

/** Currency display names (order matters for balance cards).
 *  Glyphs are the design-system unicode marks (01-DESIGN-SYSTEM §2/§5) — the same
 *  shapes the web frontend renders as SVG. Discord can't render SVG, so these
 *  unicode fallbacks match by design: ◈ Denarius, ⛁ Auctoritas, ⎈ Civitas, ✦ Aureus. */
export const CURRENCIES = {
  denarius: { name: 'Denarius', emoji: '◈', blurb: 'Money' },
  auctoritas: { name: 'Auctoritas', emoji: '⛁', blurb: 'Tokens' },
  civitas: { name: 'Civitas', emoji: '⎈', blurb: 'Beacons' },
  aureus: { name: 'Aureus', emoji: '✦', blurb: 'Premium' },
} as const;

export const BRANDING = {
  serverName: 'ImperiumMC',
  serverIp: 'imperiummc.net',
  storeUrl: 'https://imperiummc.net/store',
  siteUrl: 'https://imperiummc.net',
  inviteBlurb: 'Forge your empire.',
} as const;

/** Roman numeral conversion for rank display (supports I..XXV+). */
export function toRoman(num: number): string {
  if (!Number.isFinite(num) || num < 1) return '0';
  if (num > 3999) return String(num);
  const table: [number, string][] = [
    [1000, 'M'],
    [900, 'CM'],
    [500, 'D'],
    [400, 'CD'],
    [100, 'C'],
    [90, 'XC'],
    [50, 'L'],
    [40, 'XL'],
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
  ];
  let n = Math.floor(num);
  let out = '';
  for (const [value, symbol] of table) {
    while (n >= value) {
      out += symbol;
      n -= value;
    }
  }
  return out;
}

/** Format large integers with thousands separators. */
export function formatNumber(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '0';
  return Math.floor(n).toLocaleString('en-US');
}

/** Format seconds of playtime into a compact human string. */
export function formatPlaytime(seconds: number | undefined | null): string {
  const s = Math.floor(Number(seconds) || 0);
  if (s <= 0) return '0m';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m && !d) parts.push(`${m}m`);
  return parts.join(' ') || '0m';
}

/** Load env-derived runtime config (read lazily so dotenv can run first). */
export function getBotConfig() {
  const token = process.env.DISCORD_BOT_TOKEN;
  const apiBase = (process.env.BACKEND_API_BASE ?? 'http://localhost:3001').replace(/\/$/, '');
  const clientId = process.env.DISCORD_CLIENT_ID;
  /**
   * Shared secret sent as the `X-Bot-Token` header to authenticate bot-only
   * backend endpoints (/link/confirm, DELETE /link, /player/profile with
   * ?uuid= or ?discord_id=). Same env var the backend itself checks
   * (env.botApiToken / BOT_API_TOKEN) — previously read as BACKEND_API_TOKEN
   * here, a different name for what has to be the identical value, which
   * would silently 401 every bot->backend call unless both were set.
   */
  const apiToken = process.env.BOT_API_TOKEN;
  /** Optional: role to grant when a Discord account is linked. */
  const linkedRoleId = process.env.DISCORD_LINKED_ROLE_ID;
  /** Optional: guild id for fast (per-guild) command registration during dev. */
  const devGuildId = process.env.DISCORD_DEV_GUILD_ID;

  // WORKERS: secrets are NOT injected into process.env under the deployed
  // Worker — they live in the shared env module after initEnvFromBindings.
  // Reading only process.env made every bot->backend auth call silently 401
  // and every linked-role grant silently skip in that deployment shape.
  // env's proxy throws on access-before-init (standalone scripts), hence the
  // try/catch fall-through — same contract as getCredentials below.
  try {
    if (env.discord.botToken) {
      return {
        token: env.discord.botToken,
        apiBase,
        apiToken: env.botApiToken || apiToken,
        clientId: env.discord.clientId || clientId,
        linkedRoleId,
        devGuildId,
      };
    }
  } catch {
    // env not initialized (standalone script / pre-init) — process.env values stand.
  }
  return { token, apiBase, apiToken, clientId, linkedRoleId, devGuildId };
}

/**
 * Resolve the bot token + client id from the shared `env` module when present,
 * falling back to process.env. Imported lazily to avoid a hard dependency on
 * `../env.js` (which throws if required vars are missing during a standalone
 * bot-only run).
 */
export async function getCredentials(): Promise<{
  token: string | undefined;
  clientId: string | undefined;
}> {
  // Prefer the shared env module; it loads dotenv and centralizes validation.
  try {
    const mod = (await import('../env.js')) as {
      env?: { discord?: { botToken?: string; clientId?: string } };
    };
    return {
      token: mod.env?.discord?.botToken,
      clientId: mod.env?.discord?.clientId,
    };
  } catch {
    // env.js throws if required web vars are unset; fall back to process.env.
    return { token: process.env.DISCORD_BOT_TOKEN, clientId: process.env.DISCORD_CLIENT_ID };
  }
}
