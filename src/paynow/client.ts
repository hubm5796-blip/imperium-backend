import { env } from '../env.js';
import { logger } from '../utils/logger.js';
import { DONOR_TIER_GROUP_ID } from './constants.js';

/**
 * Thrown when a PayNow API call fails; carries the HTTP status for callers to
 * branch on. `status` is the UPSTREAM status, except 504 which this client
 * assigns to its own timeout deadline (B-21) so callers can map it to a
 * gateway-timeout response instead of a generic 500.
 */
export class PaynowApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    const bodyMessage =
      body && typeof body === 'object' && 'message' in body
        ? String((body as { message?: unknown }).message)
        : null;
    super(bodyMessage || `PayNow API request failed with ${status}`);
    this.status = status;
    this.body = body;
  }
}

/** B-21: every PayNow fetch carries a deadline — a stalled upstream fails fast
 *  instead of hanging the user-facing checkout/cancel path. 8s per the finding. */
const REQUEST_TIMEOUT_MS = 8_000;

/** B-21: response bodies are capped — a misbehaving proxy or upstream must not
 *  be able to stream an unbounded payload into the Worker's memory. */
const MAX_RESPONSE_BYTES = 1_000_000;

/** Combine a caller-supplied signal with the default deadline. */
function deadlineSignal(existing?: AbortSignal | null): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  if (!existing) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([existing, timeout]);
  return existing; // older runtimes: honor the caller's own bound, if any
}

/** True for the abort/fetch failure shapes a deadline produces. */
function isTimeoutAbort(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'TimeoutError' || err.name === 'AbortError')
  );
}

/** Read the body with a hard byte cap (content-length when present, streamed otherwise). */
async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_RESPONSE_BYTES) {
    throw new PaynowApiError(502, { error: 'response_too_large', contentLength: declared });
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_RESPONSE_BYTES) {
    throw new PaynowApiError(502, { error: 'response_too_large', contentLength: buf.byteLength });
  }
  return new TextDecoder().decode(buf);
}

async function request<T>(
  path: string,
  init: RequestInit & { authorization: string },
): Promise<T> {
  const { authorization, signal, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(`${env.paynow.baseUrl}${path}`, {
      ...rest,
      signal: deadlineSignal(signal),
      headers: {
        Accept: 'application/json',
        Authorization: authorization,
        'x-paynow-store-id': env.paynow.storeId,
        ...(rest.body ? { 'Content-Type': 'application/json' } : {}),
        ...(rest.headers ?? {}),
      },
    });
  } catch (err) {
    // B-21: no deadline existed — a stalled PayNow hung the inline await in
    // checkout/cancel until the Worker died. Timeouts become a typed 504 so
    // routes can answer "gateway timeout, retry" instead of a generic 500.
    if (isTimeoutAbort(err)) {
      throw new PaynowApiError(504, { reason: 'timeout', deadlineMs: REQUEST_TIMEOUT_MS });
    }
    throw err;
  }

  const text = await readCapped(res);
  const contentType = res.headers.get('content-type') ?? '';

  const parseJson = (): unknown => {
    try {
      return text ? (JSON.parse(text) as unknown) : null;
    } catch {
      // Non-JSON upstream body (HTML error page, empty gateway response) —
      // surface it as a typed error with a bounded raw excerpt, never a raw
      // SyntaxError that routes would render as an opaque 500.
      throw new PaynowApiError(res.ok ? 502 : res.status, { raw: text.slice(0, 500) });
    }
  };

  if (!res.ok) {
    // Error bodies are parsed best-effort regardless of content-type — PayNow
    // sends JSON, but a proxy in front of it may not; both land in the same
    // typed error either way.
    try {
      throw new PaynowApiError(res.status, text ? (JSON.parse(text) as unknown) : null);
    } catch (err) {
      if (err instanceof PaynowApiError) throw err;
      throw new PaynowApiError(res.status, { raw: text.slice(0, 500) });
    }
  }

  // Success path: honor the content-type. An empty body is a valid null;
  // anything non-JSON on a 2xx is a contract break (HTML login page, proxy
  // interstitial) and must not be handed to callers as parsed data.
  if (!text) return null as T;
  if (!contentType.includes('json')) {
    throw new PaynowApiError(502, { reason: 'unexpected_content_type', contentType: contentType || '(none)', raw: text.slice(0, 500) });
  }
  return parseJson() as T;
}

