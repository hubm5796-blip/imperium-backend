/**
 * Mojang blocks Cloudflare Workers, so Mojang calls must leave through the
 * relay when it is configured, and nothing else may.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mojangFetch } from '../utils/mojangFetch.js';

describe('mojangFetch', () => {
  const calls: { url: string; secret: string | null }[] = [];

  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, secret: new Headers(init?.headers).get('x-relay-secret') });
      return new Response('{}', { status: 200 });
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.MOJANG_RELAY_URL;
    delete process.env.MOJANG_RELAY_SECRET;
  });

  it('sends Mojang hosts through the relay with the secret', async () => {
    process.env.MOJANG_RELAY_URL = 'https://relay.example/api/mojang';
    process.env.MOJANG_RELAY_SECRET = 's3cret';
    const target = 'https://sessionserver.mojang.com/session/minecraft/hasJoined?username=a&serverId=b';
    await mojangFetch(target);
    expect(calls).toEqual([{ url: `https://relay.example/api/mojang?u=${encodeURIComponent(target)}`, secret: 's3cret' }]);
  });

  it('never sends other hosts (or the secret) to the relay', async () => {
    process.env.MOJANG_RELAY_URL = 'https://relay.example/api/mojang';
    process.env.MOJANG_RELAY_SECRET = 's3cret';
    await mojangFetch('https://user.auth.xboxlive.com/user/authenticate', { method: 'POST' });
    expect(calls).toEqual([{ url: 'https://user.auth.xboxlive.com/user/authenticate', secret: null }]);
  });

  it('is plain fetch when the relay is not configured', async () => {
    await mojangFetch('https://api.mojang.com/users/profiles/minecraft/Notch');
    expect(calls).toEqual([{ url: 'https://api.mojang.com/users/profiles/minecraft/Notch', secret: null }]);
  });
});
