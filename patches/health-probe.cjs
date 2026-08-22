const fs = require('fs');
const p = 'src/app.ts';
let s = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

const OLD = [
  "  // V6 01-08: health reports the deployed version so the bot/frontend/backend compatibility",
  "  // matrix is queryable (and deploys are confirmable with a single curl).",
  "  app.get('/health', (c) =>",
  "    c.json({",
  "      status: 'ok',",
  "      version: '1.0.0',",
  "      deployedAt: new Date().toISOString(),",
  "    }),",
  "  );",
].join('\n');
const NEW = [
  "  // /health (FIX 2026-08-22 review): was decorative — hardcoded version, deployedAt = now(),",
  "  // and always-ok regardless of DB reachability. Now PROBES the database (1s budget) and",
  "  // reports the actual deploy stamp baked at build time. Monitors should treat 503 as down.",
  "  app.get('/health', async (c) => {",
  "    let db: 'ok' | 'down' = 'down';",
  "    try {",
  "      await Promise.race([",
  "        query('SELECT 1 AS ok'),",
  "        new Promise((_, rej) => setTimeout(() => rej(new Error('db probe timeout')), 1000)),",
  "      ]);",
  "      db = 'ok';",
  "    } catch {",
  "      // fall through — db stays down",
  "    }",
  "    return c.json(",
  "      {",
  "        status: db === 'ok' ? 'ok' : 'degraded',",
  "        db,",
  "        version: DEPLOY_VERSION,",
  "        deployedAt: DEPLOYED_AT,",
  "      },",
  "      db === 'ok' ? 200 : 503,",
  "    );",
  "  });",
].join('\n');
if (!s.includes(OLD)) { console.error('health block missing'); process.exit(1); }
s = s.replace(OLD, NEW);

const firstImport = s.indexOf('import ');
if (firstImport === -1) { console.error('no import'); process.exit(1); }
s = s.slice(0, firstImport) + [
  '// Build-time deploy stamp (FIX: /health previously returned now() as deploy time).',
  "const DEPLOY_VERSION = process.env.DEPLOY_VERSION ?? 'dev';",
  "const DEPLOYED_AT = process.env.DEPLOYED_AT ?? new Date().toISOString();",
  '',
  '',
].join('\n') + s.slice(firstImport);

// ensure `query` is imported
if (!s.includes("import { query")) {
  s = s.replace("import { Hono } from 'hono';", "import { Hono } from 'hono';\nimport { query } from './db/pool.js';");
}
fs.writeFileSync(p, s);
console.log('health probe installed');
