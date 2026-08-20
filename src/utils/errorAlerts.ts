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

  sendToWebhook(url, body);
  sendOwnerDm(body);
}

function sendToWebhook(url: string, body: string): void {
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

// ── OWNER DM (owner directive 2026-08-19: "get stuff sent to the vcorleone01 discord
//    account by the bot") ────────────────────────────────────────────────────────────────
// The bot DMs the owner directly in addition to the staff webhook, so critical alerts land
// even when nobody is watching a channel. The owner's Discord user id resolves once and is
// cached: OWNER_DISCORD_ID env when set, else a guild-member search by username
// (OWNER_DISCORD_USERNAME, default "vcorleone01") using the bot's own token. Every failure
// degrades to "no DM" — alerting must never take the API down with it.

const OWNER_USERNAME_DEFAULT = 'vcorleone01';
let ownerDmChannelId: string | null = null;
let ownerResolvePromise: Promise<string | null> | null = null;
let ownerResolvedAt = 0;
const OWNER_RERESOLVE_MS = 60 * 60 * 1000;

function ownerUsername(): string {
  try {
    return env.ownerDiscordUsername || OWNER_USERNAME_DEFAULT;
  } catch {
    return OWNER_USERNAME_DEFAULT;
  }
}

function botToken(): string {
  try {
    return env.discord.botToken || '';
  } catch {
    return '';
  }
}

async function discordJson(path: string, init?: RequestInit): Promise<unknown | null> {
  const token = botToken();
  if (!token) return null;
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    ...init,
    headers: {
      ...(init?.headers as Record<string, string> | undefined),
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  const text = await res.text();
  return text ? (JSON.parse(text) as unknown) : null;
}

/** Resolve the owner's DM channel id (creates/reuses the DM channel), cached 1h. */
async function resolveOwnerDmChannel(): Promise<string | null> {
  const now = Date.now();
  if (ownerDmChannelId && now - ownerResolvedAt < OWNER_RERESOLVE_MS) return ownerDmChannelId;
  if (ownerResolvePromise) return ownerResolvePromise;

  const attempt = (async () => {
    try {
      let userId = '';
      try {
        userId = env.ownerDiscordId || '';
      } catch {
        userId = '';
      }
      if (!userId) {
        // Username search across the bot's mutual guilds.
        const guilds = (await discordJson('/users/@me/guilds')) as { id: string }[] | null;
        if (Array.isArray(guilds)) {
          const wanted = ownerUsername().toLowerCase();
          outer: for (const g of guilds) {
            const found = (await discordJson(
              `/guilds/${g.id}/members?limit=25&query=${encodeURIComponent(ownerUsername())}`,
            )) as { user?: { id?: string; username?: string } }[] | null;
            if (!Array.isArray(found)) continue;
            for (const m of found) {
              if ((m.user?.username ?? '').toLowerCase() === wanted) {
                userId = m.user!.id!;
                break outer;
              }
            }
          }
        }
      }
      if (!userId) return null;
      const dm = (await discordJson('/users/@me/channels', {
        method: 'POST',
        body: JSON.stringify({ recipient_id: userId }),
      })) as { id?: string } | null;
      if (!dm?.id) return null;
      ownerDmChannelId = dm.id;
      ownerResolvedAt = Date.now();
      return dm.id;
    } catch {
      return null;
    }
  })();
  ownerResolvePromise = attempt;
  const result = await attempt;
  ownerResolvePromise = null;
  return result;
}

function sendOwnerDm(body: string): void {
  void (async () => {
    const channelId = await resolveOwnerDmChannel();
    if (!channelId) return;
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${botToken()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content: body.slice(0, 1900), allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok && (res.status === 403 || res.status === 404)) {
      // DM channel closed/user gone — drop the cache so the next alert re-resolves.
      ownerDmChannelId = null;
    }
  })().catch(() => undefined);
}
