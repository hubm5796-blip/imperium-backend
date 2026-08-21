/**
 * ROLE SYNC ENGINE (V6 02-07): Discord roles that mirror in-game state.
 * Ported from imperium-discord; desired state comes from GET /api/v2/member
 * (this Worker's own aggregate over discord_links + prestige_data +
 * donor_ranks — the plugin-synced donor row is what the game itself honors,
 * so the Discord role can never disagree with in-game perks).
 *
 * The safety model is "the bot only touches roles it owns by config":
 * computePlan diffs current vs desired but clamps both adds and removes to
 * the MANAGED set (the union of the ROLE_MAP values). Staff roles, Nitro
 * colors, the Linked role (granted by its own /link path) and anything
 * unknown are structurally untouchable — a config typo can therefore never
 * mass-strip someone's roles, only fail to grant a mapped one.
 */
import { getMember, type MemberSummary } from '../apiClient.js';
import type { CronConfig } from '../cronConfig.js';
import {
  fetchGuildMember,
  addGuildMemberRole,
  removeGuildMemberRole,
} from '../discordRest.js';

export interface SyncPlan {
  discordId: string;
  add: string[];
  remove: string[];
}

/** Every role id the bot may grant or revoke (config-owned only). */
export function managedRoleIds(config: CronConfig): Set<string> {
  return new Set([...Object.values(config.donorRoleMap), ...Object.values(config.prestigeRoleMap)]);
}

/**
 * Desired-state diff, clamped to the managed set. `protect` is advisory
 * documentation of everything else — the clamp is what actually enforces it.
 */
export function computePlan(
  discordId: string,
  current: string[],
  desired: string[],
  managed: Set<string>,
): SyncPlan {
  const currentSet = new Set(current.filter((r) => managed.has(r)));
  const desiredSet = new Set(desired.filter((r) => managed.has(r)));
  const add: string[] = [];
  const remove: string[] = [];
  for (const role of desiredSet) if (!currentSet.has(role)) add.push(role);
  for (const role of currentSet) if (!desiredSet.has(role)) remove.push(role);
  return { discordId, add, remove };
}

/** Map a member summary to desired role ids. Prestige grants EVERY milestone
 *  reached (5 → role5; 10 → role5+role10) — ladders read better stacked. */
export function desiredRoles(config: CronConfig, member: MemberSummary): string[] {
  const roles: string[] = [];
  if (member.donor?.active) {
    const role = config.donorRoleMap[member.donor.tier.toLowerCase()];
    if (role) roles.push(role);
    // An unmapped tier is a config gap, not a member error — surfaced by the
    // audit log, never thrown (one bad PRODUCT key must not stall the sweep).
    else if (member.donor.tier) {
      console.warn(`[roles] donor tier "${member.donor.tier}" has no ROLE_MAP_DONOR entry — skipped`);
    }
  }
  for (const milestone of Object.keys(config.prestigeRoleMap)) {
    const threshold = Number(milestone);
    if (Number.isFinite(threshold) && member.prestigeLevel >= threshold) {
      roles.push(config.prestigeRoleMap[milestone]!);
    }
  }
  return [...new Set(roles)];
}

export interface RoleApplyReport {
  added: string[];
  removed: string[];
  failed: string[];
}

/** Fetch the member's current roles, compute, and apply the plan. Never
 *  throws — per-role failures are collected; the nightly audit heals them. */
export async function syncMemberRoles(
  config: CronConfig,
  guildId: string,
  discordId: string,
  opts: { unlinkedStrip?: boolean } = {},
): Promise<{ applied: boolean; report?: RoleApplyReport; unlinked?: boolean; message?: string }> {
  if (!config.roleSyncEnabled) return { applied: false, message: 'role sync disabled' };
  const botToken = config.botToken;

  const desired = await getMember(discordId);
  if (!desired.ok) {
    if (desired.status === 404 && opts.unlinkedStrip) {
      // Unlinked: the only correct desired state is "no managed roles".
      const member = await fetchGuildMember(guildId, discordId, botToken);
      if (!member) return { applied: false, message: 'member fetch failed' };
      const plan = computePlan(discordId, member.roles, [], managedRoleIds(config));
      const report = await applyPlan(botToken, guildId, plan);
      return { applied: true, report, unlinked: true };
    }
    return { applied: false, message: desired.message };
  }

  const member = await fetchGuildMember(guildId, discordId, botToken);
  if (!member) return { applied: false, message: 'member fetch failed' };

  const plan = computePlan(discordId, member.roles, desiredRoles(config, desired.data), managedRoleIds(config));
  const report = await applyPlan(botToken, guildId, plan);
  return { applied: true, report };
}

/** Apply add/remove ops. Returns per-role outcomes; an empty plan is a no-op. */
export async function applyPlan(
  botToken: string,
  guildId: string,
  plan: SyncPlan,
): Promise<RoleApplyReport> {
  const report: RoleApplyReport = { added: [], removed: [], failed: [] };
  for (const roleId of plan.add) {
    const ok = await addGuildMemberRole(guildId, plan.discordId, roleId, botToken);
    (ok ? report.added : report.failed).push(roleId);
  }
  for (const roleId of plan.remove) {
    const ok = await removeGuildMemberRole(guildId, plan.discordId, roleId, botToken);
    (ok ? report.removed : report.failed).push(roleId);
  }
  return report;
}
