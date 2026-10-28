import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { CookieOptions } from 'hono/utils/cookie';
import { env } from '../env.js';
import type { JwtPayload } from '../types/index.js';

/** Name of the auth cookie. */
export const AUTH_COOKIE_NAME = 'imperium_session';
/** JWT lifetime in seconds (7 days). */
export const JWT_EXPIRY_SECONDS = 7 * 24 * 60 * 60;
/**
 * X-01: issuers in this JWT trust family (one shared JWT_SECRET, two signer
 * implementations). Enforced when the claim is present — see verifyJwt.
 */
const EXPECTED_JWT_ISSUERS = new Set(['imperium-backend', 'imperium-frontend']);
const EXPECTED_JWT_AUDIENCE = 'imperium-api';

/**
 * Issue #2 — the Imperium Client (game launcher) token family. A client token
 * proves Minecraft-account ownership via the Mojang hasJoined handshake and is
 * presented as `Authorization: Bearer …` — never as a cookie. It carries its
 * OWN audience so the two families are not replayable cross-context:
 *   - verifyJwt (sessions)      rejects aud !== 'imperium-api' — a client
 *     token in the auth cookie dies at the audience check (and at the
 *     authMethod check before it);
 *   - verifyClientJwt (client)  REQUIRES aud === 'imperium-client' and
 *     authMethod === 'mc_client' — a website session presented as a bearer
 *     client token dies there.
 */
export const CLIENT_JWT_AUDIENCE = 'imperium-client';
/** Client token lifetime (24h, per issue #2) — shorter than sessions on purpose. */
export const CLIENT_JWT_EXPIRY_SECONDS = 24 * 60 * 60;
const CLIENT_JWT_ISSUER = 'imperium-backend';

type SignPayload = Omit<JwtPayload, 'iat' | 'exp'>;

const encoder = new TextEncoder();

function secretKey(): Uint8Array {
  return encoder.encode(env.jwtSecret);
}

/**
 * Create a signed JWT for either a Discord session or an in-game-code
 * session. Uses `jose` (Web Crypto / SubtleCrypto) rather than
 * `jsonwebtoken` (Node crypto) — this is the backend's own session system
 * (not the live user-facing one on romanica.net), but it still needs to
 * run in the Workers runtime, so it's built on the portable primitive.
 */
export async function signJwt(payload: SignPayload): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + JWT_EXPIRY_SECONDS)
    .sign(secretKey());
}

/**
 * Verify and decode a JWT. Returns null if the token is invalid, malformed,
 * or expired (instead of throwing, so middleware can treat it as "no user").
 */
export async function verifyJwt(token: string | undefined | null): Promise<JwtPayload | null> {
  if (!token) return null;
  try {
    // Pin the algorithm to HS256 to block alg-confusion attacks (e.g. forging
    // a token with alg=none or an asymmetric alg against the symmetric secret).
    const { payload: decoded } = await jwtVerify<JWTPayload & SignPayload>(token, secretKey(), {
      algorithms: ['HS256'],
    });
    // authMethod is required on every token we sign; a token missing it was
    // signed before this field existed (or is malformed) — treat as invalid
    // rather than guessing a default that could mis-authorize a request.
    // 'mc_client' (issue #2) is deliberately ABSENT from this list: this is
    // the SESSION verifier, and a client token must never establish a
    // website session even if its audience claim were stripped — client
    // tokens verify only through verifyClientJwt.
    if (decoded.authMethod !== 'discord' && decoded.authMethod !== 'mc_code') {
      return null;
    }
    // X-01 (forwarded-JWT hygiene): the frontend forwards its own session
    // token under this cookie name (same shared JWT_SECRET). Previously a
    // 400-day forwarded TTL silently overrode the backend's 7-day policy —
    // verifyJwt only checked that `exp` was in the future. Now the cap is
    // enforced here regardless of the exp claim: a token older than
    // JWT_EXPIRY_SECONDS, or whose total lifetime exceeds it, is rejected.
    // Fail closed on missing iat/exp — every signer in this trust family
    // stamps both.
    if (typeof decoded.iat !== 'number' || typeof decoded.exp !== 'number') {
      return null;
    }
    if (decoded.exp - decoded.iat > JWT_EXPIRY_SECONDS) return null;
    if (Math.floor(Date.now() / 1000) - decoded.iat > JWT_EXPIRY_SECONDS) return null;
    // Issuer/audience: enforced when present. Legacy tokens (both signers)
    // carry neither; new tokens carry iss ∈ {imperium-backend,
    // imperium-frontend} and aud imperium-api, so a token from any OTHER
    // service sharing the key family is distinguishable and rejected.
    if (decoded.iss !== undefined && !EXPECTED_JWT_ISSUERS.has(decoded.iss)) {
      return null;
    }
    const aud = Array.isArray(decoded.aud) ? decoded.aud[0] : decoded.aud;
    if (aud !== undefined && aud !== EXPECTED_JWT_AUDIENCE) {
      return null;
    }
    return {
      authMethod: decoded.authMethod,
      discordId: decoded.discordId,
      discordUsername: decoded.discordUsername,
      discordAvatar: decoded.discordAvatar ?? null,
      mcUuid: decoded.mcUuid,
      // B-01/X-04 claim fallback: forwarded tokens may carry the panel's
      // verified staff role. Only the closed enum survives verification —
      // anything else is dropped (the LuckPerms linkage fallback then
      // decides, never the garbage claim).
      staffRole:
        decoded.staffRole === 'helper' || decoded.staffRole === 'mod' || decoded.staffRole === 'admin'
          ? decoded.staffRole
          : undefined,
      iat: decoded.iat,
      exp: decoded.exp,
    };
  } catch {
    return null;
  }
}

