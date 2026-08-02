import type { Context } from 'hono';

/** Discord user profile as returned by the OAuth2 /users/@me endpoint. */
export interface DiscordUser {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
  discriminator: string;
}

/** Decoded JWT payload stored in the auth cookie. */
export interface JwtPayload {
  discordId: string;
  discordUsername: string;
  discordAvatar: string | null;
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

/** Mapping from internal currency label to legacy db column name. */
export const CURRENCY_COLUMNS = {
  denarius: 'money',
  tokens: 'tokens',
  beacons: 'beacons',
  goldenCoins: 'gc',
} as const;

export type CurrencyKey = keyof typeof CURRENCY_COLUMNS;

/** Number of minor units per display unit. */
export const MINOR_UNITS_PER_UNIT = 100;
