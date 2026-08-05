import { env } from '../env.js';
import type { DiscordUser } from '../types/index.js';

/** Discord OAuth2 endpoints. */
const AUTHORIZE_URL = 'https://discord.com/api/oauth2/authorize';
const TOKEN_URL = 'https://discord.com/api/oauth2/token';
const ME_URL = 'https://discord.com/api/users/@me';

/** Scopes requested during OAuth2. */
const SCOPES = ['identify'].join(' ');

/** Build the URL the browser is redirected to in order to start OAuth2. */
export function buildAuthorizeUrl(state?: string): string {
  // No `prompt` param — omitting it (rather than 'consent') lets Discord skip
  // the authorize screen on repeat logins for a user who already granted
  // these scopes, same as any standard "Continue with Discord" button.
  // Discord still always re-shows it after a scope change or if the user
  // revoked access from their own Discord settings.
  const params = new URLSearchParams({
    client_id: env.discord.clientId,
    redirect_uri: env.discord.redirectUri,
    response_type: 'code',
    scope: SCOPES,
  });
  if (state) params.set('state', state);
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

/** Token response from Discord's /oauth2/token endpoint. */
export interface DiscordTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/**
 * Exchange an authorization code for an access token. The redirect_uri MUST
 * match the one used to build the authorize URL.
 */
export async function exchangeCodeForToken(code: string): Promise<DiscordTokenResponse> {
  const body = new URLSearchParams({
    client_id: env.discord.clientId,
    client_secret: env.discord.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: env.discord.redirectUri,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord token exchange failed (${res.status}): ${text}`);
  }

  return (await res.json()) as DiscordTokenResponse;
}

/** Fetch the authenticated user's Discord profile using an access token. */
export async function fetchDiscordUser(accessToken: string): Promise<DiscordUser> {
  const res = await fetch(ME_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord /users/@me failed (${res.status}): ${text}`);
  }

  const raw = (await res.json()) as DiscordUser;
  return {
    id: raw.id,
    username: raw.username,
    global_name: raw.global_name ?? null,
    avatar: raw.avatar ?? null,
    discriminator: raw.discriminator ?? '0',
  };
}

/** Build a CDN URL for a user's avatar, falling back to a default avatar. */
export function buildAvatarUrl(user: Pick<DiscordUser, 'id' | 'avatar' | 'discriminator'>): string {
  if (user.avatar) {
    const ext = user.avatar.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}`;
  }
  const index = Number(user.discriminator) % 5;
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}
