// Deploy stamp (L15, 2026-11-14). /health used to report version "dev" and
// deployedAt 1970-01-01 because nothing in the deploy path ever set
// DEPLOY_VERSION/DEPLOYED_AT — a stale deploy (production running code days
// behind master) was invisible to monitors. This script stamps the git short
// SHA + UTC time into src/generated/deployStamp.ts immediately before
// `wrangler deploy` (see package.json "deploy"); app.ts falls back to it when
// the process env carries no explicit stamp.
//
// The generated file is COMMITTED after each deploy so the tree stays clean
// and the committed stamp mirrors what production is running.
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const at = new Date().toISOString();
let sha = '';
try {
  sha = execSync('git rev-parse --short HEAD', { stdio: ['pipe', 'pipe', 'pipe'] })
    .toString()
    .trim();
} catch {
  sha = '';
}
const version = /^[0-9a-f]{7,}$/.test(sha) ? `1.0.0+${sha}` : `unstamped-${at}`;

mkdirSync('src/generated', { recursive: true });
writeFileSync(
  'src/generated/deployStamp.ts',
  `// AUTO-STAMPED by scripts/stamp-deploy.mjs before each wrangler deploy — do not edit by hand.
// Committed after deploys so the tree mirrors the stamp production serves at /health.
export const DEPLOY_STAMP_VERSION = ${JSON.stringify(version)};
export const DEPLOY_STAMP_AT = ${JSON.stringify(at)};
`,
);
console.log(`[stamp] DEPLOY_VERSION=${version} DEPLOYED_AT=${at}`);
