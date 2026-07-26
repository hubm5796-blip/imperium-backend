/**
 * Roman-themed embed builders for ImperiumMC.
 *
 * Every command renders through these helpers so the look stays consistent:
 * gold accents, dark/neutral chrome, and a common footer.
 */
import { EmbedBuilder, type EmbedField } from 'discord.js';
import {
  BRANDING,
  COLORS,
  CURRENCIES,
  EMOJI,
  formatNumber,
  formatPlaytime,
  toRoman,
} from './config.js';
import type {
  LeaderboardResult,
  PlayerProfile,
  ServerStatus,
} from './apiClient.js';

const FOOTER = { text: `${BRANDING.serverName} • ${BRANDING.serverIp}` };

/** Apply shared chrome (color + footer + timestamp) to an embed. */
function chrome(embed: EmbedBuilder, color: number = COLORS.gold): EmbedBuilder {
  return embed.setColor(color).setFooter(FOOTER).setTimestamp();
}

/** A compact, always-green success embed. */
export function successEmbed(message: string, title = 'Success'): EmbedBuilder {
  return chrome(
    new EmbedBuilder()
      .setTitle(`${EMOJI.check} ${title}`)
      .setDescription(message),
    COLORS.green,
  );
}

/** A compact, always-red error embed. */
export function errorEmbed(message: string, title = 'Error'): EmbedBuilder {
  return chrome(
    new EmbedBuilder()
      .setTitle(`${EMOJI.cross} ${title}`)
      .setDescription(message),
    COLORS.red,
  );
}

/** A compact, always-red "not linked" embed — reused across commands. */
export function notLinkedEmbed(): EmbedBuilder {
  return errorEmbed(
    "This Discord account isn't linked yet. In-game, run `/link` to get a 6-character code, then use `/link <code>` here.",
    'Account not linked',
  );
}

/** Compute a kill/death ratio safely (no divide-by-zero). */
function kdr(kills = 0, deaths = 0): string {
  if (!deaths) return kills.toFixed(2);
  return (kills / deaths).toFixed(2);
}

/** Build the rich player profile card. */
export function profileEmbed(data: PlayerProfile): EmbedBuilder {
  const rank = toRoman(data.rank ?? 0);
  const prestige = data.prestigeLevel ?? 0;

  const fields: EmbedField[] = [
    {
      name: `${EMOJI.crown} Rank`,
      value: `**${rank}**${prestige ? `  •  Prestige ${toRoman(prestige)}` : ''}`,
      inline: true,
    },
    {
      name: `${EMOJI.coin} Denarius`,
      value: formatNumber(data.denarius),
      inline: true,
    },
    {
      name: `${EMOJI.crown} Aureus`,
      value: formatNumber(data.aureus),
      inline: true,
    },
    {
      name: `${EMOJI.gem} Auctoritas`,
      value: formatNumber(data.auctoritas),
      inline: true,
    },
    {
      name: `${EMOJI.colosseum} Civitas`,
      value: formatNumber(data.civitas),
      inline: true,
    },
    {
      name: `${EMOJI.trophy} Trophies`,
      value: formatNumber(data.trophies),
      inline: true,
    },
    {
      name: `${EMOJI.blocks} Blocks Mined`,
      value: formatNumber(data.blocksMined),
      inline: true,
    },
    {
      name: `${EMOJI.clock} Playtime`,
      value: formatPlaytime(data.playtimeSeconds),
      inline: true,
    },
    {
      name: `${EMOJI.helm} PVP (K/D)`,
      value: `${formatNumber(data.pvpKills)} / ${formatNumber(
        data.pvpDeaths,
      )}  (${kdr(data.pvpKills, data.pvpDeaths)})`,
      inline: true,
    },
  ];

  const embed = chrome(
    new EmbedBuilder()
      .setTitle(`${EMOJI.eagle} ${data.username}`)
      .setDescription(
        prestige
          ? `Prestige **${toRoman(prestige)}** citizen of ${BRANDING.serverName}.`
          : `Citizen of ${BRANDING.serverName}.`,
      )
      .addFields(fields),
    COLORS.gold,
  );

  return embed;
}

/** Compact 4-currency balance card. */
export function balanceEmbed(data: PlayerProfile): EmbedBuilder {
  const lines = Object.values(CURRENCIES).map((c) => {
    const key = c.name.toLowerCase() as keyof typeof CURRENCIES;
    // PlayerProfile uses the same lowercase keys.
    const value = (data as unknown as Record<string, number | undefined>)[key] ?? 0;
    return `${c.emoji} **${c.name}:** ${formatNumber(value)}  *(${c.blurb})*`;
  });

  return chrome(
    new EmbedBuilder()
      .setTitle(`${EMOJI.coin} Balance — ${data.username}`)
      .setDescription(lines.join('\n')),
    COLORS.gold,
  );
}

