import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B-39 — claim-based cron execution, tailer idempotency, rollup catch-up,
 * per-user vote fanout:
 *   1. A cron pass claims its minute; the loser skips without touching legs.
 *      A claim-infrastructure failure runs anyway (no silent minute loss).
 *   2. The tailer emits event ids derived from web_events row ids, so a
 *      forced rescan re-emits identical ids (the delivery queue's
 *      (subscriber_id, event_id) PK + ON CONFLICT collapses them).
 *   3. Rollup: whole-hour catch-up window (00:05–00:59), per-day claims —
 *      a day missed at 00:05 heals later in the window.
 *   4. Vote fanout claims per user; failed sends release for retry within
 *      the widened first-15-minutes window.
 *
 * The delivery loop's own row-claim SQL is covered separately in
 * webhooks.test.ts territory via runDeliveryTick; here the pass-level claim
 * and the leg semantics are the subject.
 */

const { claimResults, releaseLog, voteUsers } = vi.hoisted(() => ({
  claimResults: new Map<string, boolean>(),
  releaseLog: [] as string[],
  voteUsers: [] as string[],
}));

vi.mock('../bot/botdb.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../bot/botdb.js')>();
  return {
    ...actual,
    claim: vi.fn(async (key: string) => claimResults.get(key) ?? true),
    release: vi.fn(async (key: string) => {
      releaseLog.push(key);
    }),
    listVoteReminderUsers: vi.fn(async () => [...voteUsers]),
    getPrefs: vi.fn(async () => ({ dmEvents: false })),
    getDiscordIdForUuid: vi.fn(async () => null),
    pageLinkedMembers: vi.fn(async () => []),
  };
});

vi.mock('../webhooks/deliver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../webhooks/deliver.js')>();
  return {
    ...actual,
    runDeliveryTick: vi.fn(async () => ({ processed: 0, delivered: 0, retried: 0, dead: 0 })),
    emit: vi.fn(async () => 0),
  };
});

vi.mock('../bot/discordRest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../bot/discordRest.js')>();
  return {
    ...actual,
    sendDirectMessage: vi.fn(async () => true),
    sendChannelMessage: vi.fn(async () => true),
  };
});

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    query: vi.fn(async () => ({ rows: [] })),
    getDiscordIdByUuid: vi.fn(async () => null),
    getD1: vi.fn(() => ({
      prepare() {
        return {
          bind() {
            return { run: async () => ({ meta: { changes: 1 } }), first: async <T>() => null as T | null };
          },
          async run() {
            return { meta: { changes: 1 } };
          },
          async first<T>() {
            return null as T | null;
          },
          async all<T>() {
            return { results: [] as T[] };
          },
        };
      },
      async batch() {
        return [];
      },
    })),
  };
});

import { runBotCron } from '../bot/cron.js';
import { runDailyRollup } from '../bot/analytics/rollup.js';
import { runNotificationSweep } from '../bot/notify/scheduler.js';
import { runEventsTailer } from '../webhooks/tailer.js';
import { claim } from '../bot/botdb.js';
import { runDeliveryTick, emit } from '../webhooks/deliver.js';
import { sendDirectMessage } from '../bot/discordRest.js';
import { __resetEnvForTests, initEnvFromBindings } from '../env.js';
import type { CronConfig } from '../bot/cronConfig.js';

beforeAll(() => {
  __resetEnvForTests();
  initEnvFromBindings({
    JWT_SECRET: 'test-jwt-secret-0123456789abcdef',
    DISCORD_CLIENT_ID: '1',
    DISCORD_CLIENT_SECRET: 'x',
    WEBPANEL_HMAC_SECRET: 'hmac',
    PAYNOW_API_KEY: 'pk',
    PAYNOW_STORE_ID: '1',
    PAYNOW_WEBHOOK_SECRETS: 'whsec',
  } as unknown as Record<string, unknown>);
});

beforeEach(() => {
  vi.clearAllMocks();
  releaseLog.length = 0;
  claimResults.clear();
  voteUsers.length = 0;
});

