const fs = require('fs');

// Adds an in-memory D1 stub to the two failing test files so the D1-backed
// rate limiter has a shared counter store in tests (the old in-memory limiter
// worked implicitly; the new one needs the D1 binding mocked).
function addD1Stub(path) {
  let s = fs.readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  if (s.includes('makeD1Stub')) { console.log(path, 'already stubbed'); return; }
  const stub = `
// D1 stub for the rate limiter (shared in-memory counter map — mirrors D1's
// single-row-per-key upsert semantics closely enough for limit tests).
function makeD1Stub() {
  const rows = new Map<string, number>();
  return {
    prepare(sql: string) {
      return {
        _sql: sql,
        bind(...args: unknown[]) {
          return {
            async first<T>() {
              if (sql.startsWith('CREATE TABLE')) return null as T;
              if (sql.startsWith('INSERT INTO')) {
                const key = String(args[0]);
                const next = (rows.get(key) ?? 0) + 1;
                rows.set(key, next);
                return { hits: next } as T;
              }
              return null as T;
            },
            async run() { return { meta: {} }; },
            async all<T>() { return { results: [] as T[] }; },
          };
        },
        async run() { return { meta: {} }; },
        async first<T>() { return null as T; },
        async all<T>() { return { results: [] as T[] }; },
      };
    },
  };
}
let d1Stub: ReturnType<typeof makeD1Stub> | null = null;
`;
  // inject after the pool mock
  const anchor = "vi.mock('../db/pool.js', async (importOriginal) => {";
  const i = s.indexOf(anchor);
  if (i === -1) { console.error(path, 'pool mock anchor missing'); return; }
  // insert stub BEFORE the mock and register initD1 inside the mock factory
  s = s.slice(0, i) + stub + '\n' + s.slice(i);
  // inside the mock factory, wire getD1 to the stub
  s = s.replace(
    "  return {\n    ...actual,\n    query: vi.fn(),",
    "  d1Stub = makeD1Stub();\n  return {\n    ...actual,\n    getD1: () => d1Stub!,\n    query: vi.fn(),",
  );
  // reset the counter map between tests where mocks are reset
  s = s.replace('vi.mocked(queryMock).mockReset();', 'vi.mocked(queryMock).mockReset();\n  d1Stub = makeD1Stub();');
  fs.writeFileSync(path, s);
  console.log(path, 'stubbed');
}

addD1Stub('src/test/api-expansion.test.ts');
