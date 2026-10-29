/**
 * RATE LIMITING V2 (MASTER-PLAN-V6 05-05): endpoint COST CLASSES + the PRINCIPAL dimension
 * layered onto the per-IP fixed-window limiter (rateLimit.ts stays untouched —
 * every route keeps its current protection; this adds fairness and abuse granularity).
 *
 * Model (per the blueprint):
 *   - COST CLASSES weight each request's charge instead of every hit costing 1:
 *     free 0 / cheap 1 / std 2 / heavy 5 / write 10 — so a cold uncached profile aggregate
 *     draws 5x the budget of a cached leaderboard read from the same caller.
 *   - PRINCIPAL BUCKET (`rl2:principal:<kind>:<id>`): session uuid / hashed machine
 *     token — stops one account hammering through rotating IPs, with a budget ABOVE
 *     the per-IP cap (a shared NAT/VPN pool of legit players behind one IP must not
 *     starve).
 *   - Fail-open on limiter errors (availability > limiting) — matching the v1 convention.
 *
 * B-25/bC13 DURABILITY: the counters live in D1 (CACHE_DB), NOT an in-memory Map —
 * a per-isolate Map was "effectively no limit" on Workers (limit x isolates, and the
 * v2 limiter shipped with exactly that regression). One `d1.batch()` per request
 * carries BOTH counters (IP + principal) as a single transactional round trip, which
 * is also the bC13 contention posture: D1's single-writer serialization instead of
 * N racing statements. Budgets read from the env module (bindings-first) —
 * process.env-only reads are always the fallback defaults on Workers.
 *
 * Class inference: method + path prefix (v1 surfaces AND the /api/v2 residents).
 * Explicit override via `costClass()` when a route knows better.
 */
import type { MiddlewareHandler } from 'hono';
import { createHash } from 'node:crypto';
import { clientIp } from './rateLimit.js';
import { getD1 } from '../db/pool.js';
import { env } from '../env.js';
import { logger } from '../utils/logger.js';
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

const WINDOW_MS = 60_000;
const D1_TABLE = 'rate_limit_v2_windows';

/** Budgets from the env module (bindings on Workers, process.env on Node).
 *  env can throw pre-init — degrade to the documented defaults, never crash. */
function budgets(): { ip: number; principal: number } {
  try {
    return {
      ip: Number.isFinite(env.rlV2IpBudget) && env.rlV2IpBudget >= 10 ? env.rlV2IpBudget : 240,
      principal: Number.isFinite(env.rlV2PrincipalBudget) && env.rlV2PrincipalBudget >= 10 ? env.rlV2PrincipalBudget : 480,
    };
  } catch {
    return { ip: 240, principal: 480 };
  }
}

let schemaReady = false;
async function ensureSchema(): Promise<boolean> {
  if (schemaReady) return true;
  try {
    await getD1()
      .prepare(
        `CREATE TABLE IF NOT EXISTS ${D1_TABLE} (
           key TEXT PRIMARY KEY,
           window_start INTEGER NOT NULL,
           cost INTEGER NOT NULL DEFAULT 0
         )`,
      )
      .run();
    schemaReady = true;
    return true;
  } catch (err) {
    logger.warn({ err: String(err) }, 'rateLimitV2: D1 schema ensure failed — failing open');
    return false;
  }
}

interface BucketAsk {
  key: string;
  budget: number;
}
interface BucketVerdict {
  allowed: boolean;
  remaining: number;
}

/**
 * Charge the given buckets in ONE transactional D1 batch. Fixed 60s windows:
 * the upsert-increment is atomic under D1's single-writer semantics, so two
 * isolates racing the same key serialize correctly (the whole point of
 * leaving the in-memory Map behind).
 */
