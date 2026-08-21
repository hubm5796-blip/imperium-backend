/**
 * Notification sweep (V6 02-05) — ported from imperium-discord into the
 * backend worker so it actually deploys (the standalone repo has no
 * auto-deploy path). Runs on the every-minute cron.
 *
 * Exactly-once guarantee: every notification claims a dedupe key in Postgres
 * BEFORE sending. A claim that wins fires the send; if the send then fails
 * the key is released so the next sweep retries (at-least-once delivery,
 * at-most-once success path — a never-duplicated ping).
 *
 * Sources:
 *  - war 30/5-min warnings + colosseum signup deadlines: /api/seasons/current
 *  - omen impact: festival state from the same call, role-gated + cooldown
 *  - season rollover + end warnings (edge-triggered via bot_state)
 *  - daily vote reminder: opt-in DMs (discord_dm_prefs), one fanout per UTC day
 *  - personal events: /api/events/feed (flag-gated)
 */
import { getSeasonsCurrent, getEventsFeed } from '../apiClient.js';
import {
  claim,
  release,
  claimedWithin,
  countClaimedWithin,
  getState,
  setState,
  getPrefs,
  listVoteReminderUsers,
  getDiscordIdForUuid,
} from '../botdb.js';
import { sendChannelMessage, sendDirectMessage } from '../discordRest.js';
import { routeFor, type CronConfig, type NotifyRoute } from '../cronConfig.js';

export interface SweepReport {
  war30: number;
  war5: number;
  colosseum: number;
  omen: number;
  season: number;
  voteDms: number;
  eventDms: number;
  errors: string[];
}

interface CalendarEvent {
  id: string;
  type: string;
  name: string;
  startsAt: string;
  signupDeadline?: string | null;
}

interface FeedEvent {
  id: string;
  type: string;
  uuid: string;
  message: string;
}

/** Minutes until an ISO timestamp (negative = past). */
function minutesUntil(iso: string, now: Date): number {
  return (Date.parse(iso) - now.getTime()) / 60_000;
}

function rolePing(roleId: string): string {
  return roleId !== '0' ? `<@&${roleId}>` : '';
}

/** Conditional spread for the allowed_mentions role allowlist (empty = no ping). */
function mentionRoles(roleId: string): Record<string, never> | { allowedMentionRoles: string[] } {
  return roleId !== '0' ? { allowedMentionRoles: [roleId] } : {};
}

export function warWarningContent(eventName: string, startsAt: string, minutes: number, roleId: string): string {
  const ts = Math.floor(Date.parse(startsAt) / 1000);
  return (
    `${rolePing(roleId)} :crossed_swords: **${eventName}** starts <t:${ts}:R> ` +
    `(<t:${ts}:T>) — ${minutes} minute${minutes === 1 ? '' : 's'} to muster. Get to the war camp!`
  ).trim();
}

export function colosseumDeadlineContent(event: CalendarEvent): string {
  const ts = Math.floor(Date.parse(event.signupDeadline!) / 1000);
  return (
    `:classical_building: **${event.name}** — signups close <t:${ts}:R>! ` +
    `Sign up in-game before the gates shut.`
  );
}

export function omenContent(name: string, impact: string | undefined, roleId: string): string {
  return (
    `${rolePing(roleId)} :eye: **Omen rises: ${name}**` +
    (impact ? `\nImpact: ${impact}` : '') +
    `\nMine carefully — the odds have shifted.`
  );
}

export function voteReminderContent(): string {
  return ':ballot_box: **Daily vote reminder** — your votes keep the empire growing. Vote at every listing, then claim in-game with `/vote`.';
}

export function personalEventContent(message: string): string {
  return `:envelope: ${message}`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : 'error';
}

/** Claim-then-send-then-release-on-failure. Returns true when sent. Never
 *  throws: a Postgres error on claim/release/send lands in report.errors and
 *  the sweep continues — one bad dedupe row must not cancel a minute of
 *  war/omen/vote notifications. */
async function fireOnce(
  botToken: string,
  key: string,
  send: () => Promise<boolean>,
  report: SweepReport,
): Promise<boolean> {
  let claimed = false;
  try {
    claimed = await claim(key);
    if (!claimed) return false; // someone already fired it
    const sent = await send();
    if (!sent) {
      await release(key).catch((err: unknown) => {
        // Unreleased failed send = the key stays claimed and the notification
        // is never retried. Log it so exactly-once doesn't become exactly-zero.
        report.errors.push(`release failed after send failure ${key}: ${errText(err)}`);
      });
      report.errors.push(`send failed: ${key}`);
      return false;
    }
    return true;
  } catch (err) {
    if (claimed) {
      await release(key).catch((err2: unknown) => {
        report.errors.push(`release failed ${key}: ${errText(err2)}`);
      });
    }
    report.errors.push(`${key}: ${errText(err)}`);
    return false;
  }
}

