/**
 * Staff error alerts — the backend's leg of the error-visibility pipeline
 * (owner directive 2026-08-19: "no errors silenced — find them now").
 *
 * POSTs a short text line to the STAFF_ALERT_WEBHOOK_URL Discord webhook
 * (same URL family as the plugin's discord.webhook-url). No-op when the env
 * var is unset — Cloudflare dashboard → Workers → Settings → Variables.
 *
 * The URL resolves from the shared env module first (Workers bindings —
 * process.env is NOT injected there), falling back to process.env (Node host).
 * Read lazily per call so a warm isolate picks the value up after
 * initEnvFromBindings runs.
 *
 * Anti-spam contract (the plugin's ErrorReporterService has the same shape):
 *   - one immediate alert per SIGNATURE per 10 minutes;
 *   - repeats within the window are counted, not sent;
 *   - a hard cap of 10 distinct signatures per rolling minute.
 * Never throws, never blocks the caller — alerting must not take the API down
 * with it. Fire-and-forget callers can `void alertError(...)`.
 */
import { env } from '../env.js';

function webhookUrl(): string {
  try {
    return env.staffAlertWebhookUrl || '';
  } catch {
    // env not initialized (pre-boot / standalone script) — Node fallback.
    return (
      (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
        ?.STAFF_ALERT_WEBHOOK_URL ?? ''
    );
  }
}

interface SignatureState {
  count: number;
  lastSentMs: number;
}

const signatures = new Map<string, SignatureState>();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_MINUTE = 10;
let sentThisMinute = 0;
let minuteStart = Date.now();

/** Fold volatile detail (ids, numbers, trace ids) so recurrence groups into one line. */
function signatureOf(kind: string, detail: string): string {
  const normalized = detail
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\d+(\.\d+)?/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  return `${kind}: ${normalized}`;
}

export function alertError(kind: string, detail: string): void {
  const url = webhookUrl();
  if (!url) return;
  const now = Date.now();
  if (now - minuteStart > 60_000) {
    minuteStart = now;
    sentThisMinute = 0;
  }
  if (sentThisMinute >= MAX_PER_MINUTE) return;

  const sig = signatureOf(kind, detail);
  const state = signatures.get(sig);
  if (state) {
    state.count++;
    if (now - state.lastSentMs < WINDOW_MS) return; // counted, not re-sent
    state.lastSentMs = now;
  } else {
    signatures.set(sig, { count: 1, lastSentMs: now });
  }
  sentThisMinute++;

  const body =
    `**[STAFF] API ${kind}** — ${state && state.count > 1 ? `x${state.count} recent` : 'first sighting'}\n` +
    '```\n' +
    (detail.length > 1200 ? detail.slice(0, 1200) + '…' : detail) +
    '\n```';

  // Never await, never throw: the fetch is the LAST thing considered.
  void fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: body }),
    signal: AbortSignal.timeout(5000),
  }).catch((err: unknown) => {
    console.error('[errorAlerts] webhook post failed:', err instanceof Error ? err.message : err);
  });
}