describe('B-39 whole-pass claim', () => {
  it('a pass that loses its minute-claim skips every leg', async () => {
    const now = new Date('2026-09-05T12:00:00Z');
    claimResults.set(`cron:pass:${now.toISOString().slice(0, 16)}`, false);
    const report = await runBotCron(now);
    expect(report.skipped).toBe(true);
    expect(runDeliveryTick).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('a pass that wins the claim runs its legs', async () => {
    const now = new Date('2026-09-05T12:01:00Z');
    claimResults.set(`cron:pass:${now.toISOString().slice(0, 16)}`, true);
    const report = await runBotCron(now);
    expect(report.skipped).toBeUndefined();
    expect(runDeliveryTick).toHaveBeenCalled();
  });

  it('a failed claim infrastructure runs anyway (no silent minute loss)', async () => {
    const now = new Date('2026-09-05T12:02:00Z');
    vi.mocked(claim).mockRejectedValueOnce(new Error('pg down'));
    const report = await runBotCron(now);
    expect(report.skipped).toBeUndefined();
    expect(runDeliveryTick).toHaveBeenCalled();
  });
});

describe('B-39 tailer idempotency', () => {
  it('emits event ids derived from the web_events row id', async () => {
    vi.mocked(emit).mockResolvedValue(1);
    const { query } = await import('../db/pool.js');
    vi.mocked(query).mockResolvedValue({
      rows: [
        { id: 9001, event_type: 'player_rankup', uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', message: 'player=Sextus from=9 to=10', at: new Date() },
      ],
    } as never);
    const report = await runEventsTailer();
    expect(report.scanned).toBe(1);
    expect(emit).toHaveBeenCalledOnce();
    const args = vi.mocked(emit).mock.calls[0]!;
    expect(args[0]).toMatchObject({ type: 'player.rankup' });
    expect(args[1]).toBe('wev:9001'); // deterministic — a rescan re-emits THIS id
  });
});

describe('B-39 rollup catch-up window', () => {
  it('rolls unclaimed days inside the 00:05–00:59 window, not just at 00:05', async () => {
    const now = new Date('2026-09-05T00:10:00Z');
    const yesterday = '2026-09-04';
    // All older days already claimed (done on previous days) — only yesterday
    // is outstanding.
    for (let back = 2; back <= 7; back += 1) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - back);
      claimResults.set(`rollup:${d.toISOString().slice(0, 10)}`, false);
    }
    claimResults.set(`rollup:${yesterday}`, true);
    const { query } = await import('../db/pool.js');
    vi.mocked(query).mockImplementation((async (sql: string) => {
      if (String(sql).includes('bot_command_log')) {
        return { rows: [{ discord_id: 'u1', command: 'balance', outcome: 'ok', duration_ms: 10 }] };
      }
      return { rows: [] };
    }) as unknown as typeof query);
    const report = await runDailyRollup(now);
    expect(report.ran).toBe(true);
    expect(report.day).toBe(yesterday);
    // Exactly the unclaimed day did log-reading work (the retention DELETE
    // also mentions bot_command_log — count SELECTs only).
    const logReads = vi.mocked(query).mock.calls.filter(([sql]) => String(sql).startsWith('SELECT') && String(sql).includes('bot_command_log')).length;
    expect(logReads).toBe(1);
  });

  it('a day missed at 00:05 is picked up at 00:07 (the catch-up itself)', async () => {
    const now = new Date('2026-09-05T00:07:00Z');
    const yesterday = '2026-09-04';
    claimResults.set(`rollup:${yesterday}`, true);
    for (let back = 2; back <= 7; back += 1) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - back);
      claimResults.set(`rollup:${d.toISOString().slice(0, 10)}`, false);
    }
    const { query } = await import('../db/pool.js');
    vi.mocked(query).mockImplementation((async () => ({ rows: [] })) as unknown as typeof query);
    const report = await runDailyRollup(now);
    expect(report.ran).toBe(true);
    expect(report.day).toBe(yesterday);
  });

  it('outside the window nothing runs', async () => {
    expect((await runDailyRollup(new Date('2026-09-05T00:04:00Z'))).ran).toBe(false);
    expect((await runDailyRollup(new Date('2026-09-05T01:10:00Z'))).ran).toBe(false);
    expect((await runDailyRollup(new Date('2026-09-05T13:00:00Z'))).ran).toBe(false);
  });
});

describe('B-39 per-user vote fanout', () => {
  function voteConfig(): CronConfig {
    return {
      botToken: 'tok',
      guildId: '0',
      seasonsEnabled: false,
      eventsFeedEnabled: false,
      omenCooldownMinutes: 60,
      notifyMaxPerHour: 6,
      voteReminderUtcHour: 14,
      roleSyncEnabled: false,
      donorRoleMap: {},
      prestigeRoleMap: {},
      notifyRoutes: {},
      ticketEnabled: false,
      ticketCategoryId: '',
      ticketStaffRoleId: '',
    };
  }

  it('claims per user; failed sends release for retry within the window', async () => {
    voteUsers.push('user1', 'user2');
    vi.mocked(sendDirectMessage)
      .mockResolvedValueOnce(true)   // user1 succeeds
      .mockResolvedValueOnce(false); // user2 fails
    const report = await runNotificationSweep(voteConfig(), new Date('2026-09-05T14:00:00Z'));
    expect(report.voteDms).toBe(1);
    expect(sendDirectMessage).toHaveBeenCalledTimes(2);
    // user2's claim was released so the :01..:14 ticks retry them.
    expect(releaseLog).toContain('vote:2026-09-05:user2');
    expect(releaseLog).not.toContain('vote:2026-09-05:user1');
  });

  it('already-claimed users are skipped on a later tick in the window', async () => {
    voteUsers.push('user1');
    claimResults.set('vote:2026-09-05:user1', false);
    const report = await runNotificationSweep(voteConfig(), new Date('2026-09-05T14:05:00Z'));
    expect(report.voteDms).toBe(0);
    expect(sendDirectMessage).not.toHaveBeenCalled();
  });

  it('the window is the first 15 minutes, not a single minute', async () => {
    voteUsers.push('user1');
    await runNotificationSweep(voteConfig(), new Date('2026-09-05T14:14:00Z'));
    expect(sendDirectMessage).toHaveBeenCalledTimes(1);
    voteUsers.length = 0;
    voteUsers.push('user2');
    await runNotificationSweep(voteConfig(), new Date('2026-09-05T14:15:00Z'));
    expect(sendDirectMessage).toHaveBeenCalledTimes(1); // :15 is outside — user2 got nothing
  });
});
