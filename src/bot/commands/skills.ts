/** /skills — show the three-branch skill tree and how it works. */
import { SlashCommandBuilder, EmbedBuilder } from '@discordjs/builders';
import { COLORS } from '../config.js';
import type { BotCommand } from './_shared.js';

export const skillsCommand: BotCommand = {
  name: 'skills',
  toJSON() {
    return new SlashCommandBuilder()
      .setName('skills')
      .setDescription('View the ImperiumMC skill tree (Virtus, Mercatura, Divinitas)')
      .toJSON();
  },
  async execute(interaction) {
    await interaction.deferReply();

    const embed = new EmbedBuilder()
      .setTitle('📜 ImperiumMC Skill Tree')
      .setColor(COLORS.gold)
      .setDescription(
        [
          'Earn a **skill point** each time you rank up. Spend them in-game with `/skills` across three branches.',
          '',
          'Your personal progress (points to spend and unlocked perks) is shown on the in-game `/skills` panel.',
        ].join('\n'),
      )
      .addFields(
        {
          name: '⚔️ Virtus — The Way of the Warrior',
          value: [
            'Perks for combat, mining, and raw power.',
            '• **Fortitudo** — +10% block-mining damage per rank',
            '• **Impetus** — +5% mining speed per rank',
            '• **Tribunicus** — +8% PVP damage per rank',
            '• **Invictus** — reduces incoming PVP damage',
            '• **Praemium** — +15% Denarius per block',
          ].join('\n'),
          inline: true,
        },
        {
          name: '🪙 Mercatura — The Way of the Merchant',
          value: [
            'Perks for economy, selling, and trade.',
            '• **Avaritia** — +5% sell price per rank',
            '• **Negotium** — better crate luck',
            '• **Civitas Boost** — +10% Civitas generation',
            '• **Mercator** — discount on store bundles',
            '• **Tributum** — passive Auctoritas income',
          ].join('\n'),
          inline: true,
        },
        {
          name: '✨ Divinitas — The Way of the Gods',
          value: [
            'Perks for prestige, magic, and the divine.',
            '• **Maioratus** — permanent prestige bonus',
            '• **Aura** — +5% all-currency income',
            '• **Oraculum** — reveals rare-ore spawns',
            '• **Benedictio** — +10% enchant proc rate',
            '• **Numen** — unlocks mythic perks at Prestige V',
          ].join('\n'),
          inline: false,
        },
        {
          name: '⭐ Skill Points',
          value:
            'You gain **1 skill point per rank**. Unspent points persist across prestige. Check your available points and unlocked perks on the in-game `/skills` panel.',
          inline: false,
        },
      )
      .setFooter({ text: 'imperiummc.net • Forge your empire.' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};
