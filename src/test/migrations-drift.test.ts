import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BOOT_MIGRATIONS, migrationObjects, splitSqlStatements } from '../db/migrations.js';

/**
 * THE DRIFT PIN (Lane D, 2026-10-31). The migrations/ directory and the
 * boot-applier manifest in src/db/migrations.ts must never diverge: a
 * migration file that exists but is not mounted will never auto-apply —
 * exactly the "migrations were never applied in production" gap this lane
 * closes. These tests fail on any of:
 *
 *   - a file in migrations/ the manifest does not cover (orphan),
 *   - a manifest entry with no file (ghost),
 *   - a manifest whose SQL differs from the file by even one byte,
 *   - a manifest out of filename order (d1_0009 ALTERs what d1_0005 creates),
 *   - a statement that is not idempotent DDL (CREATE ... IF NOT EXISTS /
 *     ALTER ... ADD COLUMN) — never destructive, per the house rule.
 *
 * Mutation-proven 2026-10-31: an orphan file, a drifted file body, and a
 * correctly-mounted DROP TABLE each failed the corresponding test before
 * this comment was written.
 *
 * NOTE: paths resolve from process.cwd() (vitest's root = the repo, locally
 * and in CI) — the global `URL` type here is the Workers one and clashes
 * with node:url's PathLike, so no URL-based paths in this file.
 */

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');

const normalize = (s: string): string => s.replace(/\r\n/g, '\n');

function migrationFilesOnDisk(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

describe('drift pin: migrations/ directory vs the boot-applier manifest', () => {
  it('every file in migrations/ is mounted — no orphan an author forgot to add', () => {
    const onDisk = migrationFilesOnDisk();
    const mounted = BOOT_MIGRATIONS.map((m) => m.file);
    const orphans = onDisk.filter((f) => !mounted.includes(f));
    expect(
      orphans,
      `files in migrations/ NOT covered by BOOT_MIGRATIONS (add them to src/db/migrations.ts in the same commit): ${orphans.join(', ')}`,
    ).toEqual([]);
  });

  it('every manifest entry names a real file — no ghosts for deleted migrations', () => {
    const onDisk = new Set(migrationFilesOnDisk());
    const ghosts = BOOT_MIGRATIONS.map((m) => m.file).filter((f) => !onDisk.has(f));
    expect(ghosts, 'manifest entries with no migrations/ file').toEqual([]);
  });

  it('manifest SQL is byte-identical to its file (LF-normalized)', () => {
    expect(BOOT_MIGRATIONS.length).toBeGreaterThan(0);
    for (const m of BOOT_MIGRATIONS) {
      const onDisk = normalize(readFileSync(join(MIGRATIONS_DIR, m.file), 'utf8')).trimEnd();
      expect(normalize(m.sql).trimEnd(), `manifest SQL diverged from migrations/${m.file}`).toBe(onDisk);
    }
  });

  it('manifest order is filename order — d1_0005 creates the table before d1_0009 ALTERs it', () => {
    const mounted = BOOT_MIGRATIONS.map((m) => m.file);
    const sorted = [...mounted].sort();
    expect(mounted).toEqual(sorted);
    const createIdx = mounted.findIndex((f) => f === 'd1_0005_changelog_entries.sql');
    const alterIdx = mounted.findIndex((f) => f === 'd1_0009_changelog_category.sql');
    expect(createIdx, 'd1_0005 must be mounted').toBeGreaterThanOrEqual(0);
    expect(alterIdx, 'd1_0009 must be mounted').toBeGreaterThan(createIdx);
  });

  it('every mounted statement is idempotent DDL only — never destructive', () => {
    for (const m of BOOT_MIGRATIONS) {
      const statements = splitSqlStatements(m.sql);
      expect(statements.length, `${m.file} produced no statements`).toBeGreaterThan(0);
      for (const stmt of statements) {
        const idempotent =
          /^CREATE (?:TABLE|UNIQUE INDEX|INDEX|VIEW|TRIGGER) IF NOT EXISTS\s+/i.test(stmt) ||
          /^ALTER TABLE\s+[A-Za-z_]\w*\s+ADD COLUMN\s+/i.test(stmt);
        expect(idempotent, `${m.file} contains non-idempotent/destructive DDL: ${stmt.slice(0, 80)}`).toBe(true);
      }
    }
  });

  it('every mounted statement is a SINGLE statement — D1 prepare() takes one at a time', () => {
    for (const m of BOOT_MIGRATIONS) {
      for (const stmt of splitSqlStatements(m.sql)) {
        expect(stmt.includes(';'), `${m.file}: statement still carries a semicolon: ${stmt.slice(0, 60)}`).toBe(false);
      }
    }
  });

  it('the sqlite_master probe stays under D1 bind limit — total object names <= 90', () => {
    // The boot applier binds every table+index name into ONE statement; D1
    // caps a statement at 100 bound parameters. Fail here (not at boot)
    // when the manifest grows past the safety margin.
    const total = BOOT_MIGRATIONS.reduce((sum, m) => {
      const objs = migrationObjects(splitSqlStatements(m.sql));
      return sum + objs.tables.length + objs.indexes.length;
    }, 0);
    expect(total, 'split the sqlite_master probe into batches when crossing the bind limit').toBeLessThanOrEqual(90);
  });
});
