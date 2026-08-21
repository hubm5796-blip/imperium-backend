/** /mytickets (V6 02-06): a linked player's own tickets table. */
import { SlashCommandBuilder } from '@discordjs/builders';
import { EmbedBuilder } from '@discordjs/builders';
import { getProfile, listTicketsV2 } from '../apiClient.js';
import { errorEmbed } from '../embeds.js';
import { COLORS } from '../config.js';
import { type BotCommand } from './_shared.js';

export const myTicketsCommand: BotCommand = {
  name: 'mytickets',
  toJSON() {
    return new SlashCommandBuilder()
      .setName('mytickets')
      .setDescription('Your support tickets')
      .toJSON();
  },
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const profile = await getProfile({ discordId: interaction.user.id });
    if (!profile.ok) {
      await interaction.editReply({
        embeds: [errorEmbed('Run `/link` first — tickets are tied to your Minecraft account.', 'Not linked')],
      });
      return;
    }
    const rows = await listTicketsV2();
    if (!rows.ok) {
      await interaction.editReply({ embeds: [errorEmbed(rows.message)] });
      return;
    }
    const mine = rows.data.tickets.filter((t) => t.uuid.toLowerCase() === profile.data.uuid.toLowerCase());
    const embed = new EmbedBuilder()
      .setTitle('Your tickets')
      .setColor(COLORS.gold)
      .setFooter({ text: 'imperiummc.net • Forge your empire.' })
      .setTimestamp();
    if (mine.length === 0) {
      embed.setDescription('No tickets yet. Open one with `/ticket open`.');
    } else {
      embed.setDescription(
        mine
          .slice(0, 10)
          .map((t) => `**#${t.id}** [${t.status}] ${t.subject} — ${t.category}`)
          .join('\n'),
      );
    }
    await interaction.editReply({ embeds: [embed] });
  },
};
