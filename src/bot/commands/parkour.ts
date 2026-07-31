/** /parkour — show parkour courses, how it works, and best times. */
import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { COLORS } from '../config.js';
import type { BotCommand } from './_shared.js';

export const parkourCommand: BotCommand = {
  name: 'parkour',
  toJSON() {
    return new SlashCommandBuilder()
      .setName('parkour')
      .setDescription('View ImperiumMC parkour courses and the best-time leaderboard')
      .toJSON();
  },
  async execute(interaction) {
    await interaction.deferReply();

    const embed = new EmbedBuilder()
      .setTitle('🏃 ImperiumMC Parkour')
      .setColor(COLORS.gold)
      .setDescription(
        [
          'Race against the clock across Roman-themed parkour courses. Faster times earn bigger rewards — and the top 3 holders of each course get a permanent crown next to their name.',
        ].join('\n'),
      )
      .addFields(
        {
          name: '🏁 Available Courses',
          value: [
            '**Forum Sprint** — easy • 3 checkpoints • beginner-friendly',
            '**Aqueduct Run** — easy/medium • 5 checkpoints • water hazards',
            '**Catacomb Crawl** — medium • 7 checkpoints • tight jumps',
            '**Circus Maximus** — hard • 10 checkpoints • moving platforms',
            '**Mount Olympus Ascent** — very hard • 12 checkpoints • vertical',
            '**Tartarus Escape** — expert • 15 checkpoints • no respawn pads',
          ].join('\n'),
          inline: false,
        },
        {
          name: '📋 How It Works',
          value: [
            '1. Find a parkour portal in the **Forum hub** and step on its pressure plate.',
            '2. A timer starts — pass every checkpoint in order.',
            '3. Reach the finish to bank your time. Beat your PB to improve.',
            '4. Fall off and you respawn at your last checkpoint (time keeps running).',
          ].join('\n'),
          inline: false,
        },
        {
          name: '🏆 Best Times',
          value:
            'The all-time leaderboard lives in-game on the parkour portal for each course. Finish a run to enter the global rankings — rewards scale with your placement and refresh every week.',
          inline: false,
        },
        {
          name: '🎁 Rewards',
          value:
            'Completion grants Denarius + Auctoritas. A new personal best grants bonus Civitas. Top 3 on a course each week earn a crate key.',
          inline: false,
        },
      )
      .setFooter({ text: 'imperiummc.net • Forge your empire.' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};
