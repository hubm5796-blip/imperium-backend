/**
 * Bot cron orchestrator — everything the every-minute Worker cron runs, in
 * one guarded pass (V6 05-03 + the 02-05/02-07/02-09 port).
 *
 * Legs, each isolated (one leg failing never kills the others):
 *  1. Webhook delivery tick — drains the signed-delivery queue (05-03).
 *  2. Webhook events tailer — folds recent web_events into the queue (05-03).
 *  3. Notification sweep — war/colosseum/omen/season/vote-DM pings (02-05).
 *  4. Role audit tick — batched role-sync pass during the 03:00 UTC hour (02-07).
 *  5. Analytics rollup — folds bot_command_log at 00:05 UTC (02-09).
 *
 * Legs 3-5 read their config through getCronConfig(); with no channel/role
 * ids configured they no-op, so deploying the cron before Discord ids are
 * set is safe by construction.
 */
import { logger } from '../utils/logger.js';
import { runDeliveryTick } from '../webhooks/deliver.js';
import { runEventsTailer } from '../webhooks/tailer.js';
import { runNotificationSweep } from './notify/scheduler.js';
import { runRoleAuditTick } from './roles/audit.js';
import { runDailyRollup } from './analytics/rollup.js';
import { getCronConfig } from './cronConfig.js';

export interface CronReport {
  webhookDeliveries: { processed: number; delivered: number; retried: number; dead: number };
  webhookTailer: { events: number; queued: number };
  sweep: { fired: number; errors: number };
  audit: { ran: boolean; checked: number; changed: number; failed: number };
  rollup: { ran: boolean; metrics: number };
}

/** One full cron pass. Never throws — every leg catches its own errors and
 *  the report carries what actually happened for the log line. */
export async function runBotCron(now: Date = new Date()): Promise<CronReport> {
  const report: CronReport = {
    webhookDeliveries: { processed: 0, delivered: 0, retried: 0, dead: 0 },
    webhookTailer: { events: 0, queued: 0 },
    sweep: { fired: 0, errors: 0 },
    audit: { ran: false, checked: 0, changed: 0, failed: 0 },
    rollup: { ran: false, metrics: 0 },
  };

  try {
    report.webhookDeliveries = await runDeliveryTick(now.getTime());
  } catch (err) {
    logger.error({ err: String(err) }, 'cron: webhook delivery tick crashed');
  }

  try {
    const tailer = await runEventsTailer();
    report.webhookTailer = { events: tailer.scanned, queued: tailer.emitted };
  } catch (err) {
    logger.error({ err: String(err) }, 'cron: webhook events tailer crashed');
  }

  const config = getCronConfig();
  if (config.botToken) {
    try {
      const sweep = await runNotificationSweep(config, now);
      const fired = sweep.war30 + sweep.war5 + sweep.colosseum + sweep.omen + sweep.season + sweep.voteDms + sweep.eventDms;
      report.sweep = { fired, errors: sweep.errors.length };
      if (sweep.errors.length > 0) {
        logger.warn({ errors: sweep.errors.slice(0, 10) }, 'cron: notification sweep errors');
      }
    } catch (err) {
      logger.error({ err: String(err) }, 'cron: notification sweep crashed');
    }

    try {
      const audit = await runRoleAuditTick(config, now);
      report.audit = { ran: audit.ran, checked: audit.checked, changed: audit.changed, failed: audit.failed };
    } catch (err) {
      logger.error({ err: String(err) }, 'cron: role audit tick crashed');
    }
  }

  try {
    const rollup = await runDailyRollup(now);
    report.rollup = { ran: rollup.ran, metrics: rollup.metrics };
    if (rollup.error) logger.error({ err: rollup.error, day: rollup.day }, 'cron: analytics rollup failed');
  } catch (err) {
    logger.error({ err: String(err) }, 'cron: analytics rollup crashed');
  }

  return report;
}
