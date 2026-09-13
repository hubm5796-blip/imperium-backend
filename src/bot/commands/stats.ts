/** /stats — show mining and PVP statistics. */
import { SlashCommandBuilder } from '@discordjs/builders';
import { getProfile } from '../apiClient.js';
import { statsEmbed, errorEmbed, notLinkedEmbed } from '../embeds.js';
import { type BotCommand, getTargetKwargs, addTargetOptions } from './_shared.js';

export const statsCommand: BotCommand = {
  name: 'stats',
  toJSON() {
    return new SlashCommandBuilder()
      .setName('stats')
      .setDescription('View mining, playtime, and PVP statistics')
      .addStringOption((o) => o.setName('player').setDescription('Minecraft username to look up'))
      .toJSON();
  },
  async execute(interaction) {
    const targetKwargs = getTargetKwargs(interaction);

    await interaction.deferReply();
    const result = await getProfile(targetKwargs.discordId ? { discordId: targetKwargs.discordId } : targetKwargs.username ? { username: targetKwargs.username } : {});

    if (!result.ok) {
      const embed = result.status === 404 ? notLinkedEmbed() : errorEmbed(result.message);
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    await interaction.editReply({ embeds: [statsEmbed(result.data)] });
  },
};
