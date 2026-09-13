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
import { PermissionFlagsBits } from 'discord-api-types/v10';
import { adminPlayerLookup, moderationHistory } from '../apiClient.js';
import { errorEmbed } from '../embeds.js';
import { COLORS, formatNumber } from '../config.js';
import { handleModCommand, dispatchPunishment, moderationEmbed, requireStaff, type StaffLevel } from '../moderation.js';
import { type BotCommand } from './_shared.js';
import type { InteractionShim } from '../interactionShim.js';

/* ── Discord-side visibility gates (defense in depth) ──────────────────────
 * The AUTHORITATIVE gate stays requireStaff() — backend LuckPerms resolve on
 * the linked MC account. The default_member_permissions below only control
 * who can even see/run the command in the Discord client, so non-staff don't
 * get dead commands in their picker. One bit per tier:
 *   helper tier → ModerateMembers · mod tier → KickMembers · ban → BanMembers
 * The matching bits are granted to the guild's staff roles by
 * scripts/grant-staff-perms.mts. Server admins may tighten further in
 * Settings → Integrations; the runtime gate still applies regardless. */
const HELPER_BIT = PermissionFlagsBits.ModerateMembers; // lookup/warn/botstats
const MOD_BIT = PermissionFlagsBits.KickMembers; // history/mute/kick/tempban
const ADMIN_BIT = PermissionFlagsBits.BanMembers; // ban

// ── single-use confirmations (customId: modconfirm:<nonce>) ────────────────
interface PendingConfirm {
  discordId: string;
  /** Staff level the execute-time gate demanded — re-checked at consume (B-22:
   *  rank loss between request and click must void the confirmation). */
  requiredLevel: StaffLevel;
  target: string;
  action: string;
  reason: string;
  duration?: string;
  expiresAt: number;
}
const pendingConfirms = new Map<string, PendingConfirm>();

/** Called from interactions.ts on a modconfirm button click. Single-use + 60s TTL. */
export async function consumeModConfirm(nonce: string, interaction: InteractionShim): Promise<void> {
  await interaction.deferUpdate();
  const pending = pendingConfirms.get(nonce);
  if (!pending) {
    // Unknown nonce: already consumed, expired out of the map, or created on a
    // different isolate before a recycle. A bare ack here reads as "done" while
    // nothing happened — say so instead (B-22 silent-drop).
    await interaction.editReply({
      embeds: [errorEmbed('This confirmation has expired or was already used. Run the command again.', 'Confirmation unavailable')],
    });
    return;
  }
  pendingConfirms.delete(nonce); // single-use: honored exactly once
  if (Date.now() > pending.expiresAt) {
    await interaction.editReply({
      embeds: [errorEmbed('This confirmation expired (60s limit). Run the command again.', 'Confirmation expired')],
    });
    return;
  }
  if (pending.discordId !== interaction.user.id) {
    // Not the initiator's view — leave their message alone, tell the clicker privately.
    await interaction.reply({
      embeds: [errorEmbed('Only the staff member who ran the command can confirm it.', 'Not your confirmation')],
      ephemeral: true,
    });
    return;
  }
  // TOCTOU (B-22): the rank was verified when the button was REQUESTED; the
  // click may come up to 60s later. Re-run the full staff gate at consume
  // time — same level the execute-time check demanded, which the record now
  // carries. requireStaff re-resolves the linked identity too, so a link
  // lost in between also voids the confirmation.
  const actor = await requireStaff(interaction, pending.requiredLevel);
  if (!actor) {
    await interaction.editReply({
      embeds: [errorEmbed('Link or staff rank no longer valid — punishment NOT applied. Re-run the command if this is unexpected.', 'Not authorized')],
    });
    return;
  }
  const result = await dispatchPunishment(
    interaction.user.id,
    actor,
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

/** B-22: Math.random-based nonces were predictable (the P-18 class) — a
 *  guessable customId let anyone forge a confirm click within the 60s window.
 *  crypto.randomUUID is the platform CSPRNG. */
function randomNonce(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

export const lookupCommand: BotCommand = {
  name: 'lookup',
  toJSON() {
    return new SlashCommandBuilder().setName('lookup').setDescription('Player lookup (staff)')
      .setDefaultMemberPermissions(HELPER_BIT)
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
      .setDefaultMemberPermissions(MOD_BIT)
      .addStringOption((o) => o.setName('name').setDescription('Player name').setRequired(true)).toJSON();
  },
  async execute(interaction) {
    // B-19: punishment history is mod+ on the backend; verify the same level
    // Discord-side so the denial reads clearly instead of a backend 403.
    await handleModCommand(interaction, 'mod', async () => {
      const name = interaction.options.getString('name', true).trim();
      // History needs a uuid: resolve via the game lookup first.
      const lookup = await adminPlayerLookup(name, 'mod');
      if (!lookup.ok) {
        await interaction.editReply({ embeds: [errorEmbed(lookup.message)] });
        return;
      }
      const uuid = String((lookup.data as Record<string, unknown>).uuid ?? '');
      if (!uuid) {
        await interaction.editReply({ embeds: [errorEmbed('Could not resolve that player.')] });
        return;
      }
      const res = await moderationHistory(uuid, 'mod');
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
        .setDefaultMemberPermissions(level === 'helper' ? HELPER_BIT : MOD_BIT)
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
        .setDefaultMemberPermissions(level === 'admin' ? ADMIN_BIT : MOD_BIT)
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
          requiredLevel: level,
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
