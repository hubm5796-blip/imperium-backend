/**
 * V6 02-04 — the staff moderation commands.
 *
 *   /lookup <name>            helper   backend player card
 *   /history <name>           helper   punishment history (player_bans)
 *   /warn <name> <reason>     helper   PUNISH_PLAYER warn
 *   /mute <name> <dur> [r]    mod      PUNISH_PLAYER mute
 *   /kick <name> <reason>     mod      PUNISH_PLAYER kick
 *   /tempban <n> <dur> <r>    mod+CONFIRM (single-use button, 60s)
 *   /ban <name> <reason>      admin+CONFIRM (single-use button, 60s)
 *
 * Gate: backend LuckPerms resolve on the LINKED account (Discord roles are
 * cosmetic). Ledger: bot_mod_log before dispatch, outcome updated after.
 */
import { SlashCommandBuilder, EmbedBuilder } from '@discordjs/builders';
import { getProfile, adminPlayerLookup, moderationHistory } from '../apiClient.js';
import { errorEmbed } from '../embeds.js';
import { COLORS, formatNumber } from '../config.js';
import { handleModCommand, dispatchPunishment, moderationEmbed } from '../moderation.js';
import { type BotCommand } from './_shared.js';
import type { InteractionShim } from '../interactionShim.js';

// ── single-use confirmations (customId: modconfirm:<nonce>) ────────────────
interface PendingConfirm {
  discordId: string;
  target: string;
  action: string;
  reason: string;
  duration?: string;
  expiresAt: number;
}
const pendingConfirms = new Map<string, PendingConfirm>();

/** Called from interactions.ts on a modconfirm button click. Single-use + 60s TTL. */
export async function consumeModConfirm(nonce: string, interaction: InteractionShim): Promise<void> {
  const pending = pendingConfirms.get(nonce);
  if (!pending) {
    await interaction.deferUpdate();
    return;
  }
  pendingConfirms.delete(nonce); // single-use: honored exactly once
  if (Date.now() > pending.expiresAt || pending.discordId !== interaction.user.id) {
    await interaction.deferUpdate();
    return;
  }
  await interaction.deferUpdate();
  // The actor identity was resolved at button-request time; re-verify the link
  // cheaply (the profile is the identity source for the ledger).
  const profile = await getProfile({ discordId: interaction.user.id });
  if (!profile.ok) {
    await interaction.editReply({ embeds: [errorEmbed('Link lost — punishment NOT applied.')] });
    return;
  }
  const result = await dispatchPunishment(
    interaction.user.id,
    { actorUuid: profile.data.uuid, actorName: profile.data.username ?? profile.data.uuid },
    pending.target,
    pending.action,
    pending.reason,
    pending.duration,
  );
  await interaction.editReply({
    embeds: [
      moderationEmbed(
        result.ok ? `${pending.action} applied` : `${pending.action} FAILED`,
        [
          `**Target:** ${pending.target}`,
          `**Reason:** ${pending.reason}`,
          ...(pending.duration ? [`**Duration:** ${pending.duration}`] : []),
          `**Result:** ${result.message}`,
        ],
        !result.ok,
      ),
    ],
  });
}

function confirmButtonRow(nonce: string): unknown {
  return {
    type: 1,
    components: [
      {
        type: 2, style: 4, label: `Confirm ${'punishment'}`,
        custom_id: `modconfirm:${nonce}`,
      },
    ],
  };
}

