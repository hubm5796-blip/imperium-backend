import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { CookieOptions } from 'hono/utils/cookie';
import { env } from '../env.js';
import type { JwtPayload } from '../types/index.js';

/** Name of the auth cookie. */
export const AUTH_COOKIE_NAME = 'imperium_session';
/** JWT lifetime in seconds (7 days). */
export const JWT_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

type SignPayload = Omit<JwtPayload, 'iat' | 'exp'>;

const encoder = new TextEncoder();

function secretKey(): Uint8Array {
  return encoder.encode(env.jwtSecret);
}

/**
 * Create a signed JWT for either a Discord session or an in-game-code
 * session. Uses `jose` (Web Crypto / SubtleCrypto) rather than
 * `jsonwebtoken` (Node crypto) — this is the backend's own session system
 * (not the live user-facing one on imperiummc.net), but it still needs to
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
    if (decoded.authMethod !== 'discord' && decoded.authMethod !== 'mc_code') {
      return null;
    }
    return {
      authMethod: decoded.authMethod,
      discordId: decoded.discordId,
      discordUsername: decoded.discordUsername,
      discordAvatar: decoded.discordAvatar ?? null,
      mcUuid: decoded.mcUuid,
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
