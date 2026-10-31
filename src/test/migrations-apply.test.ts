import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initD1 } from '../db/pool.js';
import {
  BOOT_MIGRATIONS,
  __resetBootMigrationsForTests,
  ensureBootMigrations,
  migrationObjects,
  splitSqlStatements,
  type BootMigrationsReport,
} from '../db/migrations.js';

/**
 * The boot applier (Lane D, 2026-10-31). The regression these pin: on the
 * pre-lane tree NOTHING applied migrations at boot — "un-applied at boot"
 * never appeared, and a migration file could sit unapplied forever.
 *
 * The double interprets exactly the SQL the applier emits: the
 * sqlite_master existence probe, the SELECT ... LIMIT 0 column probes, and
 * the split single-statement DDL (CREATE ... IF NOT EXISTS / ALTER ADD
 * COLUMN, duplicate-column thrown the way SQLite does).
 */

interface DoubleOpts {
  /** Tables (and indexes) sqlite_master reports as existing. */
  existing?: string[];
  /** [table, column] pairs that already exist — ALTER probes succeed for these. */
  existingColumns?: Array<[string, string]>;
  /** The sqlite_master probe query itself throws (D1 hiccup). */
  probeOutage?: boolean;
  /** DDL statements matching this regex throw (a failed apply). */
  failOn?: RegExp;
}

interface PreparedHandle {
  run: () => Promise<{ meta: { changes: number } }>;
  all: () => Promise<{ results: Array<{ name: string }> }>;
  bind: (...params: string[]) => { run: PreparedHandle['run']; all: PreparedHandle['all'] };
}

function makeMigrationD1(opts: DoubleOpts = {}): { __ddlLog: string[]; prepare(sql: string): PreparedHandle } {
  const tables = new Set(opts.existing ?? []);
  const columns = new Set((opts.existingColumns ?? []).map(([t, c]) => `${t}.${c}`));
  const ddlLog: string[] = [];

  const outage = (): PreparedHandle => {
    const boom = async (): Promise<never> => {
      throw new Error('D1 is having a moment');
    };
    return {
      run: boom,
      all: boom,
      bind: () => ({ run: boom, all: boom }),
    };
  };

  return {
    __ddlLog: ddlLog,
    prepare(sql: string): PreparedHandle {
      if (opts.probeOutage && sql.startsWith('SELECT name FROM sqlite_master')) return outage();

      const run = async (): Promise<{ meta: { changes: number } }> => {
        // Column probe: SELECT <col> FROM <table> LIMIT 0
        const colProbe = /^SELECT ([A-Za-z_]\w*) FROM ([A-Za-z_]\w*) LIMIT 0$/.exec(sql);
        if (colProbe) {
          if (columns.has(`${colProbe[2]}.${colProbe[1]}`)) return { meta: { changes: 0 } };
          throw new Error(`no such column: ${colProbe[1]}`);
        }
        // DDL apply — record, update the simulated schema, throw on failOn.
        if (opts.failOn?.test(sql)) throw new Error('D1 said no');
        ddlLog.push(sql);
        const create = /^CREATE TABLE IF NOT EXISTS ([A-Za-z_]\w*)/i.exec(sql);
        if (create) {
          tables.add(create[1]!);
          return { meta: { changes: 1 } };
        }
        const alter = /^ALTER TABLE ([A-Za-z_]\w*) ADD COLUMN ([A-Za-z_]\w*)/i.exec(sql);
        if (alter) {
          const key = `${alter[1]}.${alter[2]}`;
          if (columns.has(key)) throw new Error(`duplicate column name: ${alter[2]}`);
          columns.add(key);
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 0 } }; // CREATE INDEX etc.
      };

      const all = async (): Promise<{ results: Array<{ name: string }> }> => {
        if (!sql.startsWith('SELECT name FROM sqlite_master')) {
          throw new Error(`unexpected .all() sql: ${sql.slice(0, 60)}`);
        }
        return { results: [...tables].map((name) => ({ name })) };
      };

      return { run, all, bind: () => ({ run, all }) };
    },
  };
}

const FILE_ORDER = BOOT_MIGRATIONS.map((m) => m.file);

function allMountedObjects(): string[] {
  const names: string[] = [];
  for (const m of BOOT_MIGRATIONS) {
    const objs = migrationObjects(splitSqlStatements(m.sql));
    names.push(...objs.tables, ...objs.indexes);
  }
  return names;
}

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __resetBootMigrationsForTests();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  __resetBootMigrationsForTests();
});

