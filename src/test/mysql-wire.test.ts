/**
 * B-C27 — mysqlWire placeholder-substitution + escaping contract tests.
 *
 * applyPlaceholders used to replace EVERY '?' character in the SQL text, so a
 * '?' inside a string literal / identifier / comment consumed a parameter and
 * shifted all later bindings (silent query corruption). These tests pin the
 * stateful scanner: only bare-SQL '?' binds, and escaped string values
 * round-trip through MySQL's backslash escape set.
 */
import { describe, expect, it } from 'vitest';
import { applyPlaceholders, escapeValue } from '../db/mysqlWire.js';

describe('B-C27: applyPlaceholders skips ? inside string literals', () => {
  it("a '?' inside a single-quoted literal survives and the real placeholder still binds", () => {
    const out = applyPlaceholders("SELECT * FROM logs WHERE reason = 'Ready?' AND id = ?", [7]);
    expect(out).toBe("SELECT * FROM logs WHERE reason = 'Ready?' AND id = 7");
  });

  it("a LIKE pattern containing '?' is not substituted", () => {
    const out = applyPlaceholders("SELECT * FROM t WHERE name LIKE '%is?it%' AND n = ?", ['x']);
    expect(out).toBe("SELECT * FROM t WHERE name LIKE '%is?it%' AND n = 'x'");
  });

  it("a backslash-escaped quote does not terminate the literal, so its '?' stays literal", () => {
    const out = applyPlaceholders("SELECT * FROM t WHERE a = 'it\\'s ok?' AND b = ?", [1]);
    expect(out).toBe("SELECT * FROM t WHERE a = 'it\\'s ok?' AND b = 1");
  });

  it("a doubled quote ('') is an escaped quote, not the end of the literal", () => {
    const out = applyPlaceholders("SELECT * FROM t WHERE a = 'it''s a ? test' AND b = ?", [2]);
    expect(out).toBe("SELECT * FROM t WHERE a = 'it''s a ? test' AND b = 2");
  });

  it("a '?' inside a double-quoted string is skipped", () => {
    const out = applyPlaceholders('SELECT * FROM t WHERE msg = "what?" AND n = ?', [3]);
    expect(out).toBe('SELECT * FROM t WHERE msg = "what?" AND n = 3');
  });

  it("a '?' inside a backtick identifier is skipped (doubled backtick included)", () => {
    const out = applyPlaceholders('SELECT `why?` FROM t WHERE id = ?', [4]);
    expect(out).toBe('SELECT `why?` FROM t WHERE id = 4');
    const nested = applyPlaceholders('SELECT `weird``name?` FROM t WHERE id = ?', [5]);
    expect(nested).toBe('SELECT `weird``name?` FROM t WHERE id = 5');
  });
});

describe('B-C27: applyPlaceholders skips ? inside comments', () => {
  it('block comments are transparent to binding', () => {
    const out = applyPlaceholders('SELECT /* a ? here */ 1 FROM t WHERE id = ?', [9]);
    expect(out).toBe('SELECT /* a ? here */ 1 FROM t WHERE id = 9');
  });

  it('`-- ` line comments are transparent to binding', () => {
    const out = applyPlaceholders('SELECT 1 -- trailing ? comment\nFROM t WHERE id = ?', [10]);
    expect(out).toBe('SELECT 1 -- trailing ? comment\nFROM t WHERE id = 10');
  });

  it('`#` line comments are transparent to binding', () => {
    const out = applyPlaceholders('SELECT 1 # hash ? comment\nFROM t WHERE id = ?', [11]);
    expect(out).toBe('SELECT 1 # hash ? comment\nFROM t WHERE id = 11');
  });

  it("'--' without a following space is arithmetic, not a comment (MySQL rule)", () => {
    const out = applyPlaceholders('SELECT 5--3 FROM t WHERE id = ?', [12]);
    expect(out).toBe('SELECT 5--3 FROM t WHERE id = 12');
  });
});

describe('B-C27: applyPlaceholders binding semantics', () => {
  it('multiple bare placeholders bind in order', () => {
    const out = applyPlaceholders('SELECT * FROM t WHERE a = ? AND b = ? AND c = ?', [1, 'two', null]);
    expect(out).toBe("SELECT * FROM t WHERE a = 1 AND b = 'two' AND c = NULL");
  });

  it('more params than bindable placeholders still throws (mismatch guard)', () => {
    expect(() => applyPlaceholders('SELECT 1', [1])).toThrow(/params, only/);
    // The '?' in the literal is NOT a binding site, so the surplus param must error.
    expect(() => applyPlaceholders("SELECT 'what?' FROM t", [1])).toThrow(/params, only/);
  });

  it('no params is a passthrough', () => {
    expect(applyPlaceholders("SELECT 'why?'", [])).toBe("SELECT 'why?'");
  });
});

describe('B-C27: escapeValue covers the full MySQL control set', () => {
  /** Invert the escape set the way MySQL's parser would — proves round-trip. */
  function mysqlUnescape(literal: string): string {
    const body = literal.slice(1, -1); // strip the surrounding quotes
    let out = '';
    for (let i = 0; i < body.length; i++) {
      const ch = body[i]!;
      if (ch === '\\' && i + 1 < body.length) {
        const esc = body[++i]!;
        switch (esc) {
          case '0': out += '\x00'; break;
          case 'b': out += '\x08'; break;
          case 't': out += '\t'; break;
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 'Z': out += '\x1a'; break;
          case "'": out += "'"; break;
          case '"': out += '"'; break;
          case '\\': out += '\\'; break;
          default: throw new Error(`test unescaper: unexpected escape \\${esc}`);
        }
      } else {
        out += ch;
      }
    }
    return out;
  }

  const roundTripCases: Array<[string, string]> = [
    ['back\\slash', "'back\\\\slash'"],
    ['nul\x00byte', "'nul\\0byte'"],
    ['back\x08space', "'back\\bspace'"],
    ['tab\ttab', "'tab\\ttab'"],
    ['new\nline', "'new\\nline'"],
    ['carriage\rreturn', "'carriage\\rreturn'"],
    ['ctrl-z\x1aEOF', "'ctrl-z\\ZEOF'"],
    ["single'quote", "'single\\'quote'"],
    ['double"quote', "'double\\\"quote'"],
    ['all\x1a\ttogether\\with\'quotes"and\nnewlines', "'all\\Z\\ttogether\\\\with\\'quotes\\\"and\\nnewlines'"],
  ];

  it.each(roundTripCases)('escape %j produces %s and round-trips', (input, expected) => {
    const escaped = escapeValue(input);
    expect(escaped).toBe(expected);
    expect(mysqlUnescape(escaped)).toBe(input);
  });

  it('non-string scalars keep their existing forms', () => {
    expect(escapeValue(null)).toBe('NULL');
    expect(escapeValue(undefined)).toBe('NULL');
    expect(escapeValue(42)).toBe('42');
    expect(escapeValue(-1.5)).toBe('-1.5');
    expect(escapeValue(Number.POSITIVE_INFINITY)).toBe('NULL');
    expect(escapeValue(true)).toBe('1');
    expect(escapeValue(false)).toBe('0');
    expect(escapeValue(123n)).toBe('123');
  });
});
