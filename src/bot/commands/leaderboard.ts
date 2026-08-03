/**
 * /leaderboard <type> — top 10 players, paginated 10 per page.
 *
 * Pagination is stateless: each button's custom_id encodes the leaderboard
 * type and target page directly (`lb:<type>:<page>`). The old discord.js
 * version used a live MessageComponentCollector — a gateway-only feature
 * (it listens for follow-up interactions over the WebSocket connection).
 * HTTP Interactions delivers each button click as its own independent
 * webhook call with no shared in-memory state, so the button itself has to
 * carry everything needed to render the next page. interactions.ts routes
 * any component interaction whose custom_id starts with "lb:" here.
 */
import { ActionRowBuilder, ButtonBuilder, SlashCommandBuilder } from '@discordjs/builders';
import { ButtonStyle } from 'discord-api-types/v10';
import { getLeaderboard } from '../apiClient.js';
import { leaderboardEmbed, errorEmbed } from '../embeds.js';
import type { InteractionShim } from '../interactionShim.js';
import type { BotCommand } from './_shared.js';

const TYPES = ['denarius', 'blocks', 'prestige', 'playtime'] as const;
type LeaderboardType = (typeof TYPES)[number];

const PAGE_SIZE = 10;
const CUSTOM_ID_PREFIX = 'lb:';

function isLeaderboardType(value: string): value is LeaderboardType {
  return (TYPES as readonly string[]).includes(value);
}

function row(type: LeaderboardType, page: number, hasNext: boolean) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}${type}:${page - 1}`)
      .setLabel('◀ Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page === 0),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}${type}:${page + 1}`)
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!hasNext),
  );
}

async function loadPage(type: LeaderboardType, page: number) {
  const result = await getLeaderboard(type, PAGE_SIZE);
  if (!result.ok) return result;
  // Slice client-side for pagination; backend returns up to PAGE_SIZE.
  const start = page * PAGE_SIZE;
  return {
    ok: true as const,
    data: { ...result.data, entries: result.data.entries.slice(start, start + PAGE_SIZE) },
  };
}

/** True if this component interaction belongs to leaderboard pagination. */
export function isLeaderboardComponent(customId: string): boolean {
  return customId.startsWith(CUSTOM_ID_PREFIX);
}

/** Handle a leaderboard pagination button click (routed from interactions.ts). */
export async function handleLeaderboardComponent(interaction: InteractionShim): Promise<void> {
  const customId = interaction.customId ?? '';
  const [, typeRaw, pageRaw] = customId.split(':');
  const page = Number.parseInt(pageRaw ?? '0', 10);

  if (!typeRaw || !isLeaderboardType(typeRaw) || Number.isNaN(page) || page < 0) {
    await interaction.deferUpdate();
    return;
  }

  await interaction.deferUpdate();

  const result = await loadPage(typeRaw, page);
  if (!result.ok || result.data.entries.length === 0) {
    // Went past the end (or the backend hiccupped) — leave the message as-is
    // rather than showing an empty/broken page.
    return;
  }

  await interaction.editReply({
    embeds: [leaderboardEmbed(result.data)],
    components: [row(typeRaw, page, result.data.entries.length === PAGE_SIZE)],
  });
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
  async execute(interaction) {
    const type = interaction.options.getString('type', true);
    if (!type || !isLeaderboardType(type)) {
      await interaction.reply({
        embeds: [errorEmbed('Unknown leaderboard type.')],
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply();

    const page = 0;
    const initial = await loadPage(type, page);
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

    await interaction.editReply({
      embeds: [leaderboardEmbed(initial.data)],
      components: [row(type, page, initial.data.entries.length === PAGE_SIZE)],
    });
  },
};
