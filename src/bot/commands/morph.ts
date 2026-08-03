/** /morph — list the six Roman beast morphs and what they do. */
import { SlashCommandBuilder, EmbedBuilder } from '@discordjs/builders';
import { COLORS } from '../config.js';
import type { BotCommand } from './_shared.js';

export const morphCommand: BotCommand = {
  name: 'morph',
  toJSON() {
    return new SlashCommandBuilder()
      .setName('morph')
      .setDescription('View the six Roman beast morphs and how to unlock them')
      .toJSON();
  },
  async execute(interaction) {
    await interaction.deferReply();

    const embed = new EmbedBuilder()
      .setTitle('🦅 ImperiumMC Beast Morphs')
      .setColor(COLORS.gold)
      .setDescription(
        [
          'Channel the spirit of a Roman beast to gain special abilities. Each morph grants a passive effect plus a unique active skill (press your morph key).',
          '',
          'Unlock a morph by completing its quest line (shown in the in-game `/morph` menu), then activate it with `/morph <beast>`.',
        ].join('\n'),
      )
      .addFields(
        {
          name: '🦅 Aquila (Eagle)',
          value:
            '✅ Unlocked via the *Legionary Trials* quest.\n**Passive:** slow-fall + double-jump. **Active:** Wing Gust — launch forward and knock back foes.',
          inline: false,
        },
        {
          name: '🐺 Lupus (Wolf)',
          value:
            '✅ Unlocked via the *Alpha\'s Hunt* quest.\n**Passive:** +15% movement speed. **Active:** Howl — fear nearby enemies for 3s.',
          inline: false,
        },
        {
          name: '🦁 Leo (Lion)',
          value:
            '✅ Unlocked via the *Colosseum Champion* quest.\n**Passive:** +20% PVP damage. **Active:** Roar of the King — area stun + damage.',
          inline: false,
        },
        {
          name: '🐍 Serpens (Snake)',
          value:
            '✅ Unlocked via the *Oracle\'s Riddle* quest.\n**Passive:** immunity to poison; toxic melee hits. **Active:** Venom Strike — poison cloud.',
          inline: false,
        },
        {
          name: '🐂 Taurus (Bull)',
          value:
            '✅ Unlocked via the *Minotaur\'s Labyrinth* dungeon.\n**Passive:** +30% knockback resistance. **Active:** Charge — sprint dash that breaks blocks.',
          inline: false,
        },
        {
          name: '🐎 Equus (Horse)',
          value:
            '✅ Unlocked via the *Circus Maximus* event.\n**Passive:** rideable sprint; no fall damage on mount. **Active:** Gallop Burst — speed allies around you.',
          inline: false,
        },
      )
      .setFooter({ text: 'imperiummc.net • Forge your empire.' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};
