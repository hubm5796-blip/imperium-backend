import type { Context } from 'hono';

/** Discord user profile as returned by the OAuth2 /users/@me endpoint. */
export interface DiscordUser {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
  discriminator: string;
}

/**
 * Decoded JWT payload stored in the auth cookie. Two session shapes:
 * - `authMethod: 'discord'` — signed in via Discord OAuth. `discordId` etc. are
 *   set; `mcUuid` is resolved on each request via the discord_links table.
 * - `authMethod: 'mc_code'` — signed in via the in-game 6-digit code. `mcUuid`
 *   is baked into the token directly (no DB lookup needed); `discordId` is set
 *   only if that Minecraft account happens to already be linked to Discord.
 */
export interface JwtPayload {
  authMethod: 'discord' | 'mc_code';
  discordId?: string;
  discordUsername?: string;
  discordAvatar?: string | null;
  mcUuid?: string;
  iat?: number;
  exp?: number;
}

/** Row in the `discord_links` table. */
export interface DiscordLinkRow {
  uuid: string;
  discord_id: string;
  linked_at: Date;
  paynow_customer_id: string | null;
}

/** Row in the `paynow_subscriptions` table — a cache of a player's active donor subscription. */
export interface PaynowSubscriptionRow {
  uuid: string;
  subscription_id: string;
  product_id: string;
  status: string;
  updated_at: Date;
}

/** Row in the `player_ranks` table. */
export interface PlayerRankRow {
  uuid: string;
  rank_level: number;
  rank_name: string;
  rank_progress: number;
}

/** Row in the `prestige_data` table. */
export interface PrestigeDataRow {
  uuid: string;
  prestige_level: number;
  prestige_points: number;
}

/** Row in the `player_stats` table. */
export interface PlayerStatsRow {
  uuid: string;
  blocks_mined: string;
  play_time: string;
  pvp_kills: number;
  pvp_deaths: number;
  pvp_trophies: number;
}

/** Row in the `currency_balances` table (balance is BIGINT minor units). */
export interface CurrencyBalanceRow {
  uuid: string;
  currency: string;
  balance: string;
}

/** Row in the `economy_transactions` table. */
export interface EconomyTransactionRow {
  id: number;
  uuid: string;
  type: string;
  currency: string;
  amount: string;
  description: string | null;
  created_at: Date;
}

/** Aggregate profile returned by /api/player/profile. */
export interface PlayerProfile {
  uuid: string;
  rank: {
    level: number;
    name: string;
    progress: number;
  } | null;
  prestige: {
    level: number;
    points: number;
  } | null;
  stats: {
    blocksMined: number;
    playTime: string;
    pvpKills: number;
    pvpDeaths: number;
    pvpTrophies: number;
    kdRatio: number | null;
  } | null;
}

/** Hono context variables attached by auth middleware. */
export interface AppContextVariables {
  user: JwtPayload | null;
  mcUuid: string | null;
}

export type AppContext = Context<{
  Variables: AppContextVariables;
}>;

/** Message envelope published to the ImperiumMC:commands channel. */
export interface CommandEnvelope {
  type: string;
  request_id: string;
  /** Unix SECONDS (plugin verifies a 30s window against seconds). */
  ts: number;
  nonce: string;
  /** Hex HMAC-SHA256 — field name MUST be `sig` to match the plugin. */
  sig: string;
  payload: Record<string, unknown>;
}

/**
 * Response envelope published to the ImperiumMC:responses channel.
 * The plugin's `publishResponse` sends `request_id` + `status` ("OK"|"ERROR")
 * + optional `error` + `timestamp`; some command handlers (REQUEST_CONFIGS,
 * COMPENSATE_PLAYER) publish richer raw envelopes via `publishRaw`. Callers
 * should prefer `ok` (derived from status) and fall back to the raw fields.
 */
export interface ResponseEnvelope {
  request_id: string;
  /** Derived from the plugin's `status` field: ok = (status === 'OK'). */
  ok: boolean;
  /** Raw plugin status when present ("OK" | "ERROR"). */
  status?: string;
  data?: unknown;
  error?: string;
  /** Other fields the plugin may include (action, timestamp, payload...). */
  [key: string]: unknown;
}

/**
 * Mapping from internal currency label to the currency_balances.currency row key.
 * CANONICAL RENAME (2026-08-14): the plugin migrated every row to the branded names
 * (denarius/auctoritas/civitas/aureus) — the legacy keys (money/tokens/beacons/gc)
 * remain mapped in CURRENCY_ALIASES so any straggler row still resolves.
 */
export const CURRENCY_COLUMNS = {
  denarius: 'denarius',
  tokens: 'auctoritas',
  beacons: 'civitas',
  goldenCoins: 'aureus',
} as const;

export type CurrencyKey = keyof typeof CURRENCY_COLUMNS;

/**
 * Row key (canonical OR legacy) -> internal currency label.
 */
export const CURRENCY_ALIASES: Record<string, CurrencyKey> = {
  denarius: 'denarius',
  money: 'denarius',
  auctoritas: 'tokens',
  tokens: 'tokens',
  civitas: 'beacons',
  beacons: 'beacons',
  aureus: 'goldenCoins',
  gc: 'goldenCoins',
};

/**
 * Units per display unit. WHOLE-UNIT STORAGE (2026-08-18): the game DB now stores every
 * currency in WHOLE units (plugin migration V28 divided the historical ×100 minor-unit rows
 * once), so this is 1 and `minorUnitsToDisplay` is an identity/parse shim kept for API shape.
 */
export const MINOR_UNITS_PER_UNIT = 1;
