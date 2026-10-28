/**
 * S2-D03 — failed-delivery alerting.
 *
 * A delivery command queued more than 24h without executing means a customer
 * PAID and did not get the thing (finding M-01's failure mode, which until
 * S2-D02 was invisible). The every-minute cron runs this sweep:
 *
 *   breach    — a ledger line with NO executed_at whose queued_at is older
 *               than 24h raises ONE Discord alert (deduped durably via the
 *               row's alerted_at — a seeded stale row produces exactly one
 *               alert, never a loop, and the dedupe survives isolate restarts
 *               because it lives in D1, not in memory);
 *   recovery  — a line that alerted and THEN executed posts one resolve and
 *               records resolved_at, so staff know it closed without digging.
 *
 * Transport: the STAFF_ALERT_WEBHOOK_URL Discord webhook — the same env the
 * utils/errorAlerts pipeline uses. Unset = alerting off (stale transitions
 * still persist so /admin/deliveries?status=stale stays truthful); arming the
 * webhook later alerts on still-unresolved breaches exactly once.
 *
 * Failure discipline: alerting must never take the API down — the webhook
 * POST is bounded, never throws, and mentions never resolve.
 */
import { env } from '../env.js';
import {
  STALE_AFTER_MS,
  effectiveStatus,
  ledgerLineAlerted,
  ledgerLineMarkedStale,
  ledgerLineResolved,
  listAllDeliveryLines,
  type DeliveryLineRow,
} from '../db/deliveryLedger.js';
import { logger } from '../utils/logger.js';

export interface DeliveryAlertReport {
  /** Breach alerts actually sent this pass. */
  alerted: number;
  /** Resolve notices actually sent this pass. */
  resolved: number;
  /** Lines whose persisted status moved pending -> stale this pass. */
  staleMarked: number;
  /** Alerting is configured (webhook URL set). */
  alertingConfigured: boolean;
  errors: number;
}

/** Per-pass ceilings so a backlogged ledger can't fan out into a webhook storm. */
const MAX_ALERTS_PER_PASS = 10;
const MAX_RESOLVES_PER_PASS = 20;

function webhookUrl(): string {
  try {
    return env.staffAlertWebhookUrl || '';
  } catch {
    return (
      (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
        ?.STAFF_ALERT_WEBHOOK_URL ?? ''
    );
  }
}

function fmtAge(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function commandKind(command: string): string {
  return command.split(' ')[0] ?? command;
}

async function postToStaffChannel(content: string): Promise<boolean> {
  const url = webhookUrl();
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content.slice(0, 1900), allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch (err) {
    logger.warn({ err: String(err) }, 'delivery alerts: webhook post failed');
    return false;
  }
}

function breachMessage(row: DeliveryLineRow, now: number): string {
  const label = row.pretty_id ? ` (${row.pretty_id})` : '';
  return [
    `**[STORE] Delivery stuck — order ${row.order_id}${label}**`,
    `\`${commandKind(row.command)}\` for ${row.sku_label ?? row.product_id} queued for **${fmtAge(now - row.queued_at)}** without executing` +
      (row.customer_uuid ? ` (buyer ${row.customer_uuid})` : '') +
      '.',
    row.status === 'failed' ? `Last failure: ${row.failed_reason ?? 'unknown'}.` : '',
    'The buyer has paid and does not have the item. Check the plugin/Redis bus, then re-trigger delivery; this alert resolves itself when the command executes.',
  ]
    .filter(Boolean)
    .join('\n');
}

function resolveMessage(row: DeliveryLineRow): string {
  const label = row.pretty_id ? ` (${row.pretty_id})` : '';
  return `**[STORE] Delivery resolved — order ${row.order_id}${label}** \`${commandKind(row.command)}\` for ${row.sku_label ?? row.product_id} has now executed.`;
}

/**
 * One sweep pass. Never throws — a ledger read failure is logged and
 * reported as an error count, never propagated into the cron.
 */
export async function runDeliveryAlertSweep(now: Date = new Date()): Promise<DeliveryAlertReport> {
  const report: DeliveryAlertReport = {
    alerted: 0,
    resolved: 0,
    staleMarked: 0,
    alertingConfigured: Boolean(webhookUrl()),
    errors: 0,
  };
  const nowMs = now.getTime();
  const cutoff = nowMs - STALE_AFTER_MS;

  let lines: DeliveryLineRow[];
  try {
    lines = await listAllDeliveryLines();
  } catch (err) {
    logger.error({ err: String(err) }, 'delivery alerts: ledger read failed');
    report.errors = 1;
    return report;
  }

  for (const row of lines) {
    // Persist the stale transition so the status filter sees it between sweeps.
    if (row.status === 'pending' && row.queued_at <= cutoff) {
      await ledgerLineMarkedStale(row.order_id, row.line_key);
      row.status = 'stale';
      report.staleMarked++;
    }

    const executed = row.executed_at !== null;

    // BREACH — queued >24h, never executed, not yet alerted.
    if (!executed && row.queued_at <= cutoff && row.alerted_at === null) {
      if (report.alerted >= MAX_ALERTS_PER_PASS) continue;
      const sent = await postToStaffChannel(breachMessage(row, nowMs));
      if (sent) {
        await ledgerLineAlerted(row.order_id, row.line_key, nowMs);
        row.alerted_at = nowMs;
        report.alerted++;
      } else if (!report.alertingConfigured) {
        // Alerting off: do NOT consume the breach — arming the webhook later
        // must still alert once on the still-stuck line.
      } else {
        // Configured but the post failed — retry next pass (still one alert
        // per breach window once it lands).
        report.errors++;
      }
      continue;
    }

    // RECOVERY — alerted, then executed, resolve not yet posted.
    if (executed && row.alerted_at !== null && row.resolved_at === null) {
      if (report.resolved >= MAX_RESOLVES_PER_PASS) continue;
      const sent = await postToStaffChannel(resolveMessage(row));
      if (sent) {
        await ledgerLineResolved(row.order_id, row.line_key, nowMs);
        row.resolved_at = nowMs;
        report.resolved++;
      } else if (report.alertingConfigured) {
        report.errors++;
      }
    }
  }

  if (report.alerted > 0 || report.resolved > 0) {
    logger.info(
      { alerted: report.alerted, resolved: report.resolved, staleMarked: report.staleMarked },
      'delivery alerts: sweep pass',
    );
  }
  return report;
}

/** Re-exported for tests/callers that want the threshold without the sweep. */
export { STALE_AFTER_MS, effectiveStatus };
