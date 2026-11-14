import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * L15 (2026-11-14) — the cron entrypoint (scheduled) never initialized the
 * game-MySQL pool, so every cron isolate failed every bus-kv / game-MySQL
 * read with "Game MySQL pool not initialized": the CCU peak sampler (the
 * growth snapshot's ccu_peak_7d series) errored every minute, and the cron's
 * in-process route calls (notify scheduler → /api/seasons/current) degraded.
 *
 * Pins: BOTH worker entrypoints delegate to initWorkerState, and
 * initWorkerState builds the game pool exactly when the GAME_MYSQL_* secrets
 * are bound (same guard the fetch path always had).
 */

const initMocks = vi.hoisted(() => ({
  // worker.ts registers a global unhandledrejection listener at module scope
  // (workerd always has addEventListener; vitest's Node env does not).
  installGlobalListenerStub: (() => {
    const g = globalThis as unknown as { addEventListener?: unknown };
    if (typeof g.addEventListener !== 'function') {
      g.addEventListener = () => undefined;
    }
  })(),
  initEnvFromBindings: vi.fn(),
  initPool: vi.fn(),
  initD1: vi.fn(),
  initGamePool: vi.fn(),
  setCronBindings: vi.fn(),
  runBotCron: vi.fn(async () => ({
    skipped: true,
    webhookDeliveries: { delivered: 0, processed: 0, retried: 0, dead: 0 },
    webhookTailer: { queued: 0, events: 0 },
    sweep: { fired: 0, errors: 0 },
    audit: { changed: 0, checked: 0 },
    rollup: { ran: false, metrics: 0 },
  })),
  ensureBootMigrations: vi.fn(async () => ({ present: [], applied: [], failed: [], skippedDuplicateColumn: [] })),
}));

vi.mock('../env.js', () => ({ __resetEnvForTests: vi.fn(), initEnvFromBindings: initMocks.initEnvFromBindings }));
vi.mock('../db/pool.js', () => ({ initPool: initMocks.initPool, initD1: initMocks.initD1 }));
vi.mock('../db/gameMysql.js', () => ({ initGamePool: initMocks.initGamePool }));
vi.mock('../db/migrations.js', () => ({ ensureBootMigrations: initMocks.ensureBootMigrations }));
vi.mock('../bot/cronConfig.js', () => ({ setCronBindings: initMocks.setCronBindings }));
vi.mock('../bot/cron.js', () => ({ runBotCron: initMocks.runBotCron }));
// fetch() isn't under test here — stub the app so worker.ts's createApp
// import doesn't drag the whole route tree (and its pool.js `query` import)
// through these narrow mocks.
vi.mock('../app.js', () => ({ createApp: vi.fn(() => ({ fetch: vi.fn() })) }));

import workerDefault from '../worker.js';
import { initWorkerState } from '../workerInit.js';

const BINDINGS = {
  HYPERDRIVE: { connectionString: 'postgresql://hyperdrive.local:5432/db' },
  CACHE_DB: { _d1: true },
  GAME_MYSQL_HOST: 'db.example',
  GAME_MYSQL_PORT: 3306,
  GAME_MYSQL_USER: 'u',
  GAME_MYSQL_PASSWORD: 'p',
  GAME_MYSQL_DATABASE: 'd',
};

function fakeCtx(): { waitUntil: (p: Promise<unknown>) => void } {
  return { waitUntil: (_p: Promise<unknown>) => undefined };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('L15 scheduled() initializes the same state as fetch()', () => {
  it('scheduled() inits env, Postgres, D1 AND the game-MySQL pool', async () => {
    await workerDefault.scheduled({} as never, BINDINGS as never, fakeCtx() as never);
    expect(initMocks.initEnvFromBindings).toHaveBeenCalledTimes(1);
    expect(initMocks.initPool).toHaveBeenCalledTimes(1);
    expect(initMocks.initD1).toHaveBeenCalledTimes(1);
    expect(initMocks.initGamePool).toHaveBeenCalledTimes(1);
    expect(initMocks.initGamePool).toHaveBeenCalledWith({
      host: 'db.example',
      port: 3306,
      user: 'u',
      password: 'p',
      database: 'd',
    });
    // The cron still arms its own bindings and runs.
    expect(initMocks.setCronBindings).toHaveBeenCalledTimes(1);
    expect(initMocks.runBotCron).toHaveBeenCalledTimes(1);
  });

  it('skips the game pool when GAME_MYSQL_* secrets are not bound', () => {
    initWorkerState({
      HYPERDRIVE: { connectionString: 'postgresql://hyperdrive.local:5432/db' },
      CACHE_DB: {},
    });
    expect(initMocks.initEnvFromBindings).toHaveBeenCalledTimes(1);
    expect(initMocks.initPool).toHaveBeenCalledTimes(1);
    expect(initMocks.initD1).toHaveBeenCalledTimes(1);
    expect(initMocks.initGamePool).not.toHaveBeenCalled();
  });
});