/** Call the Management API (server-to-server, authenticated with our store API key). */
function managementRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  return request<T>(path, { ...init, authorization: `APIKey ${env.paynow.apiKey}` });
}

/** Call the Storefront API on behalf of a specific customer (short-lived customer token). */
function storefrontRequest<T>(
  path: string,
  customerToken: string,
  init: RequestInit = {},
): Promise<T> {
  return request<T>(path, { ...init, authorization: `Customer ${customerToken}` });
}

/**
 * Find the PayNow customer for a linked Minecraft UUID, creating one if this
 * is their first time touching the store. PayNow customers are looked up by
 * `minecraft_uuid` — the store's game is minecraft_geyser, so this is the
 * stable identity key across Java/Bedrock.
 */
export async function findOrCreatePaynowCustomer(uuid: string): Promise<string> {
  const lookup = await managementRequest<{ id: string } | null>(
    `/v1/stores/${env.paynow.storeId}/customers/lookup?minecraft_uuid=${encodeURIComponent(uuid)}`,
  ).catch((err: unknown) => {
    if (err instanceof PaynowApiError && err.status === 404) return null;
    throw err;
  });
  if (lookup?.id) return lookup.id;

  const created = await managementRequest<{ id: string }>(
    `/v1/stores/${env.paynow.storeId}/customers`,
    {
      method: 'POST',
      body: JSON.stringify({ minecraft_uuid: uuid }),
    },
  );
  logger.info({ uuid, customerId: created.id }, 'Created PayNow customer');
  return created.id;
}

/** Mint a short-lived customer token so the backend can act as this customer on the Storefront API. */
export async function createCustomerToken(customerId: string): Promise<string> {
  const res = await managementRequest<{ token: string }>(
    `/v1/stores/${env.paynow.storeId}/customers/${customerId}/tokens`,
    { method: 'POST' },
  );
  return res.token;
}

/** A PayNow customer, as returned by the Management API's get-customer endpoint. */
export interface PaynowCustomer {
  id: string;
  /** The customer's Minecraft UUID, if linked (null for never-linked customers). */
  minecraft_uuid?: string | null;
  minecraft?: { id?: string; name?: string | null } | null;
  [key: string]: unknown;
}

/** Fetch a customer by id (Management API) — the webhook's buyer-resolution fallback. */
export async function getPaynowCustomer(customerId: string): Promise<PaynowCustomer> {
  return managementRequest<PaynowCustomer>(
    `/v1/stores/${env.paynow.storeId}/customers/${customerId}`,
    { signal: AbortSignal.timeout(4000) },
  );
}

export interface CreateCheckoutSessionResult {
  id: string;
  url: string;
}

/** A single line item in a PayNow checkout session. */
export interface CheckoutLine {
  productId: string;
  quantity: number;
  subscription?: boolean;
  /** PayNow customer ID for a gift recipient (resolved from their UUID already). */
  giftToCustomerId?: string;
}

/**
 * Create a checkout session for one or more products. The `lines` array maps
 * directly to PayNow's `lines[]` — each entry can have its own product,
 * quantity, subscription flag, and gift recipient.
 */
export async function createCheckoutSession(params: {
  customerId: string;
  /** Legacy single-product form — internally converted to a one-element lines array. */
  productId?: string;
  subscription?: boolean;
  /** Multi-product form — when provided, takes precedence over productId. */
  lines?: CheckoutLine[];
  returnUrl: string;
  cancelUrl: string;
}): Promise<CreateCheckoutSessionResult> {
  const lines: CheckoutLine[] =
    params.lines ??
    (params.productId
      ? [{ productId: params.productId, quantity: 1, subscription: params.subscription ?? false }]
      : []);

  if (lines.length === 0) {
    throw new Error('createCheckoutSession requires at least one line item');
  }

  return managementRequest<CreateCheckoutSessionResult>(
    `/v1/stores/${env.paynow.storeId}/checkouts`,
    {
      method: 'POST',
      body: JSON.stringify({
        customer_id: params.customerId,
        return_url: params.returnUrl,
        cancel_url: params.cancelUrl,
        auto_redirect: true,
        lines: lines.map((l) => ({
          product_id: l.productId,
          quantity: l.quantity,
          subscription: l.subscription ?? false,
          ...(l.giftToCustomerId ? { gift_to_customer_id: l.giftToCustomerId } : {}),
        })),
      }),
    },
  );
}

