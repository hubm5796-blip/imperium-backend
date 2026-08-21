/**
 * Role audit (V6 02-07) — the corrective leg of role sync. Ported from
 * imperium-discord. Runs during the 03:00 UTC hour inside the every-minute
 * cron: each tick processes one batch of 25 linked members and advances a
 * Postgres-backed cursor, so a big guild spreads over the hour at a natural
 * ≤25 role-ops/min ceiling (Discord's practical limit is ~30/min) instead of
 * bursting.
 *
 * Exactly-once-per-night: the cursor carries the UTC day it belongs to; a
 * new day resets it to the first member. A tick that dies mid-batch re-reads
 * the cursor next minute and resumes — drift on individual members heals on
 * the NEXT night.
 */
import type { CronConfig } from '../cronConfig.js';
import { getState, setState, pageLinkedMembers } from '../botdb.js';
import { syncMemberRoles } from './sync.js';

export const AUDIT_UTC_HOUR = 3;
export const AUDIT_BATCH = 25;

interface AuditCursor {
  day: string; // UTC date the pass belongs to (YYYY-MM-DD)
  lastDiscordId: string; // resume point; '' = start
  done: boolean;
}

export interface AuditReport {
  ran: boolean;
  checked: number;
  changed: number;
  failed: number;
  finished: boolean;
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * One audit tick. Returns ran:false outside the audit window / when disabled /
 * when the pass for tonight already finished — the cron logs and moves on.
 */
export async function runRoleAuditTick(config: CronConfig, now: Date): Promise<AuditReport> {
  const idle: AuditReport = { ran: false, checked: 0, changed: 0, failed: 0, finished: false };
  if (!config.roleSyncEnabled || config.guildId === '0') return idle;
  if (now.getUTCHours() !== AUDIT_UTC_HOUR) return idle;

  const today = utcDay(now);
  const cursor =
    (await getState<AuditCursor>('role_audit_cursor')) ?? { day: '', lastDiscordId: '', done: false };
  if (cursor.day === today && cursor.done) return idle;

  const resumeFrom = cursor.day === today ? cursor.lastDiscordId : '';
  let batch;
  try {
    batch = await pageLinkedMembers(resumeFrom, AUDIT_BATCH);
  } catch (err) {
    console.error(`[role-audit] link page failed: ${err instanceof Error ? err.message : err}`);
    return idle; // cursor unchanged — next tick retries the same page
  }
  if (batch.length === 0) {
    await setState('role_audit_cursor', { day: today, lastDiscordId: resumeFrom, done: true });
    console.log(`[role-audit] pass for ${today} complete`);
    return { ran: true, checked: 0, changed: 0, failed: 0, finished: true };
  }

  let changed = 0;
  let failed = 0;
  let lastId = resumeFrom;
  for (const link of batch) {
    lastId = link.discord_id;
    const outcome = await syncMemberRoles(config, config.guildId, link.discord_id);
    if (!outcome.applied) {
      failed += 1; // includes backend-down / member-left — counted, not thrown
      continue;
    }
    const report = outcome.report;
    if (report && (report.added.length > 0 || report.removed.length > 0)) {
      changed += 1;
      console.log(
        `[role-audit] ${link.uuid}: +${report.added.length} -${report.removed.length}` +
          (report.failed.length > 0 ? ` (${report.failed.length} ops failed)` : ''),
      );
    }
    if (report && report.failed.length > 0) failed += 1;
  }

  await setState('role_audit_cursor', { day: today, lastDiscordId: lastId, done: false });
  return { ran: true, checked: batch.length, changed, failed, finished: false };
}
