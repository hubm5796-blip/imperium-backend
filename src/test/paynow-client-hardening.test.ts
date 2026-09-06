/**
 * B-21 — PayNow client hardening.
 *
 * The client's request() had four holes:
 *   1. `JSON.parse` on raw text — a non-JSON upstream (proxy HTML, empty
 *      gateway body) threw a bare SyntaxError that skipped every
 *      `instanceof PaynowApiError` branch and answered an opaque 500.
 *   2. No deadline — a stalled PayNow hung the inline await in user-facing
 *      checkout/cancel until the Worker died.
 *   3. No response size cap — an upstream could stream an unbounded body
 *      into Worker memory.
 *   4. No content-type check on success — a 2xx HTML page would have been
 *      JSON.parse'd and handed to callers.
 * Plus the tier-mapping hole: the webhook cached ANY product_id verbatim and
 * the cached read served it as an active tier.
 *
 * These pin the post-fix client contract at the fetch boundary (global fetch
 * stubbed per test), and the 504 route mapping end-to-end.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getPaynowCustomerIdMock,
  setPaynowCustomerIdMock,
  getCachedSubscriptionMock,
  upsertCachedSubscriptionMock,
  fakeD1,
} = vi.hoisted(() => {
  const fakeD1 = {
    prepare() {
      const runFor = () => ({ run: async () => ({ meta: { changes: 1 } }), first: async () => null });
      return { bind: () => runFor(), ...runFor() };
    },
  };
  return {
    getPaynowCustomerIdMock: vi.fn(),
    setPaynowCustomerIdMock: vi.fn(),
    getCachedSubscriptionMock: vi.fn(),
    upsertCachedSubscriptionMock: vi.fn(),
    fakeD1,
  };
});

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  return {
    ...actual,
    getD1: () => fakeD1,
    getPaynowCustomerId: getPaynowCustomerIdMock,
    setPaynowCustomerId: setPaynowCustomerIdMock,
    getCachedSubscription: getCachedSubscriptionMock,
    upsertCachedSubscription: upsertCachedSubscriptionMock,
  };
});

import { __resetEnvForTests, initEnvFromBindings } from '../env.js';
import { PaynowApiError, createCustomerToken, getPaynowCustomer } from '../paynow/client.js';

const realFetch = globalThis.fetch;

function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

beforeAll(() => {
  __resetEnvForTests();
  initEnvFromBindings({
    JWT_SECRET: 'test-jwt-secret-0123456789abcdef',
    DISCORD_CLIENT_ID: '1',
    DISCORD_CLIENT_SECRET: 'x',
    WEBPANEL_HMAC_SECRET: 'test-hmac-secret',
    PAYNOW_API_KEY: 'pk_test',
    PAYNOW_STORE_ID: '1',
    PAYNOW_WEBHOOK_SECRETS: 'whsec_test',
    BOT_API_TOKEN: 'bot-token-test',
    PAYNOW_BASE_URL: 'https://paynow.test',
  } as unknown as Record<string, string>);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('B-21: PayNow client request hardening (fetch boundary)', () => {
  beforeEach(() => {
    // createCustomerToken → managementRequest → request(): one POST, no body.
    globalThis.fetch = vi.fn(async () => jsonRes({ token: 'tok' }));
  });

  it('a non-JSON error body becomes a typed PaynowApiError carrying a bounded raw excerpt', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('<html>Bad Gateway</html>'.repeat(50), {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const err: unknown = await createCustomerToken('cus_x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaynowApiError);
    const apiErr = err as PaynowApiError;
    expect(apiErr.status).toBe(502);
    expect(((apiErr.body as { raw?: string }).raw ?? '').length).toBeLessThanOrEqual(500);
    expect(((apiErr.body as { raw?: string }).raw ?? '')).toContain('<html>');
  });

  it('a stalled upstream (deadline abort, TimeoutError shape) becomes PaynowApiError status 504 — never a hang or a SyntaxError', async () => {
    // The deadline signal's creation is pinned separately; here the fetch
    // rejects with the exact error shape AbortSignal.timeout produces.
    globalThis.fetch = vi.fn(
      (): Promise<Response> =>
        new Promise((_resolve, reject) => {
          setTimeout(() => {
            const e = new Error('The operation was aborted due to timeout');
            e.name = 'TimeoutError';
            reject(e);
          }, 5);
        }),
    );
    const err: unknown = await createCustomerToken('cus_x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaynowApiError);
    expect((err as PaynowApiError).status).toBe(504);
    expect((err as PaynowApiError).body).toMatchObject({ reason: 'timeout' });
  });

  it('an oversized response (declared content-length) is refused before the body is read', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('{"token":"x"}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'content-length': String(50_000_000) },
      }),
    );
    const err: unknown = await createCustomerToken('cus_x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaynowApiError);
    expect((err as PaynowApiError).body).toMatchObject({ error: 'response_too_large' });
  });

  it('a 2xx with a non-JSON content-type is rejected as a contract break, not parsed', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('<html>login page</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    const err: unknown = await createCustomerToken('cus_x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaynowApiError);
    expect((err as PaynowApiError).status).toBe(502);
    expect((err as PaynowApiError).body).toMatchObject({ reason: 'unexpected_content_type' });
  });

  it('an empty 2xx body parses as null (valid), and a JSON 2xx still parses normally', async () => {
    // getPaynowCustomer passes its T straight through, so a null body is
    // observable without tripping a consumer's own destructuring.
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 200 }));
    await expect(getPaynowCustomer('cus_x')).resolves.toBeNull();
    globalThis.fetch = vi.fn(async () => jsonRes({ token: 'tok' }));
    await expect(createCustomerToken('cus_x')).resolves.toBe('tok');
  });

  it('every request carries a timeout signal (deadline enforced even when the caller sets none)', async () => {
    await createCustomerToken('cus_x');
    const init = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1] as { signal?: AbortSignal };
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal!.aborted).toBe(false);
  });
});

describe('B-21: route-level status mapping (504 timeouts answer 504)', () => {
  it('a PayNow timeout on checkout surfaces as 504 with the retry message', async () => {
    const { api } = await import('../api/routes.js');
    // resolvePaynowCustomerId needs a cached customer so only the PayNow
    // checkout call runs — which we stall past its deadline into a 504.
    getPaynowCustomerIdMock.mockReset().mockResolvedValue('cus_test');
    globalThis.fetch = vi.fn(
      (): Promise<Response> =>
        new Promise((_resolve, reject) => {
          // Reject on the next macrotask with the deadline's error shape —
          // the client's real 8s deadline is simulated; what matters is the
          // mapping, not the wait.
          setTimeout(() => {
            const e = new Error('aborted');
            e.name = 'TimeoutError';
            reject(e);
          }, 5);
        }),
    );
    const res = await api.request('/store/checkout', {
      method: 'POST',
      headers: {
        'x-bot-token': 'bot-token-test',
        'x-mc-uuid': 'a25a17ce-bca1-4894-92c9-00d7ab5b7875',
        'content-type': 'application/json',
        'cf-connecting-ip': '203.0.113.91',
      },
      body: JSON.stringify({ productId: '586713857251082240', subscription: true }),
    });
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/did not respond in time/i) });
  });
});
