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
  if (!res.ok) {
    if (res.status === 403 || res.status === 401) {
      // Bot kicked/missing perms — without this log it's indistinguishable
      // from "member left" and every dependent feature just degrades.
      console.error(`[discordRest] member fetch ${res.status} for guild ${guildId} — bot credentials/permissions broken?`);
    }
    return null;
  }
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

/** POST /channels/{id}/messages — a notification-channel send (V6 02-05).
 *  `allowedMentionRoles` limits pings to exactly the roles named in the
 *  content — without it a stray @everyone in copy would wall-paper the guild. */
export async function sendChannelMessage(
  channelId: string,
  botToken: string,
  message: { content: string; allowedMentionRoles?: string[] },
): Promise<boolean> {
  const res = await discordApiFetch(`/channels/${channelId}/messages`, botToken, {
    method: 'POST',
    body: JSON.stringify({
      content: message.content,
      allowed_mentions: message.allowedMentionRoles
        ? { roles: message.allowedMentionRoles }
        : { parse: [] },
    }),
  });
  return res.ok;
}

/** POST /users/@me/channels then POST to its messages — a DM send (V6 02-05).
 *  Returns false when either step fails (blocked DMs 403 — the sweep logs it
 *  per-user and continues). */
export async function sendDirectMessage(
  botToken: string,
  userId: string,
  message: { content: string },
): Promise<boolean> {
  const channel = await discordApiFetch('/users/@me/channels', botToken, {
    method: 'POST',
    body: JSON.stringify({ recipient_id: userId }),
  });
  if (!channel.ok) return false;
  const channelId = ((await channel.json()) as { id?: string }).id;
  if (!channelId) return false;
  const res = await discordApiFetch(`/channels/${channelId}/messages`, botToken, {
    method: 'POST',
    body: JSON.stringify({ content: message.content, allowed_mentions: { parse: [] } }),
  });
  return res.ok;
}

// ── V6 02-06: ticket thread management ─────────────────────────────────────

export interface DiscordThread {
  id: string;
  name: string;
}

/** POST /channels/{parent}/threads — a private ticket thread under the configured category. */
export async function createPrivateThread(
  parentChannelId: string,
  name: string,
  botToken: string,
): Promise<DiscordThread | null> {
  const res = await discordApiFetch(`/channels/${parentChannelId}/threads`, botToken, {
    method: 'POST',
    body: JSON.stringify({ name: name.slice(0, 100), type: 12, auto_archive_duration: 1440 }), // 12 = private thread
  });
  if (!res.ok) return null;
  const t = (await res.json()) as DiscordThread;
  return t?.id ? t : null;
}

/** PUT /channels/{thread}/thread-members/{user} — add the opener so they can see it. */
export async function addThreadMember(threadId: string, userId: string, botToken: string): Promise<boolean> {
  const res = await discordApiFetch(`/channels/${threadId}/thread-members/${userId}`, botToken, { method: 'PUT' });
  return res.ok || res.status === 204;
}

/** POST /channels/{thread}/messages inside the thread (reuse of the channel send shape). */
export async function sendThreadMessage(
  threadId: string,
  botToken: string,
  message: { content: string },
): Promise<boolean> {
  const res = await discordApiFetch(`/channels/${threadId}/messages`, botToken, {
    method: 'POST',
    body: JSON.stringify({ content: message.content, allowed_mentions: { parse: [] } }),
  });
  return res.ok;
}

/** PATCH /channels/{thread} — archive (or unarchive) a thread. */
export async function setThreadArchived(threadId: string, archived: boolean, botToken: string): Promise<boolean> {
  const res = await discordApiFetch(`/channels/${threadId}`, botToken, {
    method: 'PATCH',
    body: JSON.stringify({ archived, locked: archived }),
  });
  return res.ok;
}
