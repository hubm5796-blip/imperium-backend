/**
 * /changelog — the latest updates, straight from the backend's durable
 * changelog record (db/changelogStore.ts — the same store the
 * /api/v2/changelog/list route reads; in-process import, no HTTP hop).
 * Shows the five most recent posts with their lead lines, and links the
 * per-update pages on the site.
 */
import { SlashCommandBuilder, EmbedBuilder } from '@discordjs/builders';
import { COLORS } from '../config.js';
import { listChangelogPosts } from '../../db/changelogStore.js';
import type { BotCommand } from './_shared.js';

function formatDate(ts: number): string {
 return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export const changelogCommand: BotCommand = {
 name: 'changelog',
 toJSON() {
 return new SlashCommandBuilder()
 .setName('changelog')
 .setDescription('The latest ImperiumMC updates - fixes, improvements and announcements')
 .toJSON();
 },
 async execute(interaction) {
 await interaction.deferReply();
 const posts = await listChangelogPosts(5);
 if (posts.length === 0) {
 const embed = new EmbedBuilder()
 .setTitle('No updates recorded yet')
 .setColor(COLORS.darkGray)
 .setDescription('Every update is documented at https://imperiummc.net/changelog')
 .setFooter({ text: 'imperiummc.net' });
 await interaction.editReply({ embeds: [embed] });
 return;
 }
 const lines = posts.map((p) => `**${formatDate(p.ts)}** - ${p.title}${p.lead ? `\n${p.lead}` : ''}`);
 const embed = new EmbedBuilder()
 .setTitle('Latest updates')
 .setColor(COLORS.gold)
 .setDescription(lines.join('\n\n').slice(0, 4000))
 .addFields({
 name: 'Full history',
 value: 'Every update with its full key changes: https://imperiummc.net/changelog',
 })
 .setFooter({ text: 'imperiummc.net' });
 await interaction.editReply({ embeds: [embed] });
 },
};