/** Mining + PVP statistics card. */
export function statsEmbed(data: PlayerProfile): EmbedBuilder {
  return chrome(
    new EmbedBuilder()
      .setTitle(`${EMOJI.chart} Statistics — ${data.username}`)
      .addFields(
        {
          name: `${EMOJI.blocks} Mining`,
          value: `**Blocks mined:** ${formatNumber(data.blocksMined)}`,
          inline: true,
        },
        {
          name: `${EMOJI.clock} Playtime`,
          value: formatPlaytime(data.playtimeSeconds),
          inline: true,
        },
        {
          name: `${EMOJI.trophy} Trophies`,
          value: formatNumber(data.trophies),
          inline: true,
        },
        {
          name: `${EMOJI.helm} PVP Kills`,
          value: formatNumber(data.pvpKills),
          inline: true,
        },
        {
          name: `${EMOJI.shield} PVP Deaths`,
          value: formatNumber(data.pvpDeaths),
          inline: true,
        },
        {
          name: `${EMOJI.eagle} K/D Ratio`,
          value: kdr(data.pvpKills, data.pvpDeaths),
          inline: true,
        },
      ),
    COLORS.gold,
  );
}

/** Humanize a leaderboard value based on its metric type. */
function formatLeaderboardValue(type: string, value: number): string {
  switch (type) {
    case 'playtime':
      return formatPlaytime(value);
    case 'denarius':
      return `${EMOJI.coin} ${formatNumber(value)}`;
    case 'blocks':
      return `${formatNumber(value)} blocks`;
    case 'prestige':
      return `Prestige ${toRoman(value)}`;
    default:
      return formatNumber(value);
  }
}

/** Top-players list embed. Empty state handled by the caller via errorEmbed. */
export function leaderboardEmbed(data: LeaderboardResult): EmbedBuilder {
  const titleMap: Record<string, string> = {
    denarius: `${EMOJI.coin} Wealthiest Citizens`,
    blocks: `${EMOJI.blocks} Most Industrious`,
    prestige: `${EMOJI.crown} Highest Prestige`,
    playtime: `${EMOJI.clock} Most Devoted`,
  };
  const title = titleMap[data.type] ?? `${EMOJI.chart} Leaderboard`;

  const medals = ['🥇', '🥈', '🥉'];
  const rows = data.entries.map((e) => {
    const prefix = e.rank <= 3 ? medals[e.rank - 1] : `**#${e.rank}**`;
    return `${prefix} **${e.username}** — ${formatLeaderboardValue(data.type, e.value)}`;
  });

  return chrome(
    new EmbedBuilder()
      .setTitle(`${EMOJI.eagle} ${title}`)
      .setDescription(rows.join('\n') || 'No entries yet.'),
    COLORS.gold,
  );
}

/** Server status embed. */
export function serverStatusEmbed(status: ServerStatus): EmbedBuilder {
  if (!status.online) {
    return chrome(
      new EmbedBuilder()
        .setTitle(`${EMOJI.cross} Server Offline`)
        .setDescription(`${BRANDING.serverName} is currently offline.`)
        .addFields({
          name: `${EMOJI.helm} Address`,
          value: `\`${BRANDING.serverIp}\``,
          inline: true,
        }),
      COLORS.red,
    );
  }

  const playerCount = `${formatNumber(status.playerCount)} / ${formatNumber(
    status.maxPlayers,
  )}`;
  const fields: EmbedField[] = [
    {
      name: `${EMOJI.user} Players`,
      value: playerCount,
      inline: true,
    },
    {
      name: `${EMOJI.helm} Address`,
      value: `\`${BRANDING.serverIp}\``,
      inline: true,
    },
  ];
  if (typeof status.tps === 'number') {
    fields.push({
      name: `${EMOJI.chart} TPS`,
      value: status.tps.toFixed(1),
      inline: true,
    });
  }
  if (status.motd) {
    fields.unshift({ name: 'MOTD', value: status.motd, inline: false });
  }

  return chrome(
    new EmbedBuilder()
      .setTitle(`${EMOJI.check} ${BRANDING.serverName} — Online`)
      .addFields(fields),
    COLORS.green,
  );
}

/** Store / donation embed. */
export function storeEmbed(): EmbedBuilder {
  return chrome(
    new EmbedBuilder()
      .setTitle(`${EMOJI.crown} Imperium Store`)
      .setDescription(
        `Support the empire and unlock ranks, keys, and ${CURRENCIES.aureus.name}.\n\n**[${BRANDING.storeUrl}](${BRANDING.storeUrl})**`,
      )
      .addFields({
        name: `${EMOJI.eagle} Why shop?`,
        value: '• Ranks & prestige boosts\n• Crate keys\n• Premium currency',
        inline: false,
      }),
    COLORS.gold,
  );
}

/** Welcome message DM body (plain text, not an embed). */
export function welcomeMessage(): string {
  return [
    `${EMOJI.eagle} **Welcome to ${BRANDING.serverName}!** ${EMOJI.colosseum}`,
    '',
    `Connect at \`${BRANDING.serverIp}\` and ${BRANDING.inviteBlurb}`,
    '',
    '**Link your account to unlock stats, balances, and leaderboards in Discord:**',
    `1. Join the server and run \`/link\` in-game to get a 6-character code.`,
    `2. Come back here and use \`/link <code>\`.`,
    '',
    `Store: ${BRANDING.storeUrl}`,
  ].join('\n');
}