/** fireOnce + routing discipline (V6 02-05):
 *  - unconfigured route → return WITHOUT claiming (a claimed-but-never-sent
 *    key used to permanently eat the notification once the channel was set
 *    mid-event);
 *  - per-kind hourly ceiling → drop with an error-line so a buggy feed can't
 *    wallpaper the channel. Ceiling-read failures fail OPEN: availability
 *    over spam-protection;
 *  - send failure → release for retry (fireOnce's unchanged guarantee). */
async function fireRouted(
  botToken: string,
  kind: 'war' | 'colosseum' | 'omen' | 'season',
  key: string,
  route: NotifyRoute,
  config: CronConfig,
  now: Date,
  send: (channel: string, role: string) => Promise<boolean>,
  report: SweepReport,
): Promise<boolean> {
  if (!route.channel) return false; // unconfigured — never claim
  try {
    const recent = await countClaimedWithin(`${kind}:`, 60, now);
    if (recent >= config.notifyMaxPerHour) {
      report.errors.push(`${kind} hourly ceiling hit (${recent} in window) — dropped ${key}`);
      return false;
    }
  } catch (err) {
    report.errors.push(`${kind} ceiling check failed: ${errText(err)}`);
  }
  return fireOnce(botToken, key, () => send(route.channel!, route.role), report);
}

