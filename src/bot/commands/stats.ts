/** /stats — show mining and PVP statistics. */
import { SlashCommandBuilder } from '@discordjs/builders';
import { getProfile } from '../apiClient.js';
import { statsEmbed, errorEmbed, notLinkedEmbed } from '../embeds.js';
import { type BotCommand, getTargetUserOption } from './_shared.js';

export const statsCommand: BotCommand = {
  name: 'stats',
  toJSON() {
    return new SlashCommandBuilder()
      .setName('stats')
      .setDescription('View mining, playtime, and PVP statistics')
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

    await interaction.editReply({ embeds: [statsEmbed(result.data)] });
  },
};
