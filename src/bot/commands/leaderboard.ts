/** /leaderboard <type> — top 10 players, paginated 10 per page. */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
  ComponentType,
  SlashCommandBuilder,
} from 'discord.js';
import { getLeaderboard } from '../apiClient.js';
import { leaderboardEmbed, errorEmbed } from '../embeds.js';
import type { BotCommand } from './_shared.js';

const TYPES = ['denarius', 'blocks', 'prestige', 'playtime'] as const;
type LeaderboardType = (typeof TYPES)[number];

const PREV_ID = 'lb_prev';
const NEXT_ID = 'lb_next';

function row(page: number, hasNext: boolean): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(PREV_ID)
      .setLabel('◀ Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId(NEXT_ID)
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasNext),
  );
}

export const leaderboardCommand: BotCommand = {
  name: 'leaderboard',
  toJSON() {
    return new SlashCommandBuilder()
      .setName('leaderboard')
      .setDescription('View the top players')
      .addStringOption((o) =>
        o
          .setName('type')
          .setDescription('Which leaderboard to show')
          .setRequired(true)
          .addChoices(
            { name: 'Denarius (wealth)', value: 'denarius' },
            { name: 'Blocks mined', value: 'blocks' },
            { name: 'Prestige', value: 'prestige' },
            { name: 'Playtime', value: 'playtime' },
          ),
      )
      .toJSON();
  },
  async execute(interaction: ChatInputCommandInteraction) {
    const type = interaction.options.getString('type', true) as LeaderboardType;
    if (!TYPES.includes(type)) {
      await interaction.reply({
        embeds: [errorEmbed('Unknown leaderboard type.')],
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply();

    const PAGE_SIZE = 10;
    let page = 0;

    const loadPage = async (p: number) => {
      const result = await getLeaderboard(type, PAGE_SIZE);
      if (!result.ok) return result;
      // Slice client-side for pagination; backend returns up to PAGE_SIZE.
      const start = p * PAGE_SIZE;
      return {
        ok: true as const,
        data: { ...result.data, entries: result.data.entries.slice(start, start + PAGE_SIZE) },
      };
    };

    const initial = await loadPage(page);
    if (!initial.ok) {
      await interaction.editReply({ embeds: [errorEmbed(initial.message, 'Leaderboard unavailable')] });
      return;
    }
    if (initial.data.entries.length === 0) {
      await interaction.editReply({
        embeds: [errorEmbed('No entries on this leaderboard yet.', 'Leaderboard empty')],
      });
      return;
    }

    const message = await interaction.editReply({
      embeds: [leaderboardEmbed(initial.data)],
      components: [row(page, initial.data.entries.length === PAGE_SIZE)],
    });

    // Listen for button presses for 60 seconds.
    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 60_000,
    });

    collector.on('collect', async (btn) => {
      if (btn.user.id !== interaction.user.id) {
        await btn.reply({ ephemeral: true, content: "This isn't your leaderboard." });
        return;
      }
      if (btn.customId === PREV_ID && page > 0) page -= 1;
      else if (btn.customId === NEXT_ID) page += 1;

      const next = await loadPage(page);
      await btn.deferUpdate();
      if (!next.ok || next.data.entries.length === 0) {
        // Went past the end — step back and stop paginating.
        page = Math.max(0, page - 1);
        collector.stop('end');
        return;
      }
      await interaction.editReply({
        embeds: [leaderboardEmbed(next.data)],
        components: [row(page, next.data.entries.length === PAGE_SIZE)],
      });
    });

    collector.on('end', async () => {
      await interaction
        .editReply({ components: [row(page, false)] })
        .catch(() => undefined);
    });
  },
};
