/**
 * Issue #2 — Imperium Client sign-in via the Mojang session check.
 *
 *   POST /api/client/auth/challenge   anonymous, 10/min/IP → { serverId, expiresIn }
 *   POST /api/client/auth/verify      anonymous, 10/min/IP → { token, … }
 *
 * Mounted at /api/client (app.ts mounts this BEFORE the `api` sub-app, the
 * same prefix-claim trick as licenseAdminApi) so the anonymous auth endpoints
 * never run the v1 session stack.
 *
 * PROOF MODEL: the launcher must prove it owns the Minecraft account WITHOUT
 * sending us any Microsoft/Minecraft token. We use the exact handshake every
 * online-mode Minecraft server uses at join:
 *
 *   1. challenge — we mint a random `serverId` (20 bytes hex), single-use in
 *      Redis for 60s;
 *   2. the client calls Mojang's join endpoint itself through the game's
 *      session service (the token never leaves the client);
 *   3. verify — we atomically consume the challenge (GETDEL: replays die
 *      before the sessionserver is even asked), then ask Mojang
 *      hasJoined?username=&serverId=. A 200 + profile is proof of ownership
 *      and carries the account UUID; a 204 is "not joined" → 401.
 *
 * The issued token is a JWT with authMethod 'mc_client', aud
 * 'imperium-client' and a 24h expiry, returned IN THE BODY (never a cookie —
 * the client is not a browser). It is accepted as `Authorization: Bearer …`
 * and confined to CLIENT_TOKEN_ALLOWED_ROUTES by gates.clientTokenAllowlist.
 */
import { Hono } from 'hono';
import {
  CLIENT_JWT_EXPIRY_SECONDS,
  signClientJwt,
} from '../auth/jwt.js';
import {
  consumeClientAuthChallenge,
  createClientAuthChallenge,
} from '../db/redis.js';
import { getDiscordIdByUuid } from '../db/pool.js';
import { parseMcUuid } from '../middleware/gates.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { logger } from '../utils/logger.js';
import { ok, fail } from './v2/respond.js';
import type { AppContextVariables } from '../types/index.js';

type ApiEnv = { Variables: AppContextVariables };

export const clientAuthApi = new Hono<ApiEnv>();

/** Challenge lifetime (seconds) — issue #2 pins this at 60. */
const CHALLENGE_TTL_SECONDS = 60;
/** serverId shape we mint: 20 bytes as lowercase hex (40 chars). */
const SERVER_ID_RE = /^[a-f0-9]{40}$/;
/** Java Minecraft username shape — Bedrock identities cannot join Mojang's
 *  session server, so the dot-prefix form is not valid here. */
const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const HASJOINED_URL = 'https://sessionserver.mojang.com/session/minecraft/hasJoined';
const HASJOINED_TIMEOUT_MS = 5_000;

/**
 * Per-endpoint 10/min-per-IP limits (issue #2). OWN namespaces, not the
 * shared 'auth' one — B-51 discipline: a fat-fingered verify loop must not
 * burn the OAuth callback's bucket, and vice versa.
 */
const challengeRateLimit = rateLimit(10, 60_000, 'client-auth-challenge');
const verifyRateLimit = rateLimit(10, 60_000, 'client-auth-verify');

/** POST /api/client/auth/challenge — mint a single-use serverId. */
clientAuthApi.post('/auth/challenge', challengeRateLimit, async (c) => {
  let serverId: string;
  try {
    serverId = await createClientAuthChallenge(CHALLENGE_TTL_SECONDS);
  } catch (err) {
    logger.error({ err: String(err) }, 'client auth challenge store failed');
    return fail(c, 503, 'REGISTRY_UNAVAILABLE', 'Sign-in unavailable, try again shortly.');
  }
  return ok(c, { serverId, expiresIn: CHALLENGE_TTL_SECONDS });
});

/** POST /api/client/auth/verify — consume the challenge, check Mojang, issue
 *  the client token. Body: { username, serverId }. */
