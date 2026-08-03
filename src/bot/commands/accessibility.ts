/** /accessibility — show accessibility features and how to toggle them in-game. */
import { SlashCommandBuilder, EmbedBuilder } from '@discordjs/builders';
import { COLORS } from '../config.js';
import type { BotCommand } from './_shared.js';

export const accessibilityCommand: BotCommand = {
  name: 'accessibility',
  toJSON() {
    return new SlashCommandBuilder()
      .setName('accessibility')
      .setDescription('View ImperiumMC accessibility features and how to toggle them')
      .toJSON();
  },
  async execute(interaction) {
    await interaction.deferReply();

    const embed = new EmbedBuilder()
      .setTitle('♿ ImperiumMC Accessibility')
      .setColor(COLORS.green)
      .setDescription(
        [
          'ImperiumMC ships with built-in accessibility options to make the empire playable for everyone. Toggle any of them in-game with `/accessibility`.',
        ].join('\n'),
      )
      .addFields(
        {
          name: '🎨 Colorblind Mode',
          value:
            'Adjusts ore, currency, and crate colors to stay distinguishable for protanopia, deuteranopia, and tritanopia.\n**Toggle in-game:** `/accessibility colorblind <off|protan|deuteran|tritan>`',
          inline: false,
        },
        {
          name: '🌀 Reduced Motion',
          value:
            'Removes screen shake, fast particle bursts, and strobing animations. Keeps essential feedback (damage, level-up) but tones it down.\n**Toggle in-game:** `/accessibility motion <on|off>`',
          inline: false,
        },
        {
          name: '🔠 Large Chat',
          value:
            'Increases chat text size and line spacing, and raises the message history limit so less scrolling is needed.\n**Toggle in-game:** `/accessibility largechat <on|off>`',
          inline: false,
        },
        {
          name: '🔔 Extra Options',
          value: [
            '**Subtitles** — captions for in-game sounds: `/accessibility subtitles <on|off>`',
            '**Clear Text** — high-contrast chat background: `/accessibility cleartext <on|off>`',
            '**Slow Mode** — lengthens command cooldowns for comfort: `/accessibility slow <on|off>`',
          ].join('\n'),
          inline: false,
        },
        {
          name: '💾 Persistence',
          value:
            'Your accessibility settings are saved to your account and apply on every device and server you join.',
          inline: false,
        },
      )
      .setFooter({ text: 'imperiummc.net • Forge your empire.' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};
