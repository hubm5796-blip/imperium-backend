/** /online — live server status. */
import { SlashCommandBuilder } from 'discord.js';
import { getServerStatus } from '../apiClient.js';
import { serverStatusEmbed, errorEmbed } from '../embeds.js';
import type { BotCommand } from './_shared.js';

export const onlineCommand: BotCommand = {
  name: 'online',
  toJSON() {
    return new SlashCommandBuilder()
      .setName('online')
      .setDescription('Check the live ImperiumMC server status')
      .toJSON();
  },
  async execute(interaction) {
    await interaction.deferReply();
    const result = await getServerStatus();
    if (!result.ok) {
      await interaction.editReply({
        embeds: [errorEmbed(result.message, 'Status unavailable')],
      });
      return;
    }
    await interaction.editReply({ embeds: [serverStatusEmbed(result.data)] });
  },
};
