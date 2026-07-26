/**
 * Shared slash-command plumbing.
 *
 * Each command exports an object implementing {@link BotCommand}. The command
 * router (events.ts) collects these, registers their builders with Discord,
 * and dispatches interactions by name.
 */
import {
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type RESTPostAPIApplicationCommandsJSONBody,
  SlashCommandBuilder,
} from 'discord.js';
import { getBotConfig } from '../config.js';

export interface BotCommand {
  /** Slash command name — must match the builder's name. */
  name: string;
  /** Serialized JSON for registration via the Discord REST API. */
  toJSON(): RESTPostAPIApplicationCommandsJSONBody;
  /** Handle an incoming interaction for this command. */
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
}

/** Re-export the builder so each command file only needs one import line. */
export { SlashCommandBuilder };

/**
 * Grant the configured "linked" role to a member, if set.
 * Failures are non-fatal — we just log and continue.
 */
export async function grantLinkedRole(member: GuildMember): Promise<boolean> {
  const { linkedRoleId } = getBotConfig();
  if (!linkedRoleId) return false;
  try {
    if (!member.roles.resolve(linkedRoleId)) {
      await member.roles.add(linkedRoleId, 'Account linked to ImperiumMC');
    }
    return true;
  } catch {
    // Missing permissions or role — surface nothing to the user.
    return false;
  }
}

/** Remove the configured "linked" role from a member, if set. */
export async function removeLinkedRole(member: GuildMember): Promise<void> {
  const { linkedRoleId } = getBotConfig();
  if (!linkedRoleId) return;
  try {
    if (member.roles.resolve(linkedRoleId)) {
      await member.roles.remove(linkedRoleId, 'Account unlinked');
    }
  } catch {
    // Non-fatal.
  }
}

/** Resolve a guild member for the running user; null in DMs or on failure. */
export async function getAuthorMember(
  interaction: ChatInputCommandInteraction,
): Promise<GuildMember | null> {
  const { member } = interaction;
  if (!interaction.guild) return null;
  if (member && typeof member === 'object' && 'roles' in member) {
    return member as GuildMember;
  }
  // Fallback for cases where the member payload wasn't cached.
  return interaction.guild.members
    .fetch(interaction.user.id)
    .catch(() => null);
}

/** Fetch a guild by id from a client, used to manage roles after links. */
export async function resolveGuild(
  interaction: ChatInputCommandInteraction,
  guildId?: string | null,
): Promise<Guild | null> {
  const target = guildId ?? interaction.guildId;
  if (!target) return null;
  const guild = interaction.client.guilds.cache.get(target);
  if (guild) return guild;
  return interaction.client.guilds.fetch(target).catch(() => null);
}

/** Optional `user` command option value (Snowflake or undefined). */
export function getTargetUserOption(
  interaction: ChatInputCommandInteraction,
): string | undefined {
  return interaction.options.getUser('user', false)?.id ?? undefined;
}