async function consumeBuckets(asks: BucketAsk[], cost: number, now: number): Promise<BucketVerdict[] | null> {
  if (asks.length === 0) return [];
  if (!(await ensureSchema())) return null; // fail-open
  const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  try {
    // S2-D10: built INSIDE the try, mirroring rateLimit.ts:113-114 — when it
    // lived before the try, a throwing getD1() (schemaReady already armed)
    // escaped this fail-open contract and surfaced as a 500.
    const cleanup = Math.random() < 0.02
      ? getD1().prepare(`DELETE FROM ${D1_TABLE} WHERE window_start < ?`).bind(now - WINDOW_MS)
      : null;
    const stmts = asks.map((a) =>
      getD1()
        .prepare(
          `INSERT INTO ${D1_TABLE} (key, window_start, cost) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET cost = cost + excluded.cost
           RETURNING cost`,
        )
        .bind(a.key, windowStart, cost),
    );
    const results = await getD1().batch(cleanup ? [...stmts, cleanup] : stmts);
    return asks.map((a, i) => {
      const row = results[i]?.results?.[0] as { cost?: number } | undefined;
      const charged = Number(row?.cost ?? 0);
      return { allowed: charged <= a.budget, remaining: Math.max(a.budget - charged, 0) };
    });
  } catch (err) {
    logger.warn({ err: String(err) }, 'rateLimitV2: D1 op failed — failing open');
    return null;
  }
}

/** Infer the class from method + path. Conservative: unknown POSTs are write-class. */
export function inferClass(method: string, path: string): CostClass {
  const isRead = method === 'GET' || method === 'HEAD';
  if (!isRead) return 'write';
  // v1 surfaces
  if (path.startsWith('/api/server/features') || path.startsWith('/api/shop/catalog')) return 'free';
  if (path.startsWith('/api/leaderboards') || path.startsWith('/api/seasons') || path.startsWith('/api/events')) return 'cheap';
  if (path.startsWith('/api/admin') || path.includes('?uncached') || path.startsWith('/api/community')) return 'heavy';
  // v2 residents (B-25: the newest surface fell through to 'std' because the
  // prefixes only knew v1 paths)
  if (path.startsWith('/api/v2')) {
    if (path.startsWith('/api/v2/events/stream')) return 'free'; // one long-lived connection, not a per-tick charge
    if (path.startsWith('/api/v2/ping') || path.startsWith('/api/v2/openapi.json')) return 'cheap';
    if (path.startsWith('/api/v2/public/player')) return 'heavy';
    return 'std';
  }
  return 'std';
}

/** Machine-token principal: keyed by a SHA-256 prefix of the token, never the
 *  raw secret and never one shared 'bot' bucket (B-25: every integration
 *  used to share a single fairness bucket). */
function machinePrincipal(token: string): string {
  const hash = createHash('sha256').update(token).digest('hex').slice(0, 16);
  return `machine:${hash}`;
}

export function principalOf(c: Parameters<MiddlewareHandler<RL>>[0]): string | null {
  const session = (c.var as { mcUuid?: string } | undefined)?.mcUuid;
  if (session) return `session:${session}`;
  const bot = c.req.header('x-bot-token');
  if (bot) return machinePrincipal(bot);
  return null;
}

/**
 * Cost-aware limiter: charges the IP bucket AND (when the caller is authenticated) the
 * principal bucket. Both must allow — the IP cap bounds abuse, the principal cap adds
 * fairness across IP rotation. Both charges ride one D1 batch.
 */
export function rateLimitV2(): MiddlewareHandler<RL> {
  return async (c, next) => {
    const now = Date.now();
    const path = new URL(c.req.url).pathname;
    const cls = inferClass(c.req.method, path);
    const cost = COST_BY_CLASS[cls];
    const { ip: IP_BUDGET, principal: PRINCIPAL_BUDGET } = budgets();

    // B-26: shared resolver — cf-connecting-ip, with forwarded headers only
    // when TRUST_PROXY is enabled (see rateLimit.clientIp).
    const ip = clientIp(c);
    const principal = principalOf(c);

    if (cost <= 0) {
      c.header('X-RateLimit-Class', cls);
      await next();
      return;
    }

    const asks: BucketAsk[] = [
      { key: `rl2:ip:${ip}:${cls === 'write' ? 'write' : 'public'}`, budget: IP_BUDGET },
    ];
    if (principal) asks.push({ key: `rl2:principal:${principal}`, budget: PRINCIPAL_BUDGET });

    const verdicts = await consumeBuckets(asks, cost, now);
    if (verdicts === null) {
      // D1 unavailable — fail-open (the v1 convention: availability > limiting).
      await next();
      return;
    }
    const ipVerdict = verdicts[0]!;
    const principalVerdict = verdicts[1] ?? { allowed: true, remaining: PRINCIPAL_BUDGET };

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
