/**
 * /vote — where to vote and why it pays. Static links + the reward loop in
 * one reply (the vote page on the site carries the live vote-party tracker).
 */
import { SlashCommandBuilder, EmbedBuilder } from '@discordjs/builders';
import { COLORS } from '../config.js';
import type { BotCommand } from './_shared.js';

export const voteCommand: BotCommand = {
 name: 'vote',
 toJSON() {
 return new SlashCommandBuilder()
 .setName('vote')
 .setDescription('Support the server and claim vote rewards - keys, denarius and vote parties')
 .toJSON();
 },
 async execute(interaction) {
 const embed = new EmbedBuilder()
 .setTitle('Vote for Imperium MC')
 .setColor(COLORS.gold)
 .setDescription(
 'Voting keeps the server visible on the lists, and every vote pays you directly - plus fills the server-wide vote party bar.',
 )
 .addFields(
 {
 name: 'Vote pages',
 value: 'https://imperiummc.net/vote - all list links in one place, with your claim status',
 },
 {
 name: 'What you get',
 value: '- Vote keys and denarius for every vote\n- Contribution to the vote party - the whole server gets rewards when the bar fills\n- Streak rewards for voting daily',
 },
 {
 name: 'Claiming',
 value: 'Rewards arrive in game automatically after each vote. If one ever goes missing, `/vote` in game shows your pending claims.',
 },
 )
 .setFooter({ text: 'imperiummc.net' });
 await interaction.reply({ embeds: [embed] });
 },
};
