/**
 * V6 02-04 — staff moderation from Discord, through the backend Redis bus.
 *
 * Safety model (binding per the blueprint):
 *  1. Discord roles are COSMETIC — the gate is the backend's LuckPerms resolve
 *     (helper | mod | admin) on the caller's LINKED Minecraft account. No link,
 *     no punishment; the actor field must be a real MC identity.
 *  2. Irreversible actions (/ban, /tempban) confirm via a single-use button —
 *     the customId embeds a nonce, honored exactly once, 60s lifetime.
 *  3. Every action writes a bot_mod_log row BEFORE dispatch; the outcome is
 *     updated with the plugin's response (the plugin keeps the authoritative
 *     record — this ledger answers "which Discord mod did what, when").
 *  4. Plugin timeouts are LOUD: a danger embed saying the punishment was NOT
 *     applied, never a silent success.
 */
import { SlashCommandBuilder, EmbedBuilder } from '@discordjs/builders';
import { query } from '../db/pool.js';
import { getPermissions, getProfile } from './apiClient.js';
import { errorEmbed } from './embeds.js';
import { COLORS } from './config.js';
import { getCronConfig } from './cronConfig.js';
import type { InteractionShim } from './interactionShim.js';

export type StaffLevel = 'helper' | 'mod' | 'admin';

const LEVEL_RANK: Record<StaffLevel, number> = { helper: 1, mod: 2, admin: 3 };

/** Resolves the caller's linked identity + backend permissions; null = denied. */
export async function requireStaff(
  interaction: InteractionShim,
  level: StaffLevel,
): Promise<{ actorUuid: string; actorName: string } | null> {
  const profile = await getProfile({ discordId: interaction.user.id });
  if (!profile.ok) return null;
  const perms = await getPermissions(interaction.user.id);
  if (!perms.ok) return null;
  const rank = perms.data.isAdmin ? 3 : perms.data.isMod ? 2 : perms.data.isHelper ? 1 : 0;
  if (rank < LEVEL_RANK[level]) return null;
  return { actorUuid: profile.data.uuid, actorName: profile.data.username ?? profile.data.uuid };
}

/** Fires the punishment through the backend bus + writes/updates the mod ledger. */
async function dispatchPunishment(
  discordId: string,
  actor: { actorUuid: string; actorName: string },
  target: string,
  action: string,
  reason: string,
  duration?: string,
): Promise<{ ok: boolean; message: string }> {
  // Ledger row first (outcome pending) — a dispatch crash still leaves the trail.
  let logId: string | null = null;
  try {
    const row = await query<{ id: string }>(
      'INSERT INTO bot_mod_log (discord_id, actor_uuid, action, target, reason, duration) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id::text',
      [discordId, actor.actorUuid, action, target, reason, duration ?? null],
    );
    logId = row.rows[0]?.id ?? null;
  } catch {
    // Audit write failure does not block the action; the plugin record still exists.
  }

  const { punishAdmin } = await import('./apiClient.js');
  const res = await punishAdmin({ target, action, reason, duration, actor: actor.actorName });
  const outcome = res.ok ? 'ok' : res.status === 501 ? 'no_response' : 'rejected';
  if (logId) {
    void query('UPDATE bot_mod_log SET outcome = $1 WHERE id = $2', [outcome, logId]).catch(() => undefined);
  }
  if (res.ok) return { ok: true, message: String((res.data as { result?: unknown })?.result ?? 'applied') };
  return {
    ok: false,
    message:
      res.status === 501
        ? 'PUNISHMENT NOT APPLIED — the game server did not respond. Check the console.'
        : res.message,
  };
}

export function moderationEmbed(title: string, lines: string[], danger = false): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`${danger ? '⛔' : '🛡'} ${title}`)
    .setDescription(lines.join('\n'))
    .setColor(danger ? COLORS.red : COLORS.gold)
    .setFooter({ text: 'imperiummc.net • Forge your empire.' })
    .setTimestamp();
}

export async function handleModCommand(
  interaction: InteractionShim,
  level: StaffLevel,
  run: (actor: { actorUuid: string; actorName: string }) => Promise<void>,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const actor = await requireStaff(interaction, level);
  if (!actor) {
    await interaction.editReply({
      embeds: [errorEmbed('Staff commands require a linked account with the matching staff rank.', 'Not authorized')],
    });
    return;
  }
  await run(actor);
}

export { dispatchPunishment };
