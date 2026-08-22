const fs = require('fs');
const p = 'src/test/public-profile.test.ts';
let s = fs.readFileSync(p, 'utf8');

const OLD = [
  '  return {',
  '    ...actual,',
  '    query: vi.fn(),',
  '    getPlayerProfile: vi.fn(),',
].join('\n');
const NEW = [
  '  const rows = new Map<string, number>();',
  '  const d1Stub = {',
  '    prepare(sql: string) {',
  '      return {',
  '        bind(...args: unknown[]) {',
  '          return {',
  '            async first<T>() {',
  "              if (sql.startsWith('INSERT INTO')) {",
  '                const key = String(args[0]);',
  '                const next = (rows.get(key) ?? 0) + 1;',
  '                rows.set(key, next);',
  '                return { hits: next } as T;',
  '              }',
  '              return null as T;',
  '            },',
  '            async run() { return { meta: {} }; },',
  '          };',
  '        },',
  '        async run() { return { meta: {} }; },',
  '        async first<T>() { return null as T; },',
  '      };',
  '    },',
  '  };',
  '  return {',
  '    ...actual,',
  '    getD1: () => d1Stub,',
  '    query: vi.fn(),',
  '    getPlayerProfile: vi.fn(),',
].join('\n');
if (!s.includes(OLD)) { console.error('anchor missing'); process.exit(1); }
s = s.replace(OLD, NEW);
fs.writeFileSync(p, s);
console.log('stubbed');
