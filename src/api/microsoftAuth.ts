/**
 * Microsoft (Minecraft) website sign-in — "the same stuff as the client":
 * the identical Azure app and auth chain the Romanica client's sign-in uses
 * (ImperiumClient common/modules/auth/MSApi.kt), executed server-side so a
 * plain browser can ride it.
 *
 * Chain (all server-side, each hop time-boxed):
 *   authorize (PKCE, scopes XboxLive.signin)
 *     -> login.microsoftonline.com/consumers/oauth2/v2.0/token
 *     -> user.auth.xboxlive.com/user/authenticate          (XBL, RPS ticket)
 *     -> xsts.auth.xboxlive.com/xsts/authorize             (XSTS, RETAIL sandbox)
 *     -> api.minecraftservices.com/authentication/login_with_xbox
 *     -> api.minecraftservices.com/minecraft/profile        (uuid + name)
 *
 * The resolved Minecraft identity hands off to the frontend exactly like the
 * Discord OAuth flow does: a one-time session code in Redis (60s TTL), the
 * frontend's /api/auth/ms/callback exchanges it and signs its own cookie on
 * romanica.net. No browser cookie is set on this domain.
 *
 * F-11 parity with the Discord flow, made stricter: /auth/ms/start REQUIRES
 * the ?state the frontend's start route generated, embeds it in the authorize
 * URL, and the callback echoes it back — the frontend gets the full
 * exact-match state check, not just cookie-presence.
 *
 * Azure prerequisite (owner, done 2026-10-23): https://api.romanica.net/api/auth/microsoft/callback
 * must be registered as a redirect URI on the app below (Web or SPA platform,
 * public client + PKCE — no secret).
 */
import { Hono } from 'hono';
import { env } from '../env.js';
import { logger } from '../utils/logger.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { createSessionCode, consumeMsOauthState, storeMsOauthState } from '../db/redis.js';
import { getDiscordIdByUuid } from '../db/pool.js';

/**
 * Romanica's own Azure app (the launcher signs players in with it; the owner
 * registered this callback on it). 938592fc-… is AxolotlClient upstream's app:
 * we can't register redirects there, so never point this at it.
 */
const MS_CLIENT_ID = process.env.MS_CLIENT_ID || '8b0c9e33-b6ce-40ec-ac30-c85a35dd8163';

export const AUTHORIZE_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize';
export const TOKEN_URL = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token';
const XBL_URL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const MC_AUTH_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox';
const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';

/** Same limiter shape as the Discord auth routes — start/callback are
 *  redirects any browser can be pointed at, so bound them per IP. */
const msAuthRateLimit = rateLimit(10, 60_000, 'ms-auth');

function frontendUrl(): string {
  return env.isProduction ? 'https://romanica.net' : 'http://localhost:3000';
}

/**
 * The redirect_uri MUST match the Azure registration byte-for-byte — derive
 * it from the incoming request so /start and /callback always agree, on
 * api.romanica.net or anywhere else the worker is bound.
 */
function redirectUri(requestUrl: string): string {
  return new URL('/api/auth/microsoft/callback', new URL(requestUrl).origin).toString();
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** S256 code challenge (RFC 7636): base64url(sha256(verifier)), no padding. */
async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

async function postJson(
  url: string,
  body: unknown,
): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const err = new Error(`${url} -> ${res.status}`) as Error & { data: unknown };
    err.data = data;
    throw err;
  }
  return data;
}

/** form-urlencoded POST for the OAuth token endpoint (it rejects JSON). */
async function postForm(url: string, fields: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(5000),
  });
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const err = new Error(`${url} -> ${res.status}`) as Error & { data: unknown };
    err.data = data;
    throw err;
  }
  return data;
}

/** Mojang's profile API returns the undashed 32-hex form; every store in our
 *  stack (plugin, DB, sessions) uses dashed. */
function dashUuid(undashed: string): string {
  return `${undashed.slice(0, 8)}-${undashed.slice(8, 12)}-${undashed.slice(12, 16)}-${undashed.slice(16, 20)}-${undashed.slice(20, 32)}`;
}

/**
 * XSTS XErr codes with a user-actionable meaning (learn.microsoft.com
 * xboxlive/auth error codes). Everything else collapses into one generic
 * message — distinguishable failures here would be an account oracle.
 */
function xerrToLoginError(xerr: number): string {
  switch (xerr) {
    case 2148916233: return 'ms_no_xbox'; // MS account has no Xbox profile
    case 2148916238: return 'ms_child'; // child account needs adult approval
    case 2148916235:
    case 2148916236:
    case 2148916237: return 'ms_region'; // Xbox unavailable in the account's country
    default: return 'ms_chain_failed';
  }
}

export const microsoftAuthApi = new Hono();

/** GET /api/auth/ms/start?state=<frontend state> — mint the PKCE pair, park
 *  the verifier under the state (single-use, 10 min), redirect to Microsoft. */
microsoftAuthApi.get('/auth/ms/start', msAuthRateLimit, async (c) => {
  const state = c.req.query('state') ?? '';
  // The frontend's start route ALWAYS sends this (its callback requires the
  // exact-match check). Refuse anything malformed rather than minting an
  // unverifiable flow.
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(state)) {
    return c.json({ error: 'Missing or malformed state' }, 400);
  }
  const verifier = base64url(randomBytes(32)); // 43 chars, the RFC minimum
  const challenge = await s256(verifier);
  await storeMsOauthState(state, verifier, 600);

  const authorize = new URL(AUTHORIZE_URL);
  authorize.searchParams.set('client_id', MS_CLIENT_ID);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('redirect_uri', redirectUri(c.req.url));
  authorize.searchParams.set('scope', 'XboxLive.signin');
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('code_challenge', challenge);
  authorize.searchParams.set('code_challenge_method', 'S256');
  authorize.searchParams.set('prompt', 'select_account');
  return c.redirect(authorize.toString(), 302);
});

