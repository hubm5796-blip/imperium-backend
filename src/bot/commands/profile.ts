/** /profile [user] — show a player's profile card. */
import { SlashCommandBuilder } from '@discordjs/builders';
import { getProfile } from '../apiClient.js';
import { profileEmbed, errorEmbed, notLinkedEmbed } from '../embeds.js';
import { type BotCommand, getTargetKwargs, addTargetOptions } from './_shared.js';

export const profileCommand: BotCommand = {
  name: 'profile',
  toJSON() {
    return new SlashCommandBuilder()
      .setName('profile')
      .setDescription('View a player profile card (rank, prestige, balances, stats)')
      .addStringOption((o) => o.setName('player').setDescription('Minecraft username to look up'))
      .toJSON();
  },
  async execute(interaction) {
    const targetKwargs = getTargetKwargs(interaction);
    const self = Object.keys(targetKwargs).length === 0 || targetKwargs.discordId === interaction.user.id;

    await interaction.deferReply();
    const result = await getProfile(targetKwargs.discordId ? { discordId: targetKwargs.discordId } : targetKwargs.username ? { username: targetKwargs.username } : {});

    if (!result.ok) {
      const embed = result.status === 404 ? notLinkedEmbed() : errorEmbed(result.message);
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    await interaction.editReply({ embeds: [profileEmbed(result.data, { includePremium: self })] });
  },
};
