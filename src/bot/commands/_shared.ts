/**
 * Shared slash-command plumbing.
 *
 * Each command exports an object implementing {@link BotCommand}. The
 * interactions route (src/bot/interactions.ts) collects these, registers
 * their builders with Discord (via registerCommands.ts), and dispatches
 * incoming interactions by name — using InteractionShim instead of a live
 * discord.js gateway Client (see interactionShim.ts for why).
 */
import { SlashCommandBuilder } from '@discordjs/builders';
import type { RESTPostAPIApplicationCommandsJSONBody } from 'discord-api-types/v10';
import { addGuildMemberRole, removeGuildMemberRole, type DiscordMember } from '../discordRest.js';
import { getBotConfig } from '../config.js';
import type { InteractionShim } from '../interactionShim.js';

export interface BotCommand {
  /** Slash command name — must match the builder's name. */
  name: string;
  /** Serialized JSON for registration via the Discord REST API. */
  toJSON(): RESTPostAPIApplicationCommandsJSONBody;
  /** Handle an incoming interaction for this command. */
  execute(interaction: InteractionShim): Promise<void>;
}

/** Re-export the builder so each command file only needs one import line. */
export { SlashCommandBuilder };

/**
 * Grant the configured "linked" role to a member, if set.
 * Failures are non-fatal — we just log and continue.
 */
export async function grantLinkedRole(interaction: InteractionShim): Promise<boolean> {
  const { linkedRoleId, token } = getBotConfig();
  if (!linkedRoleId || !interaction.guildId || !token) return false;
  try {
    const member = await interaction.guild?.members.fetch(interaction.user.id);
    if (member?.roles.includes(linkedRoleId)) return true;
    return await addGuildMemberRole(interaction.guildId, interaction.user.id, linkedRoleId, token);
  } catch (err) {
    // Missing permissions or role — surface nothing to the user, but leave
    // an operator trace: role sync can otherwise be broken for weeks.
    console.error(`[bot] linked-role grant failed for ${interaction.user.id}:`, err);
    return false;
  }
}

/** Remove the configured "linked" role from a member, if set. */
export async function removeLinkedRole(interaction: InteractionShim): Promise<void> {
  const { linkedRoleId, token } = getBotConfig();
  if (!linkedRoleId || !interaction.guildId || !token) return;
  try {
    await removeGuildMemberRole(interaction.guildId, interaction.user.id, linkedRoleId, token);
  } catch (err) {
    console.error(`[bot] linked-role remove failed for ${interaction.user.id}:`, err);
  }
}

/** Fetch the calling user's member record in the interaction's guild, if any. */
export async function getAuthorMember(interaction: InteractionShim): Promise<DiscordMember | null> {
  if (!interaction.guild) return null;
  return interaction.guild.members.fetch(interaction.user.id);
}

/** Optional `user` command option value (Snowflake or undefined). */
export function getTargetUserOption(interaction: InteractionShim): string | undefined {
  return interaction.options.getUser('user', false)?.id ?? undefined;
}
