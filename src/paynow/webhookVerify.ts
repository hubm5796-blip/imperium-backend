import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';

/** Reject webhook timestamps older than this to prevent replay attacks (per PayNow's docs). */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * Verify a PayNow webhook request.
 *
 * Per PayNow's docs: sign `${timestamp}.${rawBody}` with HMAC-SHA256 using the
 * per-webhook secret, base64-encode it, and compare against the
 * `PayNow-Signature` header using constant-time comparison. `PayNow-Timestamp`
 * is Unix milliseconds and must be within 5 minutes of now.
 *
 * PayNow issues a separate secret per webhook subscription, and we register
 * one subscription per event type against this same endpoint — so a request
 * is valid if it matches ANY of the configured secrets.
 */
export function verifyPaynowWebhook(params: {
  rawBody: string;
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
}): { valid: boolean; reason?: string } {
  const { rawBody, signatureHeader, timestampHeader } = params;

  if (!signatureHeader || !timestampHeader) {
    return { valid: false, reason: 'Missing signature or timestamp header' };
  }

  const timestamp = Number.parseInt(timestampHeader, 10);
  if (Number.isNaN(timestamp)) {
    return { valid: false, reason: 'Invalid timestamp header' };
  }
  if (Math.abs(Date.now() - timestamp) > MAX_CLOCK_SKEW_MS) {
    return { valid: false, reason: 'Timestamp outside allowed window (possible replay)' };
  }

  const signingString = `${timestampHeader}.${rawBody}`;
  const actualBuf = Buffer.from(signatureHeader, 'utf8');

  const matched = env.paynow.webhookSecrets.some((secret) => {
    const expected = createHmac('sha256', secret).update(signingString).digest('base64');
    const expectedBuf = Buffer.from(expected, 'utf8');
    return expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);
  });

  if (!matched) {
    return { valid: false, reason: 'Signature mismatch' };
  }
  return { valid: true };
}
