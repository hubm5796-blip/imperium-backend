// V6 05-01 — the v2 API contract primitives.
//
// Every v2 response is enveloped: { data, meta? } on success and
// { error: { code, message } } on failure. Consumers branch on the CLOSED
// error-code enum, never parse prose. v1 routes keep their legacy shapes —
// the contract starts at /api/v2.
import type { Context } from 'hono';

/** Closed v2 error-code enum. Add codes here BEFORE using them in fail(). */
export const ERROR_CODES = [
  'NOT_FOUND',
  'INVALID_PARAM',
  'UNKNOWN_PARAM',
  'INVALID_CURSOR',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'LINK_REQUIRED',
  'RATE_LIMITED',
  'PLUGIN_UNREACHABLE',
  'REGISTRY_UNAVAILABLE',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface PageMeta {
  nextCursor: string | null;
  approxTotal?: number;
}

export function ok<T>(c: Context, data: T, meta?: PageMeta): Response {
  return c.json(meta ? { data, meta } : { data });
}

export function fail(c: Context, status: 400 | 401 | 403 | 404 | 409 | 429 | 503, code: ErrorCode, message: string, details?: unknown): Response {
  return c.json({ error: { code, message, ...(details !== undefined ? { details } : {}) } }, status);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cursor pagination — base64url of {v:1, k:<sortKey>, id:<tiebreak>}.
// Keyset cursors are stable across inserts, unlike page numbers.
// ─────────────────────────────────────────────────────────────────────────────

export interface Cursor {
  v: 1;
  k: number;
  id: string;
}

export function encodeCursor(cursor: { value: number; uuid: string }): string {
  const payload: Cursor = { v: 1, k: cursor.value, id: cursor.uuid };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined): { value: number; uuid: string } | null | 'invalid' {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (parsed.v !== 1 || typeof parsed.k !== 'number' || typeof parsed.id !== 'string') return 'invalid';
    return { value: parsed.k, uuid: parsed.id };
  } catch {
    return 'invalid';
  }
}

/** Parse + clamp the shared limit param (1..100, default 20). */
export function parseLimit(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '20', 10);
  if (Number.isNaN(n)) return 20;
  return Math.min(Math.max(n, 1), 100);
}

/** v2 strictness: unknown query params are rejected (v1 ignores them).
 *  Returns the offending names, empty when all params are known. */
export function unknownParams(url: URL, allowed: Set<string>): string[] {
  return [...url.searchParams.keys()].filter((k) => !allowed.has(k));
}
