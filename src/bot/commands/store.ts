/** /store — store / donation link. */
import { SlashCommandBuilder } from 'discord.js';
import { storeEmbed } from '../embeds.js';
import type { BotCommand } from './_shared.js';

export const storeCommand: BotCommand = {
  name: 'store',
  toJSON() {
    return new SlashCommandBuilder()
      .setName('store')
      .setDescription('Get the link to the ImperiumMC store')
      .toJSON();
  },
  async execute(interaction) {
    await interaction.reply({ embeds: [storeEmbed()] });
  },
};
