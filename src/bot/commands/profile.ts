/** /profile [user] — show a player's profile card. */
import { SlashCommandBuilder } from 'discord.js';
import { getProfile } from '../apiClient.js';
import { profileEmbed, errorEmbed, notLinkedEmbed } from '../embeds.js';
import { type BotCommand, getTargetUserOption } from './_shared.js';

export const profileCommand: BotCommand = {
  name: 'profile',
  toJSON() {
    return new SlashCommandBuilder()
      .setName('profile')
      .setDescription('View a player profile card (rank, prestige, balances, stats)')
      .addUserOption((o) =>
        o.setName('user').setDescription('A Discord user (defaults to you)'),
      )
      .toJSON();
  },
  async execute(interaction) {
    const targetId = getTargetUserOption(interaction) ?? interaction.user.id;

    await interaction.deferReply();
    const result = await getProfile({ discordId: targetId });

    if (!result.ok) {
      const embed = result.status === 404 ? notLinkedEmbed() : errorEmbed(result.message);
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    await interaction.editReply({ embeds: [profileEmbed(result.data)] });
  },
};
