import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B-38 — the alert SINK hardening (the route lives in routes.ts, owned by the
 * parallel agent; everything assertable from here):
 *   1. `kind` is allowlisted before it reaches routing/presentation —
 *      free-form kinds can no longer forge "[STAFF] API <anything>" headers.
 *   2. Alert posts carry allowed_mentions {parse: []} — injected @everyone in
 *      caller-supplied detail must never resolve into a ping.
 *   3. Caps: per-signature 10-min dedupe, 10/min, and the new 60/hour
 *      distinct-signature ceiling.
 */

let posts: Array<{ url: string; body: Record<string, unknown> }>;

beforeEach(() => {
  posts = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
    posts.push({
      url: String(url),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
    });
    return new Response('{}', { status: 200 });
  }));
  process.env.STAFF_ALERT_WEBHOOK_URL = 'https://discord.example/staff-hook';
});

// env throws when uninitialized — that's the documented Node fallback path
// (webhookUrl() reads process.env), which is exactly what these tests use.

import { alertError, sanitizeAlertKind, __resetAlertStateForTests } from '../utils/errorAlerts.js';

beforeEach(() => {
  __resetAlertStateForTests();
});

describe('B-38 kind allowlist', () => {
  it('identifier-shaped kinds pass through', () => {
    expect(sanitizeAlertKind('plugin-error')).toBe('plugin-error');
    expect(sanitizeAlertKind('EconomyJob.FAILURE_2')).toBe('EconomyJob.FAILURE_2');
    expect(sanitizeAlertKind('store:webhook')).toBe('store:webhook');
  });

  it('garbage folds to plugin-error (routing can no longer be poisoned)', () => {
    expect(sanitizeAlertKind('')).toBe('plugin-error');
    expect(sanitizeAlertKind('  ')).toBe('plugin-error');
    expect(sanitizeAlertKind('@everyone look here')).toBe('plugin-error');
    expect(sanitizeAlertKind('x')).toBe('plugin-error'); // too short
    expect(sanitizeAlertKind('e'.repeat(61))).toBe('plugin-error'); // too long
    expect(sanitizeAlertKind('kind\nwith newlines')).toBe('plugin-error');
  });

  it('the rendered alert header uses the sanitized kind', async () => {
    alertError('INJECT **bold** @everyone', 'detail here');
    await new Promise((r) => setTimeout(r, 20));
    expect(posts).toHaveLength(1);
    expect(String(posts[0]!.body.content)).toContain('API plugin-error');
    expect(String(posts[0]!.body.content)).not.toContain('INJECT');
  });
});

describe('B-38 alert posts never resolve mentions', () => {
  it('the staff webhook post carries allowed_mentions {parse: []}', async () => {
    alertError('plugin-error', 'boom @everyone and @here too');
    await new Promise((r) => setTimeout(r, 20));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body.allowed_mentions).toEqual({ parse: [] });
  });
});

describe('B-38 caps', () => {
  it('repeats within the window are counted, not re-sent', async () => {
    alertError('plugin-error', 'same failure');
    alertError('plugin-error', 'same failure');
    alertError('plugin-error', 'same failure');
    await new Promise((r) => setTimeout(r, 20));
    expect(posts).toHaveLength(1);
    expect(String(posts[0]!.body.content)).toContain('first sighting'); // deduped before the count could grow
  });

  it('more than 10 distinct signatures in a minute stop at 10 posts', async () => {
    // Letters, not numbers — signatureOf folds digits to N, so numeric
    // variation would collapse into one signature and exercise dedupe
    // instead of the minute cap.
    for (let i = 0; i < 15; i++) {
      alertError('plugin-error', `distinct failure variant ${String.fromCharCode(65 + i)}`);
    }
    await new Promise((r) => setTimeout(r, 30));
    expect(posts).toHaveLength(10);
  });

  it('the hourly ceiling holds even when the minute window rolls', async () => {
    // Send 10 (minute cap), force the minute window over, send 10 more…
    // hour cap is 60 — simulate by rolling the minute 6 times.
    const realNow = Date.now;
    let skew = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
    try {
      for (let round = 0; round < 7; round++) {
        skew = (round + 1) * 61_000; // each round lands in a fresh minute
        for (let i = 0; i < 10; i++) {
          alertError('plugin-error', `hourly probe r${String.fromCharCode(65 + round)} v${String.fromCharCode(65 + i)}`);
        }
      }
      await new Promise((r) => setTimeout(r, 30));
      // 7 rounds x 10 would be 70; the hour cap stops it at 60.
      expect(posts.length).toBeLessThanOrEqual(60);
      expect(posts.length).toBeGreaterThanOrEqual(60);
    } finally {
      vi.spyOn(Date, 'now').mockRestore();
    }
  });
});
