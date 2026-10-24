/**
 * Integer query params (page, limit). Anything that isn't a safe integer
 * (`abc`, empty, `1e999`) falls back to the default instead of reaching
 * LIMIT/OFFSET as NaN or a bigint-overflowing value.
 */
export function intParam(raw: string | undefined, fallback: number, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number {
  const n = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  const value = Number.isSafeInteger(n) ? n : fallback;
  return Math.min(Math.max(value, min), max);
}

/** 1-based page number. Values below 1 clamp to 1. */
export function pageParam(raw: string | undefined): number {
  return intParam(raw, 1, 1);
}

export function limitParam(raw: string | undefined, fallback: number, max: number): number {
  return intParam(raw, fallback, 1, max);
}
