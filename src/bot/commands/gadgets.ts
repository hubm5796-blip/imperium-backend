/** /gadgets — list the ten fun cosmetic gadgets and how to get them. */
import { SlashCommandBuilder, EmbedBuilder } from '@discordjs/builders';
import { COLORS } from '../config.js';
import type { BotCommand } from './_shared.js';

export const gadgetsCommand: BotCommand = {
  name: 'gadgets',
  toJSON() {
    return new SlashCommandBuilder()
      .setName('gadgets')
      .setDescription('View the ten ImperiumMC cosmetic gadgets')
      .toJSON();
  },
  async execute(interaction) {
    await interaction.deferReply();

    const embed = new EmbedBuilder()
      .setTitle('🎩 ImperiumMC Gadgets')
      .setColor(COLORS.gold)
      .setDescription(
        [
          'Gadgets are purely cosmetic — no pay-to-win, just flex. Equip one from the cosmetic menu (default key **G**, or `/cosmetics`).',
          '',
          'All gadgets are obtainable for free through gameplay; some are also in crates and the store.',
        ].join('\n'),
      )
      .addFields(
        {
          name: '🎆 Fun & Effects',
          value: [
            '🎆 **Firework Launcher** — shoot Roman fireworks. *Obtain: vote 7 days in a row.*',
            '🌈 **Rainbow Trail** — leave a colored trail as you walk. *Obtain: Saturnalia event crate.*',
            '❄️ **Frost Walker Aura** — freeze water behind you (visual only). *Obtain: winter festival.*',
            '💥 **Confetti Bomb** — harmless party explosion on use. *Obtain: reach Rank 25.*',
          ].join('\n'),
          inline: false,
        },
        {
          name: '🚀 Movement & Flair',
          value: [
            '🚀 **Elytra Boost** — cosmetic firework-propelled flight burst. *Obtain: complete Circus Maximus parkour.*',
            '🎈 **Balloon Pet** — a floating balloon follows you. *Obtain: open 50 crates.*',
            '🎩 **Top Hat & Cane** — equip a fancy walk animation. *Obtain: prestige I.*',
            '🐦 **Bat Swarm** — summon a cloud of bats that follow you. *Obtain: Cult of Pluto Devoted.*',
          ].join('\n'),
          inline: false,
        },
        {
          name: '👑 Status',
          value: [
            '👑 **Crown Aura** — golden particles above your head. *Obtain: top 10 on any leaderboard.*',
            '🌟 **Godray Pillar** — a beam of light marks your spot. *Obtain: reach Prestige V.*',
          ].join('\n'),
          inline: false,
        },
      )
      .setFooter({ text: 'imperiummc.net • Forge your empire.' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};
