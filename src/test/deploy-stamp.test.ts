import { describe, expect, it } from 'vitest';

/**
 * L15 (2026-11-14): /health reported version "dev" + deployedAt 1970-01-01 in
 * production because nothing in the deploy path set DEPLOY_VERSION/DEPLOYED_AT.
 * scripts/stamp-deploy.mjs (wired into `npm run deploy`) now stamps this
 * module before every wrangler deploy, and app.ts falls back to it. Pins the
 * stamp's shape so a broken stamp script fails here, not silently at /health.
 */
import { DEPLOY_STAMP_VERSION, DEPLOY_STAMP_AT } from '../generated/deployStamp.js';

describe('deploy stamp (L15)', () => {
  it('DEPLOY_STAMP_VERSION is never the bare dev placeholder', () => {
    expect(DEPLOY_STAMP_VERSION).toBeTruthy();
    expect(DEPLOY_STAMP_VERSION).not.toBe('dev');
  });

  it('DEPLOY_STAMP_VERSION is either a git-stamped semver or an explicit unstamped marker', () => {
    expect(DEPLOY_STAMP_VERSION).toMatch(/^(1\.0\.0\+[0-9a-f]{7,}|unstamped-.+)$/);
  });

  it('DEPLOY_STAMP_AT is a real ISO timestamp (not the 1970 sentinel)', () => {
    const ts = Date.parse(DEPLOY_STAMP_AT);
    expect(Number.isNaN(ts)).toBe(false);
    expect(ts).toBeGreaterThan(Date.parse('2026-01-01T00:00:00Z'));
  });
});
