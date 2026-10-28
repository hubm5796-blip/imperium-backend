import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The key was hand-edited down to 58 characters on 2026-08-28 and every Discord interaction
// failed signature verification for two months without a single failing test.
describe('DISCORD_PUBLIC_KEY in wrangler.jsonc', () => {
  it('is a full 32-byte Ed25519 key (64 hex characters)', () => {
    const config = readFileSync('wrangler.jsonc', 'utf8');
    const key = /"DISCORD_PUBLIC_KEY"\s*:\s*"([^"]*)"/.exec(config)?.[1];
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
});
