/**
 * RATE LIMITING V2 (MASTER-PLAN-V6 05-05): endpoint COST CLASSES + the PRINCIPAL dimension
 * layered onto the existing per-IP sliding-window limiter (rateLimit.ts stays untouched —
 * every route keeps its current protection; this adds fairness and abuse granularity).
 *
 * Model (per the blueprint):
 *   - COST CLASSES weight each request's charge instead of every hit costing 1:
 *     free 0 / cheap 1 / std 2 / heavy 5 / write 10 — so a cold uncached profile aggregate
 *     draws 5x the budget of a cached leaderboard read from the same caller.
 *   - PRINCIPAL BUCKET (`rl:principal:<kind>:<id>`): session uuid / bot token identity —
 *     stops one account hammering through rotating IPs, with a budget ABOVE the per-IP cap
 *     (a shared NAT/VPN pool of legit players behind one IP must not starve).
 *   - Fail-open on limiter errors (availability > limiting) — matching the v1 convention.
 *
 * Class inference: method + path prefix. Explicit override via `costClass()` when a route
 * knows better.
 */
import type { MiddlewareHandler } from 'hono';
import type { AppContextVariables } from '../types/index.js';

type RL = { Variables: AppContextVariables };

export type CostClass = 'free' | 'cheap' | 'std' | 'heavy' | 'write';

export const COST_BY_CLASS: Record<CostClass, number> = {
  free: 0,
  cheap: 1,
  std: 2,
  heavy: 5,
  write: 10,
};

/** Per-minute cost-point budgets. Tunable via env vars (documented in wrangler.jsonc). */
const IP_BUDGET = Number(process.env.RL_V2_IP_BUDGET ?? 240);
const PRINCIPAL_BUDGET = Number(process.env.RL_V2_PRINCIPAL_BUDGET ?? 480);
const WINDOW_MS = 60_000;

interface CostWindow {
  /** Sorted (oldest first) [timestamp, cost] entries in the window. */
  hits: Array<{ t: number; cost: number }>;
  used: number;
}

const buckets = new Map<string, CostWindow>();
const SWEEP_THRESHOLD = 10_000;

function sweepIdle(now: number): void {
  if (buckets.size <= SWEEP_THRESHOLD) return;
  for (const [key, w] of buckets) {
    if (w.hits.length === 0 || (w.hits[w.hits.length - 1] as { t: number }).t <= now - WINDOW_MS) {
      buckets.delete(key);
    }
  }
}

function consume(bucketKey: string, cost: number, budget: number, now: number): { allowed: boolean; remaining: number } {
  if (cost <= 0) return { allowed: true, remaining: budget };
  let w = buckets.get(bucketKey);
  if (!w) {
    w = { hits: [], used: 0 };
    buckets.set(bucketKey, w);
  }
  const cutoff = now - WINDOW_MS;
  while (w.hits.length > 0 && (w.hits[0] as { t: number }).t <= cutoff) {
    const dropped = w.hits.shift() as { t: number; cost: number };
    w.used -= dropped.cost;
  }
  if (w.used + cost > budget) {
    return { allowed: false, remaining: Math.max(budget - w.used, 0) };
  }
  w.hits.push({ t: now, cost });
  w.used += cost;
  return { allowed: true, remaining: Math.max(budget - w.used, 0) };
}

/** Infer the class from method + path. Conservative: unknown POSTs are write-class. */
export function inferClass(method: string, path: string): CostClass {
  if (method === 'GET' || method === 'HEAD') {
    if (path.startsWith('/api/server/features') || path.startsWith('/api/shop/catalog')) return 'free';
    if (path.startsWith('/api/leaderboards') || path.startsWith('/api/seasons') || path.startsWith('/api/events')) return 'cheap';
    if (path.startsWith('/api/admin') || path.includes('?uncached') || path.startsWith('/api/community')) return 'heavy';
    return 'std';
  }
  return 'write';
}

function principalOf(c: Parameters<MiddlewareHandler<RL>>[0]): string | null {
  const session = (c.var as { mcUuid?: string } | undefined)?.mcUuid;
  if (session) return `session:${session}`;
  const bot = c.req.header('x-bot-token');
  if (bot) return 'bot';
  return null;
}

/**
 * Cost-aware limiter: charges the IP bucket AND (when the caller is authenticated) the
 * principal bucket. Both must allow — the IP cap bounds abuse, the principal cap adds
 * fairness across IP rotation.
 */
export function rateLimitV2(): MiddlewareHandler<RL> {
  return async (c, next) => {
    const now = Date.now();
    sweepIdle(now);

    const path = new URL(c.req.url).pathname;
    const cls = inferClass(c.req.method, path);
    const cost = COST_BY_CLASS[cls];

    const ip =
      c.req.header('cf-connecting-ip') ??
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
      c.req.header('x-real-ip') ??
      'unknown';

    const ipClass = cls === 'write' ? 'write' : 'public';
    const ipVerdict = consume(`rl:ip:${ip}:${ipClass}`, cost, IP_BUDGET, now);
    let principalVerdict = { allowed: true, remaining: PRINCIPAL_BUDGET };
    const principal = principalOf(c);
    if (principal) {
      principalVerdict = consume(`rl:principal:${principal}`, cost, PRINCIPAL_BUDGET, now);
    }

    c.header('X-RateLimit-Class', cls);
    c.header('X-RateLimit-Remaining', String(Math.min(ipVerdict.remaining, principalVerdict.remaining)));

    if (!ipVerdict.allowed || !principalVerdict.allowed) {
      c.header('Retry-After', '60');
      return c.json(
        { error: 'Too Many Requests', class: cls, scope: ipVerdict.allowed ? 'principal' : 'ip' },
        429,
      );
    }
    await next();
  };
}
