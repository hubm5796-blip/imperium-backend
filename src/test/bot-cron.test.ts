/**
 * V6 02-05/02-09 port pins — the pure logic the backend bot's cron relies on:
 * analytics aggregation (aggregateDay) and the NOTIFY_ROUTES parsing/routing
 * discipline (unconfigured kinds must NEVER claim a dedupe key).
 */
import { describe, expect, it } from 'vitest';
import { aggregateDay } from '../bot/analytics/rollup.js';
import { routeFor, type CronConfig } from '../bot/cronConfig.js';

function baseConfig(overrides: Partial<CronConfig> = {}): CronConfig {
  return {
    botToken: 'test-token',
    guildId: '123',
    seasonsEnabled: true,
    eventsFeedEnabled: false,
    omenCooldownMinutes: 60,
    notifyMaxPerHour: 6,
    voteReminderUtcHour: 14,
    roleSyncEnabled: false,
    donorRoleMap: {},
    prestigeRoleMap: {},
    notifyRoutes: {},
    ...overrides,
  };
}

describe('aggregateDay (02-09 rollup fold)', () => {
  it('counts executions, errors, unique users, and p95 per command', () => {
    const rows = [
      { discord_id: '1', command: 'balance', outcome: 'ok', duration_ms: 100 },
      { discord_id: '1', command: 'balance', outcome: 'ok', duration_ms: 200 },
      { discord_id: '2', command: 'balance', outcome: 'error:x', duration_ms: 400 },
      { discord_id: '2', command: 'stats', outcome: 'ok', duration_ms: 50 },
    ];
    const out = aggregateDay(rows);
    const get = (metric: string, command: string) =>
      out.find((a) => a.metric === metric && a.command === command)?.value;

    expect(get('commands', 'balance')).toBe(3);
    expect(get('errors', 'balance')).toBe(1);
    expect(get('commands', 'stats')).toBe(1);
    // p95 of [100,200,400] = nearest-rank ceil(0.95*3)=3 -> 400.
    expect(get('p95_ms', 'balance')).toBe(400);
    // Window-level aggregates use the command-less rows.
    expect(get('commands', '')).toBe(4);
    expect(get('unique_users', '')).toBe(2);
    expect(get('avg_ms', '')).toBe(Math.round(750 / 4));
  });

  it('emits nothing for an empty day', () => {
    expect(aggregateDay([])).toEqual([]);
  });
});

describe('routeFor (02-05 routing discipline)', () => {
  it('returns a null channel for unconfigured kinds — the caller must not claim', () => {
    const config = baseConfig();
    expect(routeFor('war', config)).toEqual({ channel: null, role: '0' });
    expect(routeFor('season', config)).toEqual({ channel: null, role: '0' });
  });

  it('resolves configured kinds with their role', () => {
    const config = baseConfig({
      notifyRoutes: { war: { channel: '111', role: '222' }, omen: { channel: '333', role: null } },
    });
    expect(routeFor('war', config)).toEqual({ channel: '111', role: '222' });
    expect(routeFor('omen', config)).toEqual({ channel: '333', role: '0' });
  });
});