/** Sweep entry point. Never throws — a failed source is logged and skipped. */
export async function runNotificationSweep(config: CronConfig, now: Date): Promise<SweepReport> {
  const report: SweepReport = {
    war30: 0, war5: 0, colosseum: 0, omen: 0, season: 0, voteDms: 0, eventDms: 0, errors: [],
  };
  const botToken = config.botToken;

  // ---- Events calendar: war warnings + colosseum deadlines + omen festival
  if (config.seasonsEnabled) {
    const res = await getSeasonsCurrent();
    if (res.ok) {
      for (const event of (res.data.events ?? []) as CalendarEvent[]) {
        const start = minutesUntil(event.startsAt, now);
        const warRoute = routeFor('war', config);
        if (event.type === 'war' && start > 0 && warRoute.channel) {
          if (start <= 30 && start > 24) {
            const sent = await fireRouted(botToken, 'war', `war:${event.id}:30`, warRoute, config, now, (ch, role) =>
              sendChannelMessage(ch, botToken, {
                content: warWarningContent(event.name, event.startsAt, 30, role),
                ...mentionRoles(role),
              }), report);
            if (sent) report.war30++;
          }
          if (start <= 5 && start > 0) {
            const sent = await fireRouted(botToken, 'war', `war:${event.id}:5`, warRoute, config, now, (ch, role) =>
              sendChannelMessage(ch, botToken, {
                content: warWarningContent(event.name, event.startsAt, 5, role),
                ...mentionRoles(role),
              }), report);
            if (sent) report.war5++;
          }
        }
        const colosseumRoute = routeFor('colosseum', config);
        if (event.type === 'colosseum' && event.signupDeadline && colosseumRoute.channel) {
          const deadline = minutesUntil(event.signupDeadline, now);
          if (deadline <= 30 && deadline > 0) {
            const sent = await fireRouted(botToken, 'colosseum', `colosseum:${event.id}:signup`, colosseumRoute, config, now, (ch) =>
              sendChannelMessage(ch, botToken, {
                content: colosseumDeadlineContent(event),
              }), report);
            if (sent) report.colosseum++;
          }
        }
      }

      // Omen: role-gated ping, cooldown across ALL omen keys.
      const festival = res.data.festival as { id: string; active: boolean; name: string; impact?: string } | undefined;
      const omenRoute = routeFor('omen', config);
      if (festival?.active && omenRoute.channel) {
        let withinCooldown = false;
        try {
          withinCooldown = await claimedWithin('omen:', config.omenCooldownMinutes, now);
        } catch (err) {
          report.errors.push(`omen cooldown check failed: ${errText(err)}`);
        }
        if (!withinCooldown) {
          const sent = await fireRouted(botToken, 'omen', `omen:${festival.id}`, omenRoute, config, now, (ch, role) =>
            sendChannelMessage(ch, botToken, {
              content: omenContent(festival.name, festival.impact, role),
              ...mentionRoles(role),
            }), report);
          if (sent) report.omen++;
        }
      }

      // Season rollover + end warnings. Identity is season number+name
      // persisted in bot_state; edge-triggered like war — each boundary fires
      // exactly once via its dedupe key.
      const season = res.data.season as
        | { number?: number; name?: string; endsAt?: string | null }
        | undefined;
      const seasonRoute = routeFor('season', config);
      if (season?.name && seasonRoute.channel) {
        const seasonKey = String(season.number ?? season.name);
        const lastSeason = await getState<string>('last_season_id').catch(() => null);
        if (lastSeason !== seasonKey) {
          const sent = await fireRouted(botToken, 'season', `season:${seasonKey}:announce`, seasonRoute, config, now, (ch, role) =>
            sendChannelMessage(ch, botToken, {
              content:
                `${rolePing(role)} `.trim() +
                `:hourglass_flowing_sand: A new season dawns — **${season.name}**` +
                (season.endsAt ? ` (ends <t:${Math.floor(Date.parse(season.endsAt) / 1000)}:R>)` : '') +
                '. Check /next for the opening events.',
              ...mentionRoles(role),
            }), report);
          if (sent) {
            report.season++;
            await setState('last_season_id', seasonKey).catch(() => {});
          }
        }
        if (season.endsAt) {
          const minsLeft = minutesUntil(season.endsAt, now);
          if (minsLeft <= 24 * 60 && minsLeft > 23 * 60) {
            await fireRouted(botToken, 'season', `season:${seasonKey}:end24`, seasonRoute, config, now, (ch, role) =>
              sendChannelMessage(ch, botToken, {
                content: `${rolePing(role)} `.trim() + ':warning: The season ends in ~24 hours — spend rewards while they count.',
                ...mentionRoles(role),
              }), report);
          }
          if (minsLeft <= 60 && minsLeft > 0) {
            await fireRouted(botToken, 'season', `season:${seasonKey}:end1h`, seasonRoute, config, now, (ch, role) =>
              sendChannelMessage(ch, botToken, {
                content: `${rolePing(role)} `.trim() + ':hourglass: One hour left in the season.',
                ...mentionRoles(role),
              }), report);
          }
        }
      }
    } else {
      report.errors.push(`seasons/current: ${res.status} ${res.message}`);
    }
  }

  // ---- Daily vote reminder (opt-in) at the configured UTC hour.
  if (now.getUTCHours() === config.voteReminderUtcHour && now.getUTCMinutes() === 0) {
    const dateKey = now.toISOString().slice(0, 10);
    try {
      if (await claim(`vote:${dateKey}`)) {
        const users = await listVoteReminderUsers();
        for (const userId of users) {
          const sent = await sendDirectMessage(botToken, userId, { content: voteReminderContent() });
          if (sent) report.voteDms++;
          else report.errors.push(`vote dm failed: ${userId}`);
        }
      }
    } catch (err) {
      // A failed claim (Postgres error) must not look like "already claimed" —
      // that distinction is invisible, but at least it lands in the report.
      report.errors.push(`vote reminder fanout failed: ${errText(err)}`);
    }
  }

  // ---- Personal event DMs (opt-in) from the events feed.
  if (config.eventsFeedEnabled) {
    const since = new Date(now.getTime() - 5 * 60_000).toISOString();
    const feed = await getEventsFeed(since);
    if (feed.ok) {
      for (const event of (feed.data.events ?? []) as FeedEvent[]) {
        let discordId: string | null;
        try {
          discordId = await getDiscordIdForUuid(event.uuid);
        } catch (err) {
          // A DB outage must not read as "player has no Discord" — every
          // event DM would be silently skipped with no trace.
          report.errors.push(`link lookup failed for ${event.uuid}: ${errText(err)}`);
          continue;
        }
        if (!discordId) continue; // player has no Discord linked
        let prefs;
        try {
          prefs = await getPrefs(discordId);
        } catch (err) {
          report.errors.push(`prefs lookup failed for ${discordId}: ${errText(err)}`);
          continue;
        }
        if (!prefs.dmEvents) continue; // opted out / never opted in
        const sent = await fireOnce(botToken, `dm:${event.type}:${event.id}`, () =>
          sendDirectMessage(botToken, discordId, {
            content: personalEventContent(event.message),
          }), report);
        if (sent) report.eventDms++;
      }
    } else {
      report.errors.push(`events feed: ${feed.status} ${feed.message}`);
    }
  }

  return report;
}
