/**
 * fetch() for Mojang's APIs. They answer Cloudflare Workers with a 403 block
 * page (verified 2026-10-24 for sessionserver, api.mojang.com and
 * api.minecraftservices.com), so when MOJANG_RELAY_URL and MOJANG_RELAY_SECRET
 * are set, Mojang calls go through the relay in /relay (Vercel). Other hosts,
 * and local runs without the relay configured, use plain fetch.
 */
const MOJANG_HOSTS = new Set([
  'sessionserver.mojang.com',
  'api.mojang.com',
  'api.minecraftservices.com',
]);

export function mojangFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const relay = process.env.MOJANG_RELAY_URL;
  const secret = process.env.MOJANG_RELAY_SECRET;
  if (!relay || !secret || !MOJANG_HOSTS.has(new URL(url).hostname)) {
    return fetch(url, init);
  }
  const headers = new Headers(init.headers);
  headers.set('x-relay-secret', secret);
  return fetch(`${relay}?u=${encodeURIComponent(url)}`, { ...init, headers });
}
