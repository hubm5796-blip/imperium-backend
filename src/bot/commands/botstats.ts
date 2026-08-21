/**
 * /botstats (V6 02-09): staff-gated usage stats over bot_metrics_daily.
 * Ported from imperium-discord into the backend bot.
 *
 * Gate: the caller must have a linked account whose LuckPerms flags include
 * helper-or-above (same backend permissions source the web admin panel uses —
 * Discord roles are cosmetic and never trusted). Aggregates only: per-command
 * totals, unique users, error counts, p95 latency for the window.
 */
import { EmbedBuilder } from '@discordjs/builders';
import { query } from '../../db/pool.js';
import { getPermissions } from '../apiClient.js';
import { errorEmbed } from '../embeds.js';
import { COLORS, EMOJI, formatNumber } from '../config.js';
import { type BotCommand } from './_shared';

interface MetricRow {
  day: string;
  metric: string;
  command: string;
  value: number;
}

export const botstatsCommand: BotCommand = {
  name: 'botstats',
  toJSON() {
    return {
      name: 'botstats',
      description: 'Bot usage stats (staff only)',
      options: [
        {
          name: 'days',
          description: 'Window in days (1-30, default 7)',
          type: 4, // INTEGER
          min_value: 1,
          max_value: 30,
        },
      ],
    };
  },
  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    // Staff gate — linked account + backend permission flags. 404 from
    // getPermissions means not linked; 403-ish answers deny.
    const perms = await getPermissions(interaction.user.id);
    if (!perms.ok) {
      const embed =
        perms.status === 404
          ? errorEmbed('Staff commands require a linked Minecraft account. Run `/link` first.', 'Not linked')
          : errorEmbed('Could not verify staff permissions (backend unreachable). Try again shortly.');
      await interaction.editReply({ embeds: [embed] });
      return;
    }
    if (!perms.data.isAdmin && !perms.data.isMod && !perms.data.isHelper) {
      await interaction.editReply({ embeds: [errorEmbed('You do not have staff permissions for this command.', 'Forbidden')] });
      return;
    }

    const days = Math.min(Math.max(interaction.options.getInteger('days', false) ?? 7, 1), 30);
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - days);
    const sinceDay = since.toISOString().slice(0, 10);

    let rows: MetricRow[];
    try {
      const result = await query<MetricRow>(
        `SELECT day::text, metric, command, value FROM bot_metrics_daily
         WHERE day >= $1 AND metric IN ('commands', 'errors', 'unique_users', 'p95_ms', 'avg_ms')
         ORDER BY day LIMIT 5000`,
        [sinceDay],
      );
      rows = result.rows;
    } catch {
      await interaction.editReply({
        embeds: [errorEmbed('Analytics tables are not available — stats accumulate once the bot logs commands.')],
      });
      return;
    }

    if (rows.length === 0) {
      const empty = new EmbedBuilder()
        .setTitle(`${EMOJI.chart} Bot stats`)
        .setDescription(`No analytics recorded yet for the last ${days} day${days === 1 ? '' : 's'}.`)
        .setColor(COLORS.darkGray)
        .setFooter({ text: 'imperiummc.net • Forge your empire.' });
      await interaction.editReply({ embeds: [empty] });
      return;
    }

    // Fold the window: per-command executions/errors/p95, plus window totals.
    const commands = new Map<string, { total: number; errors: number; p95: number }>();
    let windowTotal = 0;
    let windowUsers = 0;
    let windowErrors = 0;
    const coveredDays = new Set<string>();
    for (const row of rows) {
      coveredDays.add(row.day);
      if (row.command === '') {
        // Window totals come from the command-less aggregate rows only —
        // summing per-command rows too would double-count every execution.
        if (row.metric === 'commands') windowTotal += row.value;
        if (row.metric === 'unique_users') windowUsers += row.value;
        continue;
      }
      const entry = commands.get(row.command) ?? { total: 0, errors: 0, p95: 0 };
      if (row.metric === 'commands') {
        entry.total += row.value;
      } else if (row.metric === 'errors') {
        entry.errors += row.value;
        windowErrors += row.value;
      } else if (row.metric === 'p95_ms') {
        entry.p95 = Math.max(entry.p95, row.value);
      }
      commands.set(row.command, entry);
    }

    const top = [...commands.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, 15);
    const table = top
      .map(([name, s]) => `\`${name}\` — ${formatNumber(s.total)} runs${s.errors ? ` • ${formatNumber(s.errors)} errs` : ''} • p95 ${s.p95}ms`)
      .join('\n');

    const embed = new EmbedBuilder()
      .setTitle(`${EMOJI.chart} Bot stats — last ${days} day${days === 1 ? '' : 's'} (${coveredDays.size} covered)`)
      .setDescription(table || 'No command activity in the window.')
      .addFields(
        { name: 'Total executions', value: formatNumber(windowTotal), inline: true },
        { name: 'Unique users (sum/day)', value: formatNumber(windowUsers), inline: true },
        { name: 'Errors', value: formatNumber(windowErrors), inline: true },
      )
      .setColor(COLORS.gold)
      .setFooter({ text: 'imperiummc.net • Forge your empire.' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};
