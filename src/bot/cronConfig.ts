/**
 * Bot-cron configuration (V6 02-05/02-07/02-09) — the env surface the
 * notification sweep, role sync, and analytics tick read. Ported from
 * imperium-discord's env.ts; everything is OPTIONAL and defaults to
 * disabled ('0'/empty), so deploying the cron before the owner sets the
 * Discord channel/role ids is a no-op that logs and moves on.
 *
 * Where values come from: the Worker's raw bindings (captured by
 * setCronBindings from the scheduled handler — secrets/vars are NOT in
 * process.env under Workers) and process.env when running under Node. Both
 * are merged, bindings winning.
 *
 * NOTIFY_ROUTES (JSON): {"war":{"channel":"123","role":"456"},...} — kinds:
 * war | colosseum | omen | season. role may be null.
 * ROLE_MAP_DONOR (JSON): {"EQUES":"123",...} — donor tier -> role id.
 * ROLE_MAP_PRESTIGE (JSON): {"5":"123","10":"456"} — milestone -> role id.
 */
import { env } from '../env.js';

export interface NotifyRoute {
  channel: string | null;
  role: string;
}

export interface CronConfig {
  botToken: string;
  guildId: string;
  seasonsEnabled: boolean;
  eventsFeedEnabled: boolean;
  omenCooldownMinutes: number;
  notifyMaxPerHour: number;
  voteReminderUtcHour: number;
  roleSyncEnabled: boolean;
  donorRoleMap: Record<string, string>;
  prestigeRoleMap: Record<string, string>;
  notifyRoutes: Record<string, { channel: string | null; role: string | null }>;
}

/** Raw Workers bindings as strings — set by the scheduled handler each
 *  invocation (they arrive on `env` there, not in process.env). */
let rawBindings: Record<string, string> = {};

export function setCronBindings(bindings: Record<string, unknown>): void {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(bindings)) {
    if (typeof v === 'string') out[k] = v;
  }
  rawBindings = out;
}

/** '0', '', and missing all mean "not configured" (the shared convention). */
function str(name: string): string | undefined {
  let value: string | undefined = rawBindings[name] || process.env[name];
  const v = value?.trim();
  return v && v !== '0' ? v : undefined;
}

function int(name: string, fallback: number): number {
  const v = str(name);
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function jsonRecord(name: string): Record<string, string> {
  const v = str(name);
  if (!v) return {};
  try {
    const parsed = JSON.parse(v) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof val === 'string' && /^\d{5,25}$/.test(val)) out[k] = val;
    }
    return out;
  } catch {
    return {};
  }
}

function jsonRoutes(name: string): Record<string, { channel: string | null; role: string | null }> {
  const v = str(name);
  if (!v) return {};
  try {
    const parsed = JSON.parse(v) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, { channel: string | null; role: string | null }> = {};
    for (const [kind, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (!val || typeof val !== 'object') continue;
      const rec = val as Record<string, unknown>;
      const channel = typeof rec.channel === 'string' && /^\d{5,25}$/.test(rec.channel) ? rec.channel : null;
      const role = typeof rec.role === 'string' && /^\d{5,25}$/.test(rec.role) ? rec.role : null;
      out[kind] = { channel, role };
    }
    return out;
  } catch {
    return {};
  }
}

/** Read lazily per call (the sweep runs once a minute; config changes land
 *  on the next tick without a redeploy — vars only need a Worker restart). */
export function getCronConfig(): CronConfig {
  let botToken: string | undefined;
  try {
    botToken = env.discord.botToken;
  } catch {
    botToken = undefined;
  }
  const routes = jsonRoutes('NOTIFY_ROUTES');
  const donor = jsonRecord('ROLE_MAP_DONOR');
  const prestige = jsonRecord('ROLE_MAP_PRESTIGE');
  return {
    botToken: botToken ?? process.env.DISCORD_BOT_TOKEN ?? '',
    guildId: str('DISCORD_GUILD_ID') ?? '0',
    seasonsEnabled: str('SEASONS_ENABLED') !== 'false',
    eventsFeedEnabled: str('EVENTS_FEED_ENABLED') === 'true',
    omenCooldownMinutes: int('OMEN_COOLDOWN_MINUTES', 60),
    notifyMaxPerHour: int('NOTIFY_MAX_PER_HOUR', 6),
    voteReminderUtcHour: int('VOTE_REMINDER_UTC_HOUR', 14),
    roleSyncEnabled: str('ROLE_SYNC_ENABLED') === 'true' && Object.keys(donor).length + Object.keys(prestige).length > 0,
    donorRoleMap: donor,
    prestigeRoleMap: prestige,
    notifyRoutes: routes,
  };
}

/** A notification kind's resolved route — NOTIFY_ROUTES first; null channel
 *  means the kind is unconfigured and the notification must NOT be claimed. */
export function routeFor(kind: 'war' | 'colosseum' | 'omen' | 'season', config: CronConfig): NotifyRoute {
  const routed = config.notifyRoutes[kind];
  if (routed?.channel) {
    return { channel: routed.channel, role: routed.role ?? '0' };
  }
  return { channel: null, role: '0' };
}
