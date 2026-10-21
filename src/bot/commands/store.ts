/** /store — store / donation link. */
import { SlashCommandBuilder } from '@discordjs/builders';
import { storeEmbed } from '../embeds.js';
import type { BotCommand } from './_shared.js';
export const storeCommand: BotCommand = {
 name: 'store',
 toJSON() {
 return new SlashCommandBuilder()
 .setName('store')
 .setDescription('Get the link to the Romanica store')
 .toJSON();
 },
 async execute(interaction) {
 await interaction.reply({ embeds: [storeEmbed()] });
 },
};