/** GET /api/auth/ms/callback — the Microsoft hop lands here; run the Xbox ->
 *  Minecraft chain and hand the resolved identity to the frontend. */
// /auth/microsoft/callback is the URI registered on the Azure app; /auth/ms/callback
// stays for any flow started before the switch.
microsoftAuthApi.on('GET', ['/auth/microsoft/callback', '/auth/ms/callback'], msAuthRateLimit, async (c) => {
  const login = (code: string) => c.redirect(`${frontendUrl()}/login?error=${code}`, 302);

  const oauthError = c.req.query('error');
  if (oauthError) return login('ms_denied');

  const state = c.req.query('state') ?? '';
  const code = c.req.query('code') ?? '';
  if (!code || !state) return login('missing_code');

  // Single-use state: the verifier lives under it and is consumed here, so a
  // replayed or forged state finds nothing.
  const verifier = await consumeMsOauthState(state);
  if (!verifier) return login('ms_state');

  try {
    // 1. code -> Microsoft access token (PKCE verifier from the start hop).
    // A non-OK here is an invalid/expired/replayed grant — user-actionable
    // "try again", distinct from a mid-chain outage.
    const tokenRes = (await postForm(TOKEN_URL, {
      client_id: MS_CLIENT_ID,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(c.req.url),
      code_verifier: verifier,
      // A redirect registered under Azure's "Web" platform makes this a
      // confidential client, which must also send its secret.
      ...(process.env.MS_CLIENT_SECRET ? { client_secret: process.env.MS_CLIENT_SECRET } : {}),
    }).catch((err: { data?: { error?: unknown; error_description?: unknown } }) => {
      // Microsoft's error name + description only (they carry no token or code)
      // so a failed exchange says why: e.g. AADSTS7000218 = needs client_secret.
      logger.warn(
        { error: String(err?.data?.error ?? ''), description: String(err?.data?.error_description ?? '').slice(0, 200) },
        'Microsoft token exchange failed',
      );
      return null;
    })) as { access_token?: string } | null;
    if (!tokenRes?.access_token) return login('ms_token_failed');

    // 2. Microsoft token -> Xbox Live token (+ user hash).
    const xbl = (await postJson(XBL_URL, {
      Properties: {
        AuthMethod: 'RPS',
        SiteName: 'user.auth.xboxlive.com',
        RpsTicket: `d=${tokenRes.access_token}`,
      },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
    })) as { Token?: string; DisplayClaims?: { xui?: { uhs?: string }[] } };
    const uhs = xbl.DisplayClaims?.xui?.[0]?.uhs;
    if (!xbl.Token || !uhs) return login('ms_chain_failed');

    // 3. XBL -> XSTS for the Minecraft relying party. XErr codes carry the
    //    user-actionable failures (no Xbox profile, child account, region).
    const xsts = (await postJson(XSTS_URL, {
      Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT',
    }).catch((err: Error & { data?: { XErr?: unknown } }) => {
      const xerr = err.data?.XErr;
      if (typeof xerr === 'number') {
        throw Object.assign(new Error('xsts'), { loginError: xerrToLoginError(xerr) });
      }
      throw err;
    })) as { Token?: string };
    if (!xsts.Token) return login('ms_chain_failed');

    // 4. XSTS -> Minecraft services access token.
    const mcAuth = (await postJson(MC_AUTH_URL, {
      identityToken: `XBL3.0 x=${uhs};${xsts.Token}`,
    })) as { access_token?: string };
    if (!mcAuth.access_token) return login('ms_chain_failed');

    // 5. Profile = the actual account identity. An absent profile means a
    //    Microsoft account that owns no Java edition.
    const profileRes = await fetch(MC_PROFILE_URL, {
      headers: { Authorization: `Bearer ${mcAuth.access_token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (profileRes.status === 404 || profileRes.status === 204) return login('ms_no_profile');
    if (!profileRes.ok) return login('ms_chain_failed');
    const profile = (await profileRes.json().catch(() => null)) as
      | { id?: string; name?: string }
      | null;
    if (!profile?.id || !/^[0-9a-f]{32}$/.test(profile.id) || !profile.name) {
      return login('ms_chain_failed');
    }

    const mcUuid = dashUuid(profile.id);

    // If this Minecraft account is already linked to Discord, the session
    // carries that identity too — the same enrichment webcode login does.
    let discordId: string | null = null;
    try {
      discordId = await getDiscordIdByUuid(mcUuid);
    } catch {
      discordId = null; // a DB hiccup must not block an already-proven login
    }

    const sessionCode = await createSessionCode({
      ...(discordId ? { discordId } : {}),
      discordUsername: null,
      discordAvatar: null,
      mcUuid,
      mcUsername: profile.name,
    });
    return c.redirect(
      `${frontendUrl()}/api/auth/ms/callback?session=${encodeURIComponent(sessionCode)}&state=${encodeURIComponent(state)}`,
      302,
    );
  } catch (err) {
    const loginError = (err as { loginError?: string }).loginError;
    if (loginError) return login(loginError);
    logger.error({ err }, 'Microsoft login chain failed');
    return login('ms_chain_failed');
  }
});