describe('boot migration applier', () => {
  it('a fresh D1 gets every mounted migration, in file order, ALTER after its table', async () => {
    const d1 = makeMigrationD1();
    initD1(d1 as never);
    const report = await ensureBootMigrations();

    expect(report.failed).toEqual([]);
    expect(report.applied).toEqual(FILE_ORDER);
    expect(report.present).toEqual([]);

    const createIdx = d1.__ddlLog.findIndex((s) => s.startsWith('CREATE TABLE IF NOT EXISTS changelog_entry'));
    const alterIdx = d1.__ddlLog.findIndex((s) => s.startsWith('ALTER TABLE changelog_entry ADD COLUMN category'));
    expect(createIdx, 'changelog_entry CREATE ran').toBeGreaterThanOrEqual(0);
    expect(alterIdx, 'category ALTER ran').toBeGreaterThan(createIdx);

    // Every prepare carried exactly ONE statement (splitter did its job).
    for (const stmt of d1.__ddlLog) {
      expect(stmt.includes(';'), `un-split statement: ${stmt.slice(0, 60)}`).toBe(false);
    }
  });

  it('an already-migrated D1 runs ZERO DDL (presence probe, not blind IF NOT EXISTS)', async () => {
    const d1 = makeMigrationD1({
      existing: allMountedObjects(),
      existingColumns: [['changelog_entry', 'category']],
    });
    initD1(d1 as never);
    const report = await ensureBootMigrations();

    expect(report.failed).toEqual([]);
    expect(report.applied).toEqual([]);
    expect(report.present).toEqual(FILE_ORDER);
    expect(d1.__ddlLog).toEqual([]);
  });

  it('a sqlite_master outage on a migrated D1 re-applies everything idempotently (duplicate-column swallowed)', async () => {
    const d1 = makeMigrationD1({
      existing: allMountedObjects(),
      existingColumns: [['changelog_entry', 'category']],
      probeOutage: true,
    });
    initD1(d1 as never);
    const report = await ensureBootMigrations();

    expect(report.probeFailed).toBeDefined();
    expect(report.failed).toEqual([]);
    expect(report.applied).toEqual(FILE_ORDER);
    expect(report.skippedDuplicateColumn).toEqual(['d1_0009_changelog_category.sql']);
  });

  it('a failed migration aborts the pass and logs LOUDLY — later migrations never run', async () => {
    const d1 = makeMigrationD1({ failOn: /paynow_order_dispatches/ });
    initD1(d1 as never);
    const report = await ensureBootMigrations();

    expect(report.failed.length).toBe(1);
    expect(report.failed[0]!.file).toBe('d1_0002_paynow_order_dispatches.sql');
    // The pass aborted: 0001 applied, nothing from 0003 onward ran.
    expect(report.applied).toEqual(['d1_0001_paynow_subscriptions.sql']);
    expect(d1.__ddlLog.some((s) => /client_crash_reports|attribution_intent|retention_churn/.test(s))).toBe(false);
    // LOUD: the failure reached console.error through the structured logger.
    const loud = errorSpy.mock.calls.some((args: unknown[]) => String(args.at(-1)).includes('[migrations]'));
    expect(loud, 'apply failure must hit console.error with the [migrations] tag').toBe(true);
  });

  it('ensureBootMigrations is once-per-isolate and resettable for tests', async () => {
    const first = makeMigrationD1();
    initD1(first as never);
    const reportA = await ensureBootMigrations();

    // A second, fresh D1 injected before any reset is IGNORED — cached promise.
    const second = makeMigrationD1();
    initD1(second as never);
    const reportB = await ensureBootMigrations();
    expect(reportB).toBe(reportA);
    expect(second.__ddlLog).toEqual([]);

    __resetBootMigrationsForTests();
    const third = makeMigrationD1();
    initD1(third as never);
    const reportC: BootMigrationsReport = await ensureBootMigrations();
    expect(reportC).not.toBe(reportA);
    expect(reportC.applied).toEqual(FILE_ORDER);
  });
});

describe('splitSqlStatements + migrationObjects (the shared truth)', () => {
  it('comment text that QUOTES sql ("CREATE TABLE IF NOT EXISTS on first use") is not parsed as DDL', () => {
    const d1_0003 = BOOT_MIGRATIONS.find((m) => m.file === 'd1_0003_client_crash_reports.sql')!;
    const objs = migrationObjects(splitSqlStatements(d1_0003.sql));
    expect(objs.tables).toEqual(['client_crash_reports']); // not ["on", "client_crash_reports"]
    expect(objs.indexes).toEqual(['idx_client_crash_reports_created', 'idx_client_crash_reports_cause']);
  });

  it('the splitter keeps semicolons inside string literals and strips both comment kinds', () => {
    const sql = [
      '-- leading comment; with a semicolon',
      '/* block; comment */',
      "CREATE TABLE IF NOT EXISTS t (a TEXT DEFAULT 'x;y');",
      'CREATE INDEX IF NOT EXISTS i_t ON t (a);',
    ].join('\n');
    const stmts = splitSqlStatements(sql);
    expect(stmts).toEqual([
      "CREATE TABLE IF NOT EXISTS t (a TEXT DEFAULT 'x;y')",
      'CREATE INDEX IF NOT EXISTS i_t ON t (a)',
    ]);
  });
});
