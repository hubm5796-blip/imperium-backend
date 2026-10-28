/**
 * PayNow OnRefund / OnChargeback → STORE_REFUND (plugin PurchaseRefundService).
 *
 * Plugin contract (ImperiumMC-Plugin kotlin-migration-collab,
 * WebPanelCommandHandler.handleStoreRefund): { transaction_id (required),
 * reason? }. The plugin registry keys purchases on the transaction_id the
 * fulfillment dispatch sent: the bare order id for line 0, "orderId:L<i>"
 * after (B-57). The refund reads those back from the D1 dispatch ledger.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { sendCommandWithResponseMock, ledger, d1State } = vi.hoisted(() => ({
  sendCommandWithResponseMock: vi.fn(),
  ledger: [] as Array<{ order_id: string; line_key: string }>,
  d1State: { failSelect: false },
}));

vi.mock('../db/pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/pool.js')>();
  const fakeD1 = {
    prepare(sql: string) {
      const bound = (params: unknown[]) => ({
        run: async () => ({ meta: { changes: 1 } }),
        first: async () => null,
        all: async () => {
          if (sql.includes('FROM paynow_order_dispatches')) {
            if (d1State.failSelect) throw new Error('D1 down');
            return { results: ledger.filter((r) => r.order_id === params[0]) };
          }
          return { results: [] };
        },
      });
      return { bind: (...p: unknown[]) => bound(p), ...bound([]) };
    },
  };
  return { ...actual, getD1: () => fakeD1 };
});

vi.mock('../db/redis.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/redis.js')>();
  return { ...actual, sendCommandWithResponse: sendCommandWithResponseMock };
});

import { __resetEnvForTests, initEnvFromBindings } from '../env.js';
import { normalizePaynowEventType, refundTransactionIds } from '../paynow/fulfillment.js';

const BUYER = '11111111-2222-4333-8444-555555555555';

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
  });
});

beforeEach(() => {
  sendCommandWithResponseMock.mockReset();
  ledger.length = 0;
  d1State.failSelect = false;
});

async function postWebhook(eventType: string, body: Record<string, unknown>): Promise<Response> {
  const { api } = await import('../api/routes.js');
  const rawBody = JSON.stringify({ event_type: eventType, body });
  const timestamp = Date.now();
  const { createHmac } = await import('node:crypto');
  const signature = createHmac('sha256', 'whsec_test').update(`${timestamp}.${rawBody}`).digest('base64');
  return api.request('/webhooks/paynow', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'PayNow-Signature': signature,
      'PayNow-Timestamp': String(timestamp),
      'cf-connecting-ip': '198.51.100.20',
    },
    body: rawBody,
  });
}

function refundBody(orderId = 'ord_1'): Record<string, unknown> {
  return { id: 'ref_9', order_id: orderId, customer: { id: 'cus_1', minecraft: { id: BUYER } }, amount: '4.99' };
}

describe('event normalization', () => {
  it('maps PayNow refund/chargeback spellings, and leaves the closed/lifecycle events alone', () => {
    expect(normalizePaynowEventType('OnRefund')).toBe('refund');
    expect(normalizePaynowEventType('ON_REFUND')).toBe('refund');
    expect(normalizePaynowEventType('OnChargeback')).toBe('chargeback');
    expect(normalizePaynowEventType('ON_CHARGEBACK')).toBe('chargeback');
    expect(normalizePaynowEventType('OnChargebackClosed')).toBe('unknown');
    expect(normalizePaynowEventType('OnChargebackLifecycle')).toBe('unknown');
  });
});

describe('refundTransactionIds', () => {
  it('derives the per-line ids fulfillment sent (B-57), deduped, legacy keys → bare order id', () => {
    expect(
      refundTransactionIds('ord_1', [
        `0:588822585022619648:1:${BUYER}`,
        `1:588822585022619648:1:${BUYER}`,
        `2:587789661796048896:1:${BUYER}`,
        `588822585022619648:1:${BUYER}`, // pre-B-57 key (no index) → bare order id
      ]),
    ).toEqual(['ord_1', 'ord_1:L1', 'ord_1:L2']);
  });
});

describe('POST /api/webhooks/paynow refund/chargeback', () => {
  it('OnRefund dispatches STORE_REFUND for every delivered line and returns 200', async () => {
    ledger.push(
      { order_id: 'ord_1', line_key: `0:588822585022619648:1:${BUYER}` },
      { order_id: 'ord_1', line_key: `1:587789661796048896:1:${BUYER}` },
    );
    sendCommandWithResponseMock.mockResolvedValue({ ok: true, status: 'OK' });
    const res = await postWebhook('OnRefund', refundBody());
    expect(res.status).toBe(200);
    const calls = sendCommandWithResponseMock.mock.calls;
    expect(calls.map((c) => c[0])).toEqual(['STORE_REFUND', 'STORE_REFUND']);
    expect(calls.map((c) => (c[1] as { transaction_id: string }).transaction_id).sort()).toEqual(['ord_1', 'ord_1:L1']);
    expect(calls[0]![1]).toMatchObject({ reason: 'paynow_refund:ref_9', order_id: 'ord_1' });
  });

  it('OnChargeback dispatches STORE_REFUND with a chargeback reason', async () => {
    ledger.push({ order_id: 'ord_2', line_key: `0:588822585022619648:1:${BUYER}` });
    sendCommandWithResponseMock.mockResolvedValue({ ok: true, status: 'OK' });
    const res = await postWebhook('OnChargeback', { ...refundBody('ord_2'), id: 'cb_3' });
    expect(res.status).toBe(200);
    expect(sendCommandWithResponseMock).toHaveBeenCalledWith(
      'STORE_REFUND',
      expect.objectContaining({ transaction_id: 'ord_2', reason: 'paynow_chargeback:cb_3' }),
      expect.any(Number),
    );
  });

  it('a repeat event the plugin already processed is idempotent success, not a retry loop', async () => {
    ledger.push({ order_id: 'ord_1', line_key: `0:588822585022619648:1:${BUYER}` });
    sendCommandWithResponseMock.mockResolvedValue({ ok: false, status: 'ERROR', error: 'Transaction not found or already refunded' });
    const res = await postWebhook('OnRefund', refundBody());
    expect(res.status).toBe(200);
  });

  it('a plugin timeout or revocation error returns 500 so PayNow retries', async () => {
    ledger.push({ order_id: 'ord_1', line_key: `0:588822585022619648:1:${BUYER}` });
    sendCommandWithResponseMock.mockRejectedValue(new Error('Timed out waiting for response to STORE_REFUND'));
    expect((await postWebhook('OnRefund', refundBody())).status).toBe(500);
    sendCommandWithResponseMock.mockReset().mockResolvedValue({ ok: false, status: 'ERROR', error: 'Refund revocation failed — see server logs' });
    expect((await postWebhook('OnRefund', refundBody())).status).toBe(500);
  });

  it('an unreadable dispatch ledger returns 500 (retry), never a silent 200', async () => {
    d1State.failSelect = true;
    const res = await postWebhook('OnRefund', refundBody());
    expect(res.status).toBe(500);
    expect(sendCommandWithResponseMock).not.toHaveBeenCalled();
  });

  it('a refund for an order we never delivered dispatches nothing and returns 200 flagged', async () => {
    const res = await postWebhook('OnRefund', refundBody('ord_never'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: false, flagged: 'refund_not_delivered' });
    expect(sendCommandWithResponseMock).not.toHaveBeenCalled();
  });
});
