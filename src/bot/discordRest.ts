// Thin wrapper over Discord's REST API (v10). Used for everything that isn't
// an interaction-response call (role management, guild member lookups) —
// those need `Authorization: Bot <token>`. Interaction-response endpoints
// (deferReply/reply/editReply) are authenticated purely by the interaction's
// own id+token and are called directly from interactionShim.ts instead.
const API_BASE = 'https://discord.com/api/v10';

export async function discordApiFetch(
  path: string,
  botToken: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bot ${botToken}`,
      ...(init.headers ?? {}),
    },
  });
}

export interface DiscordMember {
  user: { id: string; username: string; bot?: boolean };
  roles: string[];
}

/** GET /guilds/{guild}/members/{user}. Returns null if the member isn't found. */
export async function fetchGuildMember(
  guildId: string,
  userId: string,
  botToken: string,
): Promise<DiscordMember | null> {
  const res = await discordApiFetch(`/guilds/${guildId}/members/${userId}`, botToken);
  if (!res.ok) return null;
  return (await res.json()) as DiscordMember;
}

/** PUT /guilds/{guild}/members/{user}/roles/{role} — idempotent, no error if already held. */
export async function addGuildMemberRole(
  guildId: string,
  userId: string,
  roleId: string,
  botToken: string,
): Promise<boolean> {
  const res = await discordApiFetch(`/guilds/${guildId}/members/${userId}/roles/${roleId}`, botToken, {
    method: 'PUT',
  });
  return res.ok;
}

/** DELETE /guilds/{guild}/members/{user}/roles/{role} — idempotent, no error if not held. */
export async function removeGuildMemberRole(
  guildId: string,
  userId: string,
  roleId: string,
  botToken: string,
): Promise<boolean> {
  const res = await discordApiFetch(`/guilds/${guildId}/members/${userId}/roles/${roleId}`, botToken, {
    method: 'DELETE',
  });
  return res.ok;
}
