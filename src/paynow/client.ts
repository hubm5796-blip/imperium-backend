import { env } from '../env.js';
import { logger } from '../utils/logger.js';
import { DONOR_TIER_GROUP_ID } from './constants.js';

/** Thrown when a PayNow API call fails; carries the HTTP status for callers to branch on. */
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

async function request<T>(
  path: string,
  init: RequestInit & { authorization: string },
): Promise<T> {
  const { authorization, ...rest } = init;
  const res = await fetch(`${env.paynow.baseUrl}${path}`, {
    ...rest,
    headers: {
      Accept: 'application/json',
      Authorization: authorization,
      'x-paynow-store-id': env.paynow.storeId,
      ...(rest.body ? { 'Content-Type': 'application/json' } : {}),
      ...(rest.headers ?? {}),
    },
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    throw new PaynowApiError(res.status, data);
  }
  return data as T;
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

export interface CreateCheckoutSessionResult {
  id: string;
  url: string;
}

/** Create a checkout session for a single product on behalf of a known customer. */
export async function createCheckoutSession(params: {
  customerId: string;
  productId: string;
  subscription: boolean;
  returnUrl: string;
  cancelUrl: string;
}): Promise<CreateCheckoutSessionResult> {
  return managementRequest<CreateCheckoutSessionResult>(
    `/v1/stores/${env.paynow.storeId}/checkouts`,
    {
      method: 'POST',
      body: JSON.stringify({
        customer_id: params.customerId,
        return_url: params.returnUrl,
        cancel_url: params.cancelUrl,
        auto_redirect: true,
        lines: [
          {
            product_id: params.productId,
            quantity: 1,
            subscription: params.subscription,
          },
        ],
      }),
    },
  );
}

/** A customer's subscription, as returned by the Storefront API. Passed through loosely typed. */
export interface PaynowSubscription {
  id: string;
  product_id?: string;
  status: string;
  [key: string]: unknown;
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
