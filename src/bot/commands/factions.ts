/** /factions — list the eight factions, rep tiers, and perks. */
import { SlashCommandBuilder, EmbedBuilder } from '@discordjs/builders';
import { COLORS } from '../config.js';
import type { BotCommand } from './_shared.js';

export const factionsCommand: BotCommand = {
  name: 'factions',
  toJSON() {
    return new SlashCommandBuilder()
      .setName('factions')
      .setDescription('View the eight ImperiumMC factions and reputation perks')
      .toJSON();
  },
  async execute(interaction) {
    await interaction.deferReply();

    const embed = new EmbedBuilder()
      .setTitle('🏛 ImperiumMC Factions')
      .setColor(COLORS.gold)
      .setDescription(
        [
          'Eight factions vie for control of the empire. Earn reputation by completing quests, bounties, and events for a faction — climbing its rep tiers unlocks exclusive perks.',
          '',
          'Your current reputation tier with each faction is shown on the in-game `/factions` panel.',
        ].join('\n'),
      )
      .addFields(
        {
          name: 'The Eight Factions',
          value: [
            '⚔️ **Legio XIII** — the military elite. War, combat, PVP.',
            '🪙 **Mercatores** — the merchant guild. Trade, economy, crates.',
            '📜 **Senatus** — the ruling senate. Politics, prestige, civics.',
            '🏛 **Plebs Urbana** — the common citizens. Mining, community.',
            '⚗️ **Alchemica** — the alchemist order. Enchants, potions, forges.',
            '⚡ **Cult of Jupiter** — the sky god. Storms, rare ores, divinity.',
            '🌹 **Cult of Venus** — the love goddess. Cosmetics, pets, glamour.',
            '🌑 **Cult of Pluto** — the underworld. Death, souls, the dark.',
          ].join('\n'),
          inline: false,
        },
        {
          name: '📈 Reputation Tiers',
          value: [
            '**1.** Stranger (0) — no perks',
            '**2.** Acquainted (500) — basic discount',
            '**3.** Ally (2,000) — unlock faction shop',
            '**4.** Devoted (5,000) — passive faction buff',
            '**5.** Champion (12,000) — exclusive cosmetic',
            '**6.** Exalted (25,000) — faction mount + title',
          ].join('\n'),
          inline: false,
        },
        {
          name: '🎁 Perk Highlights',
          value: [
            '• **Legio XIII** Ally: +10% PVP damage',
            '• **Mercatores** Devoted: +10% sell price',
            '• **Cult of Jupiter** Champion: lightning-ore radar',
            '• **Cult of Pluto** Exalted: respawn with full HP',
            'Check `/factions` in-game for your full unlocked-perk list.',
          ].join('\n'),
          inline: false,
        },
      )
      .setFooter({ text: 'imperiummc.net • Forge your empire.' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};
