/**
 * API client for the ImperiumMC backend.
 *
 * The bot never talks to the Minecraft plugin or the database directly.
 * All data is fetched over HTTP from the backend API (default api.imperiummc.net).
 */
import { getBotConfig } from './config.js';

/** Shape of a confirmed account link returned by the backend. */
export interface LinkResult {
  discordId: string;
  username: string;
  uuid: string;
  linked?: boolean;
}

/** Player profile (linked from a UUID via /api/player/profile). */
export interface PlayerProfile {
  uuid: string;
  username: string;
  discordId?: string | null;
  rank?: number;
  prestigeLevel?: number;
  denarius?: number;
  auctoritas?: number;
  civitas?: number;
  aureus?: number;
  blocksMined?: number;
  playtimeSeconds?: number;
  pvpKills?: number;
  pvpDeaths?: number;
  trophies?: number;
  joinedAt?: string | null;
  lastSeen?: string | null;
}

/** One row of a leaderboard. */
export interface LeaderboardEntry {
  rank: number;
  uuid: string;
  username: string;
  value: number;
}

export interface LeaderboardResult {
  type: string;
  entries: LeaderboardEntry[];
}

/** Live server status. */
export interface ServerStatus {
  online: boolean;
  playerCount?: number;
  maxPlayers?: number;
  tps?: number;
  motd?: string;
  version?: string;
  players?: string[];
}

/**
 * Discriminated result of an API call: either the parsed JSON body or an
 * error with an HTTP status and a human-friendly message.
 */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string };

/** Normalize backend error payloads into a single message string. */
function extractMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object') {
    const rec = payload as Record<string, unknown>;
    if (typeof rec.message === 'string') return rec.message;
    if (typeof rec.error === 'string') return rec.error;
  }
  return fallback;
}

/** Perform a JSON request and return a discriminated ApiResult. */
async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const { apiBase } = getBotConfig();
  const url = `${apiBase}${path}`;
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      const message =
        typeof parsed === 'string'
          ? parsed
          : extractMessage(parsed, `${res.status} ${res.statusText}`);
      return { ok: false, status: res.status, message };
    }

    return { ok: true, data: parsed as T };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      message: err instanceof Error ? err.message : 'Network request failed',
    };
  }
}

/** Build a query string from non-null entries. */
function qs(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') sp.set(k, v);
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/** POST /api/link/confirm — confirm a Discord↔MC link using a code. */
export function confirmLink(discordId: string, code: string) {
  return request<LinkResult>('POST', '/api/link/confirm', { discordId, code });
}

/** DELETE /api/link — remove the Discord↔MC link for a Discord user. */
export function unlinkAccount(discordId: string) {
  return request<{ discordId: string; unlinked: boolean }>(
    'DELETE',
    `/api/link${qs({ discord_id: discordId })}`,
  );
}

/**
 * GET /api/player/profile — resolve a profile.
 * The backend looks the player up by Discord id when `discord_id` is passed,
 * or by uuid/username otherwise.
 */
export function getProfile(opts: { discordId?: string; uuid?: string }) {
  return request<PlayerProfile>(
    'GET',
    `/api/player/profile${qs({ discord_id: opts.discordId, uuid: opts.uuid })}`,
  );
}

/** GET /api/leaderboards/:type — top players for a given metric. */
export function getLeaderboard(type: string, limit = 10) {
  return request<LeaderboardResult>(
    'GET',
    `/api/leaderboards/${encodeURIComponent(type)}${qs({ limit: String(limit) })}`,
  );
}

/** GET /api/server/status — live server status. */
export function getServerStatus() {
  return request<ServerStatus>('GET', '/api/server/status');
}
