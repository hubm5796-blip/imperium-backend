/**
 * Bot cron orchestrator — everything the every-minute Worker cron runs, in
 * one guarded pass (V6 05-03 + the 02-05/02-07/02-09 port).
 *
 * Legs, each isolated (one leg failing never kills the others):
 * 1. Webhook delivery tick — drains the signed-delivery queue (05-03).
 * 2. Webhook events tailer — folds recent web_events into the queue (05-03).
 * 3. Notification sweep — war/colosseum/omen/season/vote-DM pings (02-05).
 * 4. Role audit tick — batched role-sync pass during the 03:00 UTC hour (02-07).
 * 5. Analytics rollup — folds bot_command_log at 00:05 UTC (02-09).
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
import { claim } from './botdb.js';
export interface CronReport {
 webhookDeliveries: { processed: number; delivered: number; retried: number; dead: number };
 webhookTailer: { events: number; queued: number };
 sweep: { fired: number; errors: number };
 audit: { ran: boolean; checked: number; changed: number; failed: number };
 rollup: { ran: boolean; metrics: number };
 tickets: { threaded: number; staleClosed: number; errors: number };
 dms: { sent: number; failed: number; skipped: number };
 /** S2-D03: failed-delivery alerting (breach + resolve, deduped in D1). */
 deliveries: { alerted: number; resolved: number; staleMarked: number; errors: number };
 /** S2-D05/S2-D07: daily analytics fold (economy day row + retention seen/days). */
 analytics: {
  economy: { ran: boolean; day: string | null; error?: string };
  retention: { ran: boolean; players: number; days: number; error?: string };
 };
 /** S2-D06: economy breach alerting (gini / weekly supply delta / faucet
  * concentration — deduped per breach-window in D1, resolve on recovery). */
 economyAlerts: { evaluated: boolean; day: string | null; alerted: number; resolved: number; open: string[]; errors: number };
 /** B-39: true when another isolate already ran this minute's pass — every
 * leg stayed untouched (the report is all-zero). */
 skipped?: boolean;
}
/** One full cron pass. Never throws — every leg catches its own errors and
 * the report carries what actually happened for the log line.
 *
 * B-39 self-isolation: cron.ts isolated legs from EACH OTHER, but nothing
 * isolated a leg from itself — a pass running past the 60s tick overlapped
 * the next invocation (different isolate) and every queue-based leg
 * double-processed. The whole pass now claims its minute in Postgres
 * (discord_dedupe) before doing anything; the loser returns immediately.
 * Work inside the legs is additionally lease/claim-guarded, so a pass that
 * dies mid-flight self-heals on the next minute. */
