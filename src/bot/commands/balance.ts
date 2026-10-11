/** /balance — show the four currency balances. */
import { SlashCommandBuilder } from '@discordjs/builders';
import { getProfile } from '../apiClient.js';
import { balanceEmbed, errorEmbed, notLinkedEmbed } from '../embeds.js';
import { type BotCommand, getTargetKwargs, addTargetOptions } from './_shared.js';
export const balanceCommand: BotCommand = {
 name: 'balance',
 toJSON() {
 return new SlashCommandBuilder()
 .setName('balance')
 .setDescription('View your Denarius, Auctoritas, Civitas, and Aureus')
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
 await interaction.editReply({ embeds: [balanceEmbed(result.data, { includePremium: self })] });
 },
};
