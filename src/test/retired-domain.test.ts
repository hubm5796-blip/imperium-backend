import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// imperiummc.net is retired and being transferred; nothing outside tests may
// point players at it (Discord footers and changelog text did until 2026-10-24).
const SRC = join(__dirname, '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'test' ? [] : walk(p);
    return p.endsWith('.ts') ? [p] : [];
  });
}

describe('retired domain', () => {
  it('no src file outside tests mentions imperiummc.net', () => {
    const files = walk(SRC);
    expect(files.length).toBeGreaterThan(50);
    const hits = files
      .filter((f) => /imperiummc\.net/i.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f));
    expect(hits).toEqual([]);
  });
});
