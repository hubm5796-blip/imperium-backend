/** /ip — how to connect, Java + Bedrock, in one reply. V8-01-C. */
import { SlashCommandBuilder, EmbedBuilder } from '@discordjs/builders';
import { COLORS } from '../config.js';
import type { BotCommand } from './_shared.js';
export const ipCommand: BotCommand = {
 name: 'ip',
 toJSON() {
 return new SlashCommandBuilder()
 .setName('ip')
 .setDescription('How to join Romanica - Java and Bedrock connection info')
 .toJSON();
 },
 async execute(interaction) {
 // No defer needed - this replies instantly from static facts.
 const embed = new EmbedBuilder()
 .setTitle('Join Romanica')
 .setColor(COLORS.gold)
 .setDescription('The Rome-themed OP Prison server. Free to play, live now.')
 .addFields(
 {
 name: 'Java Edition',
 value: '```\nplay.imperiummc.net\n```\nAny client version from the last decade works.',
 },
 {
 name: 'Bedrock (phone / console / Windows)',
 value: '```\nplay.imperiummc.net port 19132\n```\nNo Java account needed - cross-play with everyone.',
 },
 {
 name: 'First time?',
 value: 'Type `/guide` in game, follow the warp at the end of the intro, and your first two rank-ups are free. Beginner guide: https://imperiummc.net/blog/how-to-start',
 },
 )
 .setFooter({ text: 'imperiummc.net' });
 await interaction.reply({ embeds: [embed] });
 },
};
