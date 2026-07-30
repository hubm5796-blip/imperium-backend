/** /pets — list all available pet types. */
import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import type { BotCommand } from './_shared.js';

export const petsCommand: BotCommand = {
  name: 'pets',
  toJSON() {
    return new SlashCommandBuilder()
      .setName('pets')
      .setDescription('View all available ImperiumMC pets')
      .toJSON();
  },
  async execute(interaction) {
    await interaction.deferReply();

    const embed = new EmbedBuilder()
      .setTitle('🐾 ImperiumMC Pets')
      .setColor(0x55ff55)
      .setDescription('Unlock pets by completing enchant categories, opening crates, and defeating bosses. Each pet provides unique mining bonuses!')
      .addFields(
        {
          name: '🍀 Common & Uncommon',
          value: [
            '🐰 **Lucky Rabbit** — +2% money per block',
            '🤖 **Automaton Drone** — passive Auctoritas generation',
            '🐺 **Shadow Wolf** — +8% money per block',
            '🐢 **Naiad Turtle** — Civitas every 30 blocks',
          ].join('\n'),
          inline: true,
        },
        {
          name: '💎 Rare & Epic',
          value: [
            '🦅 **Legionary Eagle** — +3% money, +2% Auctoritas',
            '🐉 **Combo Dragon** — stacking combo bonus',
            '🐒 **Chaos Monkey** — random 2-5× bursts',
            '🦊 **Forge Salamander** — +6% money, fire immunity',
            '🦌 **Dryad Deer** — +5% sell price',
          ].join('\n'),
          inline: true,
        },
        {
          name: '⚡ Legendary & Mythic',
          value: [
            '🔥 **Phoenix** — +15% all income after 10 min mining',
            '🦉 **Sibyl\'s Owl** — +8% enchant proc rate',
            '🐍 **Oracle Serpent** — +20% crate luck',
            '🐕 **Cerberus** — +5% to ALL currencies',
            '🦁 **Imperial Lion** — +12% money in PvP',
            '🦄 **Imperial Pegasus** — +15% mining speed',
            '🗿 **Colossus Golem** — +8% money, -10% damage',
            '👻 **Endgame Spirit** — +5% all currency',
          ].join('\n'),
          inline: false,
        },
      )
      .setFooter({ text: 'Pets level up as you mine — higher levels = bigger bonuses!' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};
