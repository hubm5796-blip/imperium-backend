/** /dungeons — list all available dungeons. */
import { SlashCommandBuilder, EmbedBuilder } from '@discordjs/builders';
import type { BotCommand } from './_shared.js';

export const dungeonsCommand: BotCommand = {
  name: 'dungeons',
  toJSON() {
    return new SlashCommandBuilder()
      .setName('dungeons')
      .setDescription('View all ImperiumMC dungeons and their requirements')
      .toJSON();
  },
  async execute(interaction) {
    await interaction.deferReply();

    const embed = new EmbedBuilder()
      .setTitle('⚔️ ImperiumMC Dungeons')
      .setColor(0xff4444)
      .setDescription('Challenge dungeons solo or with up to 4 party members. Defeat bosses for massive rewards!')
      .addFields(
        {
          name: '🟢 Entry Dungeons (Rank 5-10)',
          value: [
            '**Cloaca Maxima** — Rank 5+ • Boss: Sewer Rat King (500 HP)',
            '**Catacombs Praetexta** — Rank 10+ • Boss: The Bone Collector (1,000 HP)',
          ].join('\n'),
          inline: false,
        },
        {
          name: '🟡 Mid Dungeons (Rank 20-25)',
          value: [
            '**Ludus Gladiatorius** — Rank 20+ • Boss: Champion Spartacus (2,500 HP)',
            '**Forum Atrium** — Rank 25+ • Boss: Corrupted Senator (4,000 HP)',
          ].join('\n'),
          inline: false,
        },
        {
          name: '🟠 Advanced (Rank 35-40)',
          value: [
            '**Templum Jovis** — Rank 35+ • Boss: Jupiter (8,000 HP)',
            '**Circus Maximus** — Rank 40+ • Boss: The Phantom Auriga (12,000 HP)',
          ].join('\n'),
          inline: false,
        },
        {
          name: '🔴 Epic (Rank 50-55)',
          value: [
            "**Hades' Realm** — Rank 50+ • Boss: Hades (20,000 HP)",
            '**Mount Olympus** — Rank 55+ • Boss: Zeus (30,000 HP)',
          ].join('\n'),
          inline: false,
        },
        {
          name: '🟣 Mythic & Endgame (Rank 65-90)',
          value: [
            '**The Labyrinth** — Rank 65+ • Boss: The Minotaur (50,000 HP)',
            '**Colosseum Infernale** — Rank 70+ • Boss: Eternal Champion (75,000 HP)',
            '**Tartarus Depths** — Rank 80+ • Boss: Cronus (100,000 HP)',
            '**Pantheon Eternal** — Rank 90+ • Boss: The Twelve Olympians (200,000 HP)',
          ].join('\n'),
          inline: false,
        },
      )
      .setFooter({ text: 'Dungeon rewards scale massively — from 50K Denarius to 500M+!' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};