/** A customer's subscription, as returned by the Storefront API. Passed through loosely typed. */
export interface PaynowSubscription {
  id: string;
  customer_id?: string;
  product_id?: string;
  status: string;
  [key: string]: unknown;
}

/** A single line of an order, per the Management API's list-orders response. */
export interface PaynowOrderLineDto {
  product_id?: string;
  product_name?: string | null;
  quantity?: number;
  [key: string]: unknown;
}

/** An order, as returned by the Management API's list-orders endpoint. */
export interface PaynowOrderDto {
  id: string;
  /** Human-facing "pn-…" identifier. */
  pretty_id?: string | null;
  /** created | completed | canceled | refunded | chargeback. */
  status?: string;
  /** one_time | subscription_initial | subscription_renewal | subscription_proration | mixed. */
  type?: string;
  created_at?: string | null;
  completed_at?: string | null;
  /** Integer in the smallest currency unit. */
  total_amount?: number | null;
  lines?: PaynowOrderLineDto[] | null;
  [key: string]: unknown;
}

/**
 * List one customer's orders, newest first (Management API). bC10: the order-
 * history surfaces call this so real-money purchases appear next to web-shop
 * ones instead of vanishing after checkout. Deadline-bounded (4s) like
 * getPaynowCustomer — a stalled PayNow must not hang a dashboard page render.
 */
export async function listCustomerOrders(
  customerId: string,
  limit: number = 20,
): Promise<PaynowOrderDto[]> {
  const params = new URLSearchParams({
    customer_id: customerId,
    limit: String(Math.min(100, Math.max(1, Math.floor(limit) || 1))),
    asc: 'false',
  });
  return managementRequest<PaynowOrderDto[]>(
    `/v1/stores/${env.paynow.storeId}/orders?${params.toString()}`,
    { signal: AbortSignal.timeout(4000) },
  );
}

/**
 * Cancel a subscription. PayNow's customer-token self-cancel endpoint exists
 * on the Storefront API but is Steam-only per their docs — not available for
 * this store's minecraft_geyser platform — so this always goes through the
 * Management API (our own store API key), never a customer token.
 */
export async function cancelSubscription(subscriptionId: string): Promise<void> {
  await managementRequest<unknown>(
    `/v1/stores/${env.paynow.storeId}/subscriptions/${subscriptionId}/cancel`,
    { method: 'POST' },
  );
}

/** Fetch a single subscription by ID (Management API — used to verify ownership before canceling). */
export async function getSubscriptionById(subscriptionId: string): Promise<PaynowSubscription> {
  return managementRequest<PaynowSubscription>(
    `/v1/stores/${env.paynow.storeId}/subscriptions/${subscriptionId}`,
  );
}

/** List the calling customer's subscriptions (used to find their active donor-tier one). */
export async function getCustomerSubscriptions(
  customerToken: string,
): Promise<PaynowSubscription[]> {
  return storefrontRequest<PaynowSubscription[]>('/v1/store/customer/subscriptions', customerToken);
}

/** Loosely-typed passthrough of PayNow's SubscriptionChangeDto — see their docs for the full shape. */
export interface SubscriptionChangeResult {
  subscription_change: {
    status: string;
    prorated_amount: unknown;
    next_billing_amount: unknown;
    [key: string]: unknown;
  };
  pending_payment?: unknown;
}

/** Preview a tier-group subscription change (no charge, no side effects). */
export async function previewTierChange(
  customerToken: string,
  targetProductId: string,
): Promise<SubscriptionChangeResult> {
  return storefrontRequest<SubscriptionChangeResult>(
    `/v1/store/tier-groups/${DONOR_TIER_GROUP_ID}/change/preview`,
    customerToken,
    { method: 'POST', body: JSON.stringify({ target_product_id: targetProductId }) },
  );
}

/** Apply a tier-group subscription change (upgrade/downgrade with proration). */
export async function applyTierChange(
  customerToken: string,
  targetProductId: string,
  verificationCode?: string,
): Promise<SubscriptionChangeResult> {
  return storefrontRequest<SubscriptionChangeResult>(
    `/v1/store/tier-groups/${DONOR_TIER_GROUP_ID}/change`,
    customerToken,
    {
      method: 'POST',
      body: JSON.stringify({
        target_product_id: targetProductId,
        ...(verificationCode ? { verification_code: verificationCode } : {}),
      }),
    },
  );
}