clientAuthApi.post('/auth/verify', verifyRateLimit, async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, 'INVALID_PARAM', 'Invalid JSON body.');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return fail(c, 400, 'INVALID_PARAM', 'Expected a JSON object.');
  }
  const b = body as Record<string, unknown>;
  const username = typeof b.username === 'string' ? b.username.trim() : '';
  const serverId = typeof b.serverId === 'string' ? b.serverId.trim().toLowerCase() : '';
  if (!USERNAME_RE.test(username)) {
    return fail(c, 400, 'INVALID_PARAM', '`username` must be a 3-16 character Java Minecraft name.');
  }
  if (!SERVER_ID_RE.test(serverId)) {
    return fail(c, 400, 'INVALID_PARAM', '`serverId` must be the challenge issued by /api/client/auth/challenge.');
  }
  // Unknown params are ignored (v1-mount convention); the two fields above are
  // the whole contract.

  // Consume FIRST (single-use, atomic): a replayed or unknown serverId dies
  // here without ever costing a sessionserver round trip.
  let challenge: { createdAt: number } | null;
  try {
    challenge = await consumeClientAuthChallenge(serverId);
  } catch (err) {
    logger.error({ err: String(err) }, 'client auth challenge store failed');
    return fail(c, 503, 'REGISTRY_UNAVAILABLE', 'Sign-in unavailable, try again shortly.');
  }
  if (!challenge) {
    // Never issued / expired / already consumed — all the same answer, so the
    // endpoint does not leak which.
    return fail(c, 401, 'UNAUTHORIZED', 'Unknown, expired or already-used challenge. Request a new one.');
  }

  // The Mojang session check. 200+profile = proof; 204 = not joined.
  const url = `${HASJOINED_URL}?username=${encodeURIComponent(username)}&serverId=${serverId}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(HASJOINED_TIMEOUT_MS),
    });
  } catch (err) {
    logger.warn({ err: String(err) }, 'sessionserver hasJoined fetch failed');
    return fail(c, 503, 'SESSIONSERVER_UNAVAILABLE', 'Could not reach the Mojang session server, try again shortly.');
  }
  if (res.status === 204) {
    return fail(c, 401, 'UNAUTHORIZED', 'Session check failed — the account has not joined with this challenge.');
  }
  if (!res.ok) {
    logger.warn({ status: res.status }, 'sessionserver hasJoined unexpected status');
    return fail(c, 503, 'SESSIONSERVER_UNAVAILABLE', 'Session server error, try again shortly.');
  }
  let profile: { id?: unknown; name?: unknown };
  try {
    profile = (await res.json()) as { id?: unknown; name?: unknown };
  } catch {
    return fail(c, 503, 'SESSIONSERVER_UNAVAILABLE', 'Malformed session server response.');
  }
  // Canonicalise with the shared helper (B-06): Mojang returns the undashed
  // form; the store form is dashed lowercase everywhere.
  const uuid = parseMcUuid(typeof profile.id === 'string' ? profile.id : null);
  if (!uuid) {
    // 200 without a usable id — the sessionserver is misbehaving, which is an
    // upstream failure, not an auth failure.
    return fail(c, 503, 'SESSIONSERVER_UNAVAILABLE', 'Malformed session server response.');
  }
  // hasJoined already matches username↔profile, but the proof is only as good
  // as its weakest comparison — refuse a clear name mismatch explicitly.
  if (typeof profile.name === 'string' && profile.name.toLowerCase() !== username.toLowerCase()) {
    return fail(c, 401, 'UNAUTHORIZED', 'Session check failed — username does not match the joined account.');
  }

  // Existing Discord link, if any (same lookup the mc_code login uses). A DB
  // hiccup degrades to an unlinked token — the MC ownership proof stands on
  // its own.
  let discordId: string | null = null;
  try {
    discordId = await getDiscordIdByUuid(uuid);
  } catch {
    discordId = null;
  }

  const token = await signClientJwt({
    authMethod: 'mc_client',
    mcUuid: uuid,
    ...(discordId ? { discordId } : {}),
  });

  logger.info({ uuid, linked: discordId !== null }, 'client token issued via Mojang session check');
  return ok(c, {
    token,
    tokenType: 'Bearer',
    expiresIn: CLIENT_JWT_EXPIRY_SECONDS,
    uuid,
    username: typeof profile.name === 'string' ? profile.name : username,
    discordLinked: discordId !== null,
  });
});
