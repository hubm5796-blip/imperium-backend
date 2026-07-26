/** /unlink — remove the Discord↔Minecraft link. */
import { SlashCommandBuilder } from 'discord.js';
import { unlinkAccount } from '../apiClient.js';
import { EMOJI } from '../config.js';
import { successEmbed, errorEmbed } from '../embeds.js';
import {
  type BotCommand,
  removeLinkedRole,
  resolveGuild,
} from './_shared.js';

export const unlinkCommand: BotCommand = {
  name: 'unlink',
  toJSON() {
    return new SlashCommandBuilder()
      .setName('unlink')
      .setDescription('Unlink your Discord account from your Minecraft account')
      .toJSON();
  },
  async execute(interaction) {
    const discordId = interaction.user.id;

    await interaction.deferReply({ ephemeral: true });

    const result = await unlinkAccount(discordId);
    if (!result.ok) {
      if (result.status === 404) {
        await interaction.editReply({
          embeds: [errorEmbed('Your Discord account is not currently linked.', 'Nothing to unlink')],
        });
        return;
      }
      await interaction.editReply({ embeds: [errorEmbed(result.message, 'Unlink failed')] });
      return;
    }

    // Best-effort: strip the linked role across all shared guilds.
    for (const guild of interaction.client.guilds.cache.values()) {
      const g = await resolveGuild(interaction, guild.id);
      const member = g && (await g.members.fetch(discordId).catch(() => null));
      if (member) await removeLinkedRole(member);
    }

    await interaction.editReply({
      embeds: [
        successEmbed(
          'Your Discord account has been unlinked. You can re-link anytime with `/link <code>`.',
          `${EMOJI.eagle} Unlinked`,
        ),
      ],
    });
  },
};
