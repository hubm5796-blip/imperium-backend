import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B-41 — Discord REST discipline:
 *   1. Every call carries a deadline: a fresh 8s AbortSignal.timeout when
 *      the caller brings none (the signal assertion), and a caller-supplied
 *      signal is honored (abort → rejects, never hangs the war window).
 *   2. 429 is backpressure: one retry-after-aware retry (header or body),
 *      clamped to 5s; a 429 that survives is RETURNED as 429.
 *   3. Role ops are status-aware: a surviving 429 reports rateLimited, and
 *      applyPlan counts it separately from real failures.
 */

let calls: Array<{ url: string; init?: RequestInit }>;

function res(status: number, headers: Record<string, string> = {}, body?: unknown): Response {
  // 204/304 are null-body statuses — the Response constructor rejects a body.
  if (status === 204 || status === 304) return new Response(null, { status, headers });
  return new Response(body === undefined ? '{}' : JSON.stringify(body), { status, headers });
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

import {
  discordApiFetch,
  addGuildMemberRoleOp,
  DISCORD_REST_TIMEOUT_MS,
  MAX_429_WAIT_MS,
} from '../bot/discordRest.js';
import { applyPlan } from '../bot/roles/sync.js';

describe('B-41 deadlines', () => {
  it('a call without a caller signal still gets one (the standing 8s timeout)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return res(200);
    }));
    const out = await discordApiFetch('/users/@me', 'tok');
    expect(out.status).toBe(200);
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    // It is a DEADLINE signal (abort reason carries the timeout marker).
    const sig = calls[0]!.init!.signal as AbortSignal;
    expect(sig.aborted).toBe(false); // fresh per call, not pre-aborted
  });

  it('a caller-supplied signal is honored — abort rejects, never hangs', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(_url), init });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }));
    const controller = new AbortController();
    const pending = discordApiFetch('/users/@me', 'tok', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(calls[0]!.init?.signal).toBe(controller.signal); // not replaced
  });

  it('the deadline constant is the documented 8s, retry clamp 5s', () => {
    expect(DISCORD_REST_TIMEOUT_MS).toBe(8_000);
    expect(MAX_429_WAIT_MS).toBe(5_000);
  });
});

describe('B-41 429 handling', () => {
  it('retries once after the retry-after hint and returns the 200', async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n += 1;
      if (n === 1) return res(429, { 'retry-after': '0.05' });
      return res(200);
    });
    vi.stubGlobal('fetch', fetchMock);
    const out = await discordApiFetch('/channels/1/messages', 'tok', { method: 'POST', body: '{}' });
    expect(out.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a body-only retry_after (JSON) is honored too', async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n += 1;
      if (n === 1) return res(429, {}, { retry_after: 0.05 });
      return res(200);
    });
    vi.stubGlobal('fetch', fetchMock);
    const out = await discordApiFetch('/channels/1/messages', 'tok', { method: 'POST', body: '{}' });
    expect(out.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('an unreasonably long retry-after is NOT waited out — the 429 is returned', async () => {
    const fetchMock = vi.fn(async () => res(429, { 'retry-after': '30' }));
    vi.stubGlobal('fetch', fetchMock);
    const started = Date.now();
    const out = await discordApiFetch('/channels/1/messages', 'tok', { method: 'POST', body: '{}' });
    expect(out.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1); // clamped short => no retry burn
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('a 429 without any retry hint is returned, not retried', async () => {
    const fetchMock = vi.fn(async () => new Response('rate limited', { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    const out = await discordApiFetch('/channels/1/messages', 'tok', { method: 'POST', body: '{}' });
    expect(out.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('B-41 status-aware ops + report split', () => {
  it('a surviving 429 reports rateLimited (backpressure, not attrition)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(429, { 'retry-after': '30' })));
    const op = await addGuildMemberRoleOp('g', 'u', 'r', 'tok');
    expect(op).toEqual({ ok: false, status: 429, rateLimited: true });
  });

  it('a network error reports status 0 — never a Discord verdict', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('socket detached');
    }));
    const op = await addGuildMemberRoleOp('g', 'u', 'r', 'tok');
    expect(op).toEqual({ ok: false, status: 0, rateLimited: false });
  });

  it('applyPlan counts rate-limited ops separately from failures', async () => {
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n += 1;
      // add r1 → 429 (long retry-after, no retry); add r2 → 200; remove r3 → 500.
      if (n === 1) return res(429, { 'retry-after': '30' });
      if (n === 2) return res(204);
      return res(500);
    }));
    const report = await applyPlan('tok', 'g', { discordId: 'u', add: ['r1', 'r2'], remove: ['r3'] });
    expect(report.added).toEqual(['r2']);
    expect(report.rateLimited).toEqual(['r1']);
    expect(report.failed).toEqual(['r3']);
  });
});