/* ── Issue #2: the client (launcher) token family ───────────────────────────
 * Signed with the same HS256 secret but a distinct audience + authMethod, so
 * the session verifier and the client verifier each reject the other's
 * family. 24h lifetime, returned in the verify response body (never a cookie).
 */

/** Payload of a client token — mcUuid is mandatory (it IS the identity). */
export interface ClientJwtPayload {
  authMethod: 'mc_client';
  mcUuid: string;
  discordId?: string;
  iat: number;
  exp: number;
}

type ClientSignPayload = Omit<ClientJwtPayload, 'iat' | 'exp'>;

/** Sign a client token (24h, iss imperium-backend, aud imperium-client). */
export async function signClientJwt(payload: ClientSignPayload): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + CLIENT_JWT_EXPIRY_SECONDS)
    .setIssuer(CLIENT_JWT_ISSUER)
    .setAudience(CLIENT_JWT_AUDIENCE)
    .sign(secretKey());
}

/**
 * Verify a client bearer token. Strict where verifyJwt is lenient-for-legacy:
 * there are no "legacy" client tokens (the family is new), so BOTH iss and aud
 * are REQUIRED (jose enforces them via the options below; a session token
 * carrying aud imperium-api fails the audience check). Same X-01-style
 * lifetime discipline as sessions, capped at 24h instead of 7d. Returns null
 * on anything invalid — callers treat that as "no user".
 */
export async function verifyClientJwt(token: string | undefined | null): Promise<ClientJwtPayload | null> {
  if (!token) return null;
  try {
    const { payload: decoded } = await jwtVerify<JWTPayload & ClientSignPayload>(token, secretKey(), {
      algorithms: ['HS256'],
      issuer: CLIENT_JWT_ISSUER,
      audience: CLIENT_JWT_AUDIENCE,
    });
    if (decoded.authMethod !== 'mc_client' || typeof decoded.mcUuid !== 'string') return null;
    if (typeof decoded.iat !== 'number' || typeof decoded.exp !== 'number') return null;
    if (decoded.exp - decoded.iat > CLIENT_JWT_EXPIRY_SECONDS) return null;
    if (Math.floor(Date.now() / 1000) - decoded.iat > CLIENT_JWT_EXPIRY_SECONDS) return null;
    return {
      authMethod: 'mc_client',
      mcUuid: decoded.mcUuid,
      discordId: typeof decoded.discordId === 'string' ? decoded.discordId : undefined,
      iat: decoded.iat,
      exp: decoded.exp,
    };
  } catch {
    return null;
  }
}

/** Hono CookieOptions for the auth cookie. */
export function authCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: 'Lax',
    path: '/',
    maxAge: JWT_EXPIRY_SECONDS,
  };
}

/** Cookie options used to clear the auth cookie. */
export function clearAuthCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: env.isProduction,
    sameSite: 'Lax',
    path: '/',
    maxAge: 0,
  };
}
