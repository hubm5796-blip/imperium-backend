// Shared per-invocation init for BOTH Worker entrypoints (fetch + scheduled).
//
// L15 (2026-11-14): scheduled() used to run only env/Postgres/D1 init — the
// game-MySQL pool was initialized in fetch() alone. Every cron isolate
// therefore failed every game-MySQL / bus-kv read ("Game MySQL pool not
// initialized"), which killed the CCU peak sampler (launch-day growth
// observability) every minute and degraded the cron's own in-process route
// calls (bot/notify/scheduler.ts reads /api/seasons/current through
// apiClient's localApp().request(), which never goes through worker fetch's
// init). One init, both entrypoints — the guard semantics are unchanged.
import { initEnvFromBindings } from './env.js';
import { initPool, initD1 } from './db/pool.js';
import { initGamePool } from './db/gameMysql.js';

/** The subset of WorkerBindings the init sequence consumes (structural so the
 *  worker's full binding interface satisfies it without re-declaring fields —
 *  deliberately NO index signature: interfaces don't carry implicit ones and
 *  WorkerBindings must stay assignable as-is). */
export interface WorkerInitBindings {
  DATABASE_URL?: string;
  HYPERDRIVE: { connectionString: string };
  CACHE_DB: unknown;
  GAME_MYSQL_HOST?: string;
  GAME_MYSQL_PORT?: number;
  GAME_MYSQL_USER?: string;
  GAME_MYSQL_PASSWORD?: string;
  GAME_MYSQL_DATABASE?: string;
}

/**
 * Idempotent per-isolate state init: env vars, Postgres (Hyperdrive) pool, D1,
 * and — when the GAME_MYSQL_* secrets are bound — the game-MySQL pool the bus
 * (web_commands/web_responses/bus_kv) and real-time game reads ride on.
 */
export function initWorkerState(bindings: WorkerInitBindings): void {
  initEnvFromBindings(bindings as unknown as Record<string, unknown>);
  // Hyperdrive is the connection path (TLS terminates inside Cloudflare —
  // direct pg/TLS from workerd cannot reach Supabase). A plain DATABASE_URL
  // var is accepted as a Node-dev/local override only.
  initPool(bindings.DATABASE_URL || bindings.HYPERDRIVE.connectionString);
  initD1(bindings.CACHE_DB as never);
  if (
    bindings.GAME_MYSQL_HOST &&
    bindings.GAME_MYSQL_USER &&
    bindings.GAME_MYSQL_PASSWORD &&
    bindings.GAME_MYSQL_DATABASE
  ) {
    initGamePool({
      host: bindings.GAME_MYSQL_HOST,
      port: bindings.GAME_MYSQL_PORT ?? 3306,
      user: bindings.GAME_MYSQL_USER,
      password: bindings.GAME_MYSQL_PASSWORD,
      database: bindings.GAME_MYSQL_DATABASE,
    });
  }
}
