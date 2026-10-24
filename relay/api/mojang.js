/**
 * Mojang relay. Mojang's APIs answer Cloudflare Workers with a 403 block page,
 * so the backend (a Worker) sends its Mojang calls here and this function, on
 * non-Cloudflare egress, makes them. Only the endpoints below are forwarded,
 * and only for callers holding RELAY_SECRET.
 *
 *   GET|POST /api/mojang?u=<encoded Mojang URL>   header: x-relay-secret
 */
import { timingSafeEqual } from 'node:crypto';

// [method, exact URL prefix]. Prefixes end at a path boundary so
// "/minecraft/profile" can't be stretched into another endpoint.
const ALLOW = [
  ['GET', 'https://sessionserver.mojang.com/session/minecraft/hasJoined'],
  ['GET', 'https://sessionserver.mojang.com/session/minecraft/profile/'],
  ['GET', 'https://api.mojang.com/users/profiles/minecraft/'],
  ['POST', 'https://api.minecraftservices.com/authentication/login_with_xbox'],
  ['GET', 'https://api.minecraftservices.com/minecraft/profile'],
];

function allowed(method, target) {
  let u;
  try {
    u = new URL(target);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  const base = u.origin + u.pathname;
  return ALLOW.some(([m, prefix]) =>
    m === method && (prefix.endsWith('/') ? base.startsWith(prefix) && base.length > prefix.length : base === prefix));
}

function secretOk(given) {
  const want = process.env.RELAY_SECRET || '';
  if (!want || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function relay(request) {
  if (!secretOk(request.headers.get('x-relay-secret'))) {
    return new Response('forbidden', { status: 403 });
  }
  const target = new URL(request.url).searchParams.get('u') || '';
  if (!allowed(request.method, target)) {
    return new Response('endpoint not allowed', { status: 400 });
  }
  const headers = { Accept: 'application/json', 'User-Agent': 'Romanica/1.0 (+https://romanica.net)' };
  const auth = request.headers.get('authorization');
  if (auth) headers.Authorization = auth;
  let body;
  if (request.method === 'POST') {
    headers['Content-Type'] = 'application/json';
    body = await request.text();
  }
  const upstream = await fetch(target, { method: request.method, headers, body, signal: AbortSignal.timeout(8000) });
  // hasJoined answers "not joined" with 204, and a 204/304 Response must have no body.
  const empty = upstream.status === 204 || upstream.status === 304;
  return new Response(empty ? null : await upstream.text(), {
    status: upstream.status,
    headers: { 'Content-Type': upstream.headers.get('content-type') || 'text/plain', 'Cache-Control': 'no-store' },
  });
}

export const GET = relay;
export const POST = relay;
