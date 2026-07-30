/** /crates — list all available crate types. */
import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import type { BotCommand } from './_shared.js';

export const cratesCommand: BotCommand = {
  name: 'crates',
  toJSON() {
    return new SlashCommandBuilder()
      .setName('crates')
      .setDescription('View all available ImperiumMC crate types')
      .toJSON();
  },
  async execute(interaction) {
    await interaction.deferReply();

    const embed = new EmbedBuilder()
      .setTitle('🏺 ImperiumMC Crates')
      .setColor(0xffd700)
      .setDescription('Open crates to win Denarius, Auctoritas, Civitas, pets, cosmetics, and more!')
      .addFields(
        {
          name: '📦 Progression Crates',
          value: [
            '**Basic** — Plebeian\'s Chest (common)',
            '**Uncommon** — Legionary\'s Chest',
            '**Rare** — Centurion\'s Vault',
            '**Epic** — Praetorian\'s Hoard',
            '**Legendary** — Senator\'s Treasury',
            '**Mythic** — Caesar\'s Imperial Chest',
            '**Godly** — Pantheon\'s Blessing',
          ].join('\n'),
          inline: true,
        },
        {
          name: '🏛️ Roman-Themed Crates',
          value: [
            '**Recruit** — Recruit\'s Bounty',
            '**Legionary** — Legionary\'s Spoils',
            '**Centurion** — Centurion\'s Armory',
            '**Praetorian** — Praetorian Vault',
            '**Consul** — Consul\'s Treasury',
            '**Triumph** — Triumphus Maximus',
          ].join('\n'),
          inline: true,
        },
        {
          name: '🎲 Special Crates',
          value: [
            '**Saturnalia** — Festival gift crate',
            '**Bacchanal** — Mystery crate',
            '**Gladiator** — Arena rewards',
            '**Merchant** — Caravan deals',
            '**Oracle** — Prophecy crate',
            '**Vestal** — Flame rewards',
            '**Augur** — Divination crate',
          ].join('\n'),
          inline: false,
        },
      )
      .setFooter({ text: 'Crates are obtained from voting, events, dungeons, and the store.' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};
