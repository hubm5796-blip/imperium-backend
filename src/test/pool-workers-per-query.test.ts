import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression for the /health 200/503 flap: on Workers, a module-scoped pg Pool
 * shared sockets across requests (forbidden by workerd), so every other request
 * hung on a foreign client until the pool was fully stuck. The Workers path must
 * open and close its own Client per query and never touch Pool.
 */

const instances: Array<{ connect: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }> = [];
const poolCtor = vi.fn();
let failConnect = false;

vi.mock('pg', () => {
  class Client {
    connect = vi.fn(async () => {
      if (failConnect) throw new Error('connect timeout');
    });
    query = vi.fn(async () => ({ rows: [{ ok: 1 }], rowCount: 1 }));
    end = vi.fn(async () => {});
    constructor() {
      instances.push(this);
    }
  }
  class Pool {
    constructor() {
      poolCtor();
    }
    on() {}
  }
  return { Client, Pool, default: { Client, Pool } };
});

describe('pool.query on Cloudflare Workers', () => {
  beforeEach(() => {
    instances.length = 0;
    poolCtor.mockClear();
    failConnect = false;
    vi.resetModules();
    vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens a fresh client per query and ends each one, never building a Pool', async () => {
    const { initPool, query } = await import('../db/pool.js');
    initPool('postgresql://hyperdrive.local/db');
    initPool('postgresql://hyperdrive.local/db');

    await query('SELECT 1', []);
    await query('SELECT 1', []);
    await Promise.all([query('SELECT 1', []), query('SELECT 1', [])]);

    expect(poolCtor).not.toHaveBeenCalled();
    expect(instances).toHaveLength(4);
    for (const c of instances) {
      expect(c.connect).toHaveBeenCalledTimes(1);
      expect(c.query).toHaveBeenCalledTimes(1);
      expect(c.end).toHaveBeenCalledTimes(1);
    }
  });

  it('closes the client and surfaces the error when connect fails, so later queries still get their own client', async () => {
    const { initPool, query } = await import('../db/pool.js');
    initPool('postgresql://hyperdrive.local/db');

    failConnect = true;
    await expect(query('SELECT 1', [])).rejects.toThrow('connect timeout');
    expect(instances[0].end).toHaveBeenCalledTimes(1);

    failConnect = false;
    await expect(query('SELECT 1', [])).resolves.toMatchObject({ rows: [{ ok: 1 }] });
    expect(instances).toHaveLength(2);
  });
});
