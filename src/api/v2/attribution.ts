/**
 * S2-E09 (Lane D backend half) — POST /api/v2/attribution/intent (public,
 * rate-limited) + POST /api/v2/attribution/claim (service-token gated).
 *
 * Wire contract (docs/season-2/requests/S2-E09.md Ask 1):
 *   intent — body { "source": "<tag>" } from the site proxy
 *     (imperium-frontend-fresh/src/app/api/v2/attribution/intent/route.ts);
 *     202 {ok:true}. 'direct' is refused (400) — it is the join's default,
 *     not a tag anyone reports. The vocabulary is shape-validated
 *     (analytics/attribution.ts parseSourceTag), so no PII can ride in.
 *   claim  — body { "uuid": "<dashed>", "ip": "<socket address at join>" }
 *     from the plugin (X-Bot-Token service principal); 200 { "source": ... },
 *     never null. A 503 means "resolve locally as direct" for the plugin —
 *     attribution must never block or fail a join.
 *
 * Caller-IP resolution on intent — X-Forwarded-For FIRST, then
 * CF-Connecting-IP. This is the one place the deployed topology inverts the
 * request file's literal header ordering, deliberately: the site proxy is
 * the only production caller and it relays the END VISITOR's IP as XFF
 * (shape-validated on its side, mirrored here); the request transits
 * Cloudflare to this Worker, so the CF-Connecting-IP the backend sees on
 * those calls is the PROXY's egress IP, and hashing it would collapse every
 * visitor's intent onto one key — the contract's own acceptance walk (the
 * visitor's IP hash in D1 matching a same-network join) requires the
 * relayed XFF to win. CF-Connecting-IP remains the fallback for direct
 * calls (curl, a future direct beacon), where it IS the true client.
 * Spoofing bound: a forged XFF can only store vocabulary-valid tags on
 * chosen IP hashes (rows expire in 48h; noise the request file accepts),
 * and the unspoofable global rateLimitV2 write bucket caps raw volume.
 */
import { Hono } from 'hono';
import {
  claimSource,
  hashIp,
  parseSourceTag,
  storeIntent,
} from '../../analytics/attribution.js';
import { clientIp, rateLimit } from '../../middleware/rateLimit.js';
import { requireServiceToken } from '../../middleware/serviceToken.js';
import { logger } from '../../utils/logger.js';
import type { AppContextVariables } from '../../types/index.js';

type ApiEnv = { Variables: AppContextVariables };
type Ctx = { req: { header: (name: string) => string | undefined } };

/** IPv4 dotted-quad, IPv6, or a v4-mapped IPv6 (the Java socket form the
 *  plugin's claim sends; hashIp canonicalizes it to the v4). The same shape
 *  guard the site proxy applies before relaying, extended with the mapped
 *  form for the claim side; a malformed value is DROPPED, never hashed. */
const IP_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|::ffff:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]{2,45})$/;

/**
 * The END VISITOR's IP: the first (leftmost, original-client) X-Forwarded-For
 * entry when the site proxy relayed one, else CF-Connecting-IP (a direct
 * call). Null when neither resolves to a valid IP shape — never a guess.
 */
export function resolveAttributionIp(c: Ctx): string | null {
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first && IP_RE.test(first)) return first;
  }
  const cf = c.req.header('cf-connecting-ip')?.trim();
  return cf && IP_RE.test(cf) ? cf : null;
}

/**
 * 10/min per VISITOR IP (the request file's cap; the client self-throttles
 * to 1/min). Keyed on the resolved attribution IP: keying on the default
 * clientIp would cap the entire site at 10/min through the shared proxy
 * egress. Spoofed-XFF evasion only dodges this fairness cap — the global
 * rateLimitV2 write bucket (keyed on the unspoofable CF-Connecting-IP)
 * still bounds raw volume.
 */
export const attributionIntentLimit = rateLimit(10, 60_000, 'attribution-intent', (c) =>
  resolveAttributionIp(c) ?? clientIp(c),
);

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const attributionV2 = new Hono<ApiEnv>();

attributionV2.post('/attribution/intent', attributionIntentLimit, async (c) => {
  let body: { source?: unknown };
  try {
    body = (await c.req.json()) as { source?: unknown };
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  const source = parseSourceTag(body.source);
  if (!source) return c.json({ error: 'Invalid source' }, 400);
  if (source === 'direct') {
    // 'direct' is the join's default, not a tag anyone reports — a beacon
    // claiming it is malformed by definition (the site proxy rejects it too).
    return c.json({ error: "'direct' is not a reportable source" }, 400);
  }

  const ip = resolveAttributionIp(c);
  if (!ip) return c.json({ error: 'Client IP unavailable' }, 400);

  try {
    await storeIntent(hashIp(ip), source, Date.now());
    return c.json({ ok: true }, 202);
  } catch (err) {
    logger.warn({ err: String(err) }, 'attribution: intent store failed');
    return c.json({ error: 'Attribution unavailable' }, 503);
  }
});

attributionV2.post('/attribution/claim', requireServiceToken, async (c) => {
  let body: { uuid?: unknown; ip?: unknown };
  try {
    body = (await c.req.json()) as { uuid?: unknown; ip?: unknown };
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400);
  }

  if (typeof body.uuid !== 'string' || !UUID_RE.test(body.uuid)) {
    return c.json({ error: "Invalid 'uuid' (dashed UUID)" }, 400);
  }
  if (typeof body.ip !== 'string' || !IP_RE.test(body.ip.trim())) {
    return c.json({ error: "Invalid 'ip'" }, 400);
  }

  try {
    const source = await claimSource(body.uuid.toLowerCase(), hashIp(body.ip), Date.now());
    return c.json({ source });
  } catch (err) {
    logger.warn({ err: String(err) }, 'attribution: claim resolve failed');
    // The plugin half treats any non-200 as 'direct' locally (it never
    // blocks a join) — 503 keeps the failure observable, not silent.
    return c.json({ error: 'Attribution unavailable' }, 503);
  }
});
