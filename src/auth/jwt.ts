import jwt, { type JwtPayload as LibJwtPayload } from 'jsonwebtoken';
import type { CookieOptions } from 'hono/utils/cookie';
import { env } from '../env.js';
import type { JwtPayload } from '../types/index.js';

/** Name of the auth cookie. */
export const AUTH_COOKIE_NAME = 'imperium_session';
/** JWT lifetime in seconds (7 days). */
export const JWT_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

type SignPayload = Omit<JwtPayload, 'iat' | 'exp'>;

/** Create a signed JWT containing the Discord identity. */
export function signJwt(payload: SignPayload): string {
  return jwt.sign(payload, env.jwtSecret, {
    algorithm: 'HS256',
    expiresIn: JWT_EXPIRY_SECONDS,
  });
}

/**
 * Verify and decode a JWT. Returns null if the token is invalid, malformed,
 * or expired (instead of throwing, so middleware can treat it as "no user").
 */
export function verifyJwt(token: string | undefined | null): JwtPayload | null {
  if (!token) return null;
  try {
    // Pin the algorithm to HS256 to block alg-confusion attacks (e.g. forging
    // a token with alg=none or an asymmetric alg against the symmetric secret).
    const decoded = jwt.verify(token, env.jwtSecret, {
      algorithms: ['HS256'],
    }) as LibJwtPayload & SignPayload;
    return {
      discordId: decoded.discordId,
      discordUsername: decoded.discordUsername,
      discordAvatar: decoded.discordAvatar ?? null,
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