function randomNonce(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export const lookupCommand: BotCommand = {
  name: 'lookup',
  toJSON() {
    return new SlashCommandBuilder().setName('lookup').setDescription('Player lookup (staff)')
      .addStringOption((o) => o.setName('name').setDescription('Player name').setRequired(true)).toJSON();
  },
  async execute(interaction) {
    await handleModCommand(interaction, 'helper', async () => {
      const name = interaction.options.getString('name', true).trim();
      const res = await adminPlayerLookup(name);
      if (!res.ok) {
        await interaction.editReply({ embeds: [errorEmbed(res.message)] });
        return;
      }
      const p = res.data as Record<string, unknown>;
      const embed = new EmbedBuilder()
        .setTitle(`🔍 ${String(p.username ?? name)}`)
        .setColor(COLORS.gold)
        .addFields(
          { name: 'Rank', value: String(p.rank ?? '?'), inline: true },
          { name: 'Prestige', value: String(p.prestige ?? 0), inline: true },
          { name: 'Denarius', value: formatNumber(Number(p.denarius ?? 0)), inline: true },
          { name: 'Tokens', value: formatNumber(Number(p.auctoritas ?? 0)), inline: true },
          { name: 'Blocks', value: formatNumber(Number(p.blocksMined ?? 0)), inline: true },
          { name: 'Playtime', value: `${Math.round(Number(p.playtimeSeconds ?? 0) / 3600)}h`, inline: true },
        )
        .setFooter({ text: 'imperiummc.net • Forge your empire.' })
        .setTimestamp();
      await interaction.editReply({ embeds: [embed] });
    });
  },
};

export const historyCommand: BotCommand = {
  name: 'history',
  toJSON() {
    return new SlashCommandBuilder().setName('history').setDescription('Punishment history (staff)')
      .addStringOption((o) => o.setName('name').setDescription('Player name').setRequired(true)).toJSON();
  },
  async execute(interaction) {
    await handleModCommand(interaction, 'helper', async () => {
      const name = interaction.options.getString('name', true).trim();
      // History needs a uuid: resolve via the game lookup first.
      const lookup = await adminPlayerLookup(name);
      if (!lookup.ok) {
        await interaction.editReply({ embeds: [errorEmbed(lookup.message)] });
        return;
      }
      const uuid = String((lookup.data as Record<string, unknown>).uuid ?? '');
      if (!uuid) {
        await interaction.editReply({ embeds: [errorEmbed('Could not resolve that player.')] });
        return;
      }
      const res = await moderationHistory(uuid);
      if (!res.ok) {
        await interaction.editReply({ embeds: [errorEmbed(res.message)] });
        return;
      }
      const rows = res.data.history;
      const embed =
        rows.length === 0
          ? moderationEmbed(`History — ${name}`, ['Clean record.'])
          : moderationEmbed(
              `History — ${name}`,
              rows.slice(0, 10).map((r) =>
                `<t:${Math.floor(Date.parse(String(r.banned_at)) / 1000)}:R> — **${String(r.active) === 'true' || r.active === true ? 'ACTIVE' : 'past'}** ${String(r.banned_by)}: ${String(r.reason).slice(0, 120)}`,
              ),
            );
      await interaction.editReply({ embeds: [embed] });
    });
  },
};

function simplePunishCommand(
  name: 'warn' | 'mute' | 'kick',
  level: 'helper' | 'mod',
  needsDuration: boolean,
): BotCommand {
  return {
    name,
    toJSON() {
      const b = new SlashCommandBuilder().setName(name).setDescription(`${name} a player (staff)`)
        .addStringOption((o) => o.setName('name').setDescription('Player name').setRequired(true));
      if (needsDuration) b.addStringOption((o) => o.setName('duration').setDescription('e.g. 30m, 2h, 1d').setRequired(true));
      b.addStringOption((o) => o.setName('reason').setDescription('Reason').setRequired(true));
      return b.toJSON();
    },
    async execute(interaction) {
      await handleModCommand(interaction, level, async (actor) => {
        const target = interaction.options.getString('name', true).trim();
        const duration = needsDuration ? interaction.options.getString('duration', true).trim() : undefined;
        const reason = interaction.options.getString('reason', true).slice(0, 500);
        const result = await dispatchPunishment(interaction.user.id, actor, target, name, reason, duration);
        await interaction.editReply({
          embeds: [
            moderationEmbed(
              result.ok ? `${name} applied` : `${name} FAILED`,
              [`**Target:** ${target}`, `**Reason:** ${reason}`, ...(duration ? [`**Duration:** ${duration}`] : []), `**Result:** ${result.message}`],
              !result.ok,
            ),
          ],
        });
      });
    },
  };
}

export const warnCommand = simplePunishCommand('warn', 'helper', false);
export const muteCommand = simplePunishCommand('mute', 'mod', true);
export const kickCommand = simplePunishCommand('kick', 'mod', false);

function confirmPunishCommand(name: 'tempban' | 'ban', level: 'mod' | 'admin', needsDuration: boolean): BotCommand {
  return {
    name,
    toJSON() {
      const b = new SlashCommandBuilder().setName(name).setDescription(`${name} a player (staff, with confirmation)`)
        .addStringOption((o) => o.setName('name').setDescription('Player name').setRequired(true));
      if (needsDuration) b.addStringOption((o) => o.setName('duration').setDescription('e.g. 1d, 7d').setRequired(true));
      b.addStringOption((o) => o.setName('reason').setDescription('Reason').setRequired(true));
      return b.toJSON();
    },
    async execute(interaction) {
      await handleModCommand(interaction, level, async () => {
        const target = interaction.options.getString('name', true).trim();
        const duration = needsDuration ? interaction.options.getString('duration', true).trim() : undefined;
        const reason = interaction.options.getString('reason', true).slice(0, 500);
        const nonce = randomNonce();
        pendingConfirms.set(nonce, {
          discordId: interaction.user.id,
          target,
          action: name,
          reason,
          duration,
          expiresAt: Date.now() + 60_000,
        });
        // Prune expired entries so the map can never grow unbounded.
        for (const [k, v] of pendingConfirms) if (Date.now() > v.expiresAt) pendingConfirms.delete(k);
        await interaction.editReply({
          embeds: [
            moderationEmbed(
              `Confirm ${name}`,
              [`**Target:** ${target}`, `**Reason:** ${reason}`, ...(duration ? [`**Duration:** ${duration}`] : []), 'This button works once and expires in 60 seconds.'],
              true,
            ),
          ],
          components: [confirmButtonRow(nonce)],
        });
      });
    },
  };
}

export const tempbanCommand = confirmPunishCommand('tempban', 'mod', true);
export const banCommand = confirmPunishCommand('ban', 'admin', false);
