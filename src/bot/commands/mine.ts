/**
 * /mine <numeral|name> — the ladder's dig-site lookup: unlock rank, ore table
 * with per-block values, signature ores and live/capped status. Data is a
 * snapshot of the live public_mines.yml (src/bot/data/mines.json) — regenerate
 * it from the live config whenever mines change:
 *   see the generator note at the top of mines.json.
 */
import { SlashCommandBuilder, EmbedBuilder } from '@discordjs/builders';
import { COLORS } from '../config.js';
import minesSnapshot from '../data/mines.json';
import type { BotCommand } from './_shared.js';

interface MineDef {
 id: number;
 numeral: string;
 name: string;
 unlockRank: number;
 autoGenerate?: boolean;
 blocks: { m: string; v: number; s?: string }[];
}

const MINES = (minesSnapshot as { contentCap: number; mines: MineDef[] }).mines ?? [];
const CONTENT_CAP = (minesSnapshot as { contentCap: number }).contentCap ?? 50;

function prettyMaterial(m: string): string {
 return m
 .toLowerCase()
 .split('_')
 .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
 .join(' ');
}

function findMine(query: string): MineDef | undefined {
 const q = query.trim().toLowerCase();
 return (
  MINES.find((m) => m.numeral.toLowerCase() === q) ??
  MINES.find((m) => m.name.toLowerCase() === q) ??
  MINES.find((m) => m.name.toLowerCase().includes(q) && q.length >= 4) ??
  MINES.find((m) => String(m.id) === q)
 );
}

export const mineCommand: BotCommand = {
 name: 'mine',
 toJSON() {
 return new SlashCommandBuilder()
 .setName('mine')
 .setDescription('Look up a mine: unlock rank, ores and their values')
 .addStringOption((o) =>
 o
 .setName('mine')
 .setDescription('Mine numeral (XLVIII), name (Marcus Aurelius) or number (48)')
 .setRequired(true),
 )
 .toJSON();
 },
 async execute(interaction) {
 await interaction.deferReply();
 const query = interaction.options.getString('mine', true);
 const mine = findMine(query);
 if (!mine) {
 const embed = new EmbedBuilder()
 .setTitle('Mine not found')
 .setColor(COLORS.red)
 .setDescription(
 `No mine matches "${query.slice(0, 60)}". Try a numeral like \`XLI\`, a name like \`Augustan Forum\`, or a number 1-${CONTENT_CAP}.`,
 )
 .setFooter({ text: 'imperiummc.net/progression' });
 await interaction.editReply({ embeds: [embed] });
 return;
 }
 const live = mine.id <= CONTENT_CAP && mine.autoGenerate !== false;
 const oreLines = mine.blocks
 .slice()
 .sort((a, b) => b.v - a.v)
 .map((b) => `- ${prettyMaterial(b.m)} - ${b.v.toFixed(2)} denarius per block${b.s ? ` (signature: ${b.s})` : ''}`);
 const embed = new EmbedBuilder()
 .setTitle(`Mine ${mine.numeral} - ${mine.name}`)
 .setColor(live ? COLORS.gold : COLORS.darkGray)
 .setDescription(
 `Rank ${mine.unlockRank} to enter. ${live ? 'Live now.' : 'Beyond the current content cap - opening in a future release.'}`,
 )
 .addFields(
 {
 name: 'Ore table (richest first)',
 value: oreLines.join('\n').slice(0, 1024),
 },
 {
 name: 'See it yourself',
 value: `In game: \`/mine\` menu or warp to Mine ${mine.numeral}. Ladder overview: https://imperiummc.net/progression`,
 },
 )
 .setFooter({ text: `Mine ${mine.id} of the ladder - imperiummc.net` });
 await interaction.editReply({ embeds: [embed] });
 },
};