export async function runBotCron(now: Date = new Date()): Promise<CronReport> {
 const report: CronReport = {
 webhookDeliveries: { processed: 0, delivered: 0, retried: 0, dead: 0 },
 webhookTailer: { events: 0, queued: 0 },
 sweep: { fired: 0, errors: 0 },
 audit: { ran: false, checked: 0, changed: 0, failed: 0 },
 rollup: { ran: false, metrics: 0 },
 tickets: { threaded: 0, staleClosed: 0, errors: 0 },
 dms: { sent: 0, failed: 0, skipped: 0 },
 deliveries: { alerted: 0, resolved: 0, staleMarked: 0, errors: 0 },
 analytics: {
  economy: { ran: false, day: null },
  retention: { ran: false, players: 0, days: 0 },
 },
 economyAlerts: { evaluated: false, day: null, alerted: 0, resolved: 0, open: [], errors: 0 },
 };
 // Minute-granular claim: one pass per wall-clock minute, fleet-wide.
 try {
 const minuteKey = `cron:pass:${now.toISOString().slice(0, 16)}`; // YYYY-MM-DDTHH:mm
 if (!(await claim(minuteKey))) {
 report.skipped = true;
 return report;
 }
 } catch (err) {
 // Claim infrastructure down: RUN anyway. Skipping a whole minute because
 // the dedupe table blipped is the "silent skip" half of B-39 — the legs'
 // own claims/leases/cursors are the correctness boundary, this gate is
 // only the overlap damper.
 logger.warn({ err: String(err) }, 'cron: pass claim failed — running unguarded (legs self-guard)');
 }
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
 // V6 02-06 Flow B: in-game/web tickets without a Discord thread get one; stale
 // tickets (open >48h with no staff response) auto-close. No-ops until the owner
 // sets TICKET_ENABLED/TICKET_CATEGORY_ID.
 const ticketReport = await runTicketSweep(config, now);
 report.tickets = ticketReport;
 // V6 DM notifications: deliver queued DMs to linked players (retry up to 3x)
 if (config.botToken) {
 try {
 const { processDmQueue } = await import('../api/v2/dms.js');
 const dms = await processDmQueue(config.botToken);
 report.dms = dms;
 } catch (err) {
 logger.error({ err: String(err) }, 'cron: DM queue crashed');
 }
 }
 // S2-D03: paid orders whose delivery command sat >24h unexecuted raise ONE
 // deduped Discord alert (D1 alerted_at); a later execution posts a resolve.
 try {
 const { runDeliveryAlertSweep } = await import('../alerts/deliveryAlerts.js');
 report.deliveries = await runDeliveryAlertSweep(now);
 } catch (err) {
 logger.error({ err: String(err) }, 'cron: delivery alert sweep crashed');
 }
 // S2-D05/S2-D07: the daily analytics leg — aggregates the finished day's
 // economy row (game MySQL -> economy_daily_row) and folds player state +
 // presence days into the retention tables. Self-guarded (00:06 UTC window,
 // per-day claims); no-ops outside the window, never throws.
 try {
 const { runAnalyticsDaily } = await import('../analytics/cronSync.js');
 report.analytics = await runAnalyticsDaily(now);
 } catch (err) {
 logger.error({ err: String(err) }, 'cron: analytics leg crashed');
 }
 // S2-D06: economy breach alerts — evaluates the STORED daily rows' breach
 // booleans (no game-DB dependency) at most once per UTC hour; deduped per
 // breach-window in D1 (economy_breach_state), resolve on recovery, armed
 // but silent while STAFF_ALERT_WEBHOOK_URL is unset. A failed hour
 // self-heals on the next (the evaluation is idempotent).
 try {
 const { runEconomyAlertEvaluation } = await import('../analytics/alerts.js');
 const hourKey = `analytics-econ-alerts:${now.toISOString().slice(0, 13)}`; // YYYY-MM-DDTHH
 if (await claim(hourKey)) {
 report.economyAlerts = await runEconomyAlertEvaluation(now);
 }
 } catch (err) {
 logger.error({ err: String(err) }, 'cron: economy alert leg crashed');
 }
 return report;
}
async function runTicketSweep(config: ReturnType<typeof getCronConfig>, now: Date): Promise<{ threaded: number; staleClosed: number; errors: number }> {
 const out = { threaded: 0, staleClosed: 0, errors: 0 };
 if (!config.ticketEnabled || !config.ticketCategoryId) return out;
 const { listTicketsV2, patchTicketV2 } = await import('./apiClient.js');
 const { createPrivateThread, addThreadMember, sendThreadMessage, setThreadArchived } = await import('./discordRest.js');
 const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
 const res = await listTicketsV2('open', since);
 if (!res.ok) {
 out.errors = 1;
 logger.warn({ status: res.status }, 'cron: ticket sweep list failed');
 return out;
 }
 for (const row of res.data.tickets.slice(0, 5)) {
 if (row.discord_thread_id) continue;
 try {
 const thread = await createPrivateThread(
 config.ticketCategoryId,
 ('#' + row.id + '-' + (row.username ?? 'player')).slice(0, 100),
 config.botToken,
 );
 if (!thread) { out.errors++; continue; }
 await sendThreadMessage(thread.id, config.botToken, {
 content:
 '**Ticket #' + row.id + '** (' + row.category + ') — ' + (row.username ?? row.uuid) + '\n' +
 '**' + row.subject + '**\n(Opened in-game — reply with /ticket reply id:' + row.id + ')',
 });
 const patched = await patchTicketV2(row.id, { discordThreadId: thread.id });
 if (!patched.ok) out.errors++;
 else out.threaded++;
 } catch {
 out.errors++;
 }
 }
 // Stale auto-close: open tickets older than 48h.
 const older = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();
 const staleRes = await listTicketsV2('open', undefined);
 if (staleRes.ok) {
 for (const row of staleRes.data.tickets) {
 if (Date.parse(row.created_at) >= Date.parse(older)) continue;
 try {
 await patchTicketV2(row.id, { status: 'stale' });
 if (row.discord_thread_id) {
 await sendThreadMessage(row.discord_thread_id, config.botToken, {
 content: 'Closed automatically after 48h of inactivity.',
 }).catch(() => undefined);
 await setThreadArchived(row.discord_thread_id, true, config.botToken).catch(() => undefined);
 }
 out.staleClosed++;
 } catch {
 out.errors++;
 }
 }
 }
 return out;
}
