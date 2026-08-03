/**
 * Static PayNow product/tier metadata for the donor rank ladder.
 *
 * These IDs are stable once created in the PayNow dashboard/API — ranks
 * aren't added often enough to justify fetching the catalog live on every
 * request, and hardcoding avoids an extra PayNow round trip on the hot path.
 * If a rank is renamed/recreated in PayNow, update the ids here.
 */

/** The tier group all 7 subscription products belong to (drives proration on tier changes). */
export const DONOR_TIER_GROUP_ID = '586799253519597568';

/** The single ImperiumMC game server products are scoped to. */
export const PAYNOW_GAMESERVER_ID = '586784375106965504';

export interface DonorTierProductIds {
  /** LuckPerms group name granted by this tier (matches `donor_<id>` in-game). */
  id: string;
  /** Monthly subscription product id. */
  subscriptionProductId: string;
  /** One-time lifetime purchase product id. */
  lifetimeProductId: string;
}

/** Ordered low -> high. Servus (free tier) intentionally excluded — not a store product. */
export const DONOR_TIERS: DonorTierProductIds[] = [
  {
    id: 'peregrinus',
    subscriptionProductId: '586713857251082240',
    lifetimeProductId: '587751069837164544',
  },
  {
    id: 'plebeian',
    subscriptionProductId: '587751422515216384',
    lifetimeProductId: '587751431704944640',
  },
  {
    id: 'libertus',
    subscriptionProductId: '587751440877887488',
    lifetimeProductId: '587751448431828992',
  },
  {
    id: 'eques',
    subscriptionProductId: '587751459118911488',
    lifetimeProductId: '587751466760933376',
  },
  {
    id: 'patrician',
    subscriptionProductId: '587751475954851840',
    lifetimeProductId: '587751485048094720',
  },
  {
    id: 'consul',
    subscriptionProductId: '587751494204264448',
    lifetimeProductId: '587751501867257856',
  },
  {
    id: 'imperator',
    subscriptionProductId: '587751512696950784',
    lifetimeProductId: '587751519030345728',
  },
];

const SUBSCRIPTION_PRODUCT_IDS = new Set(DONOR_TIERS.map((t) => t.subscriptionProductId));
const LIFETIME_PRODUCT_IDS = new Set(DONOR_TIERS.map((t) => t.lifetimeProductId));

/** True if `productId` is one of the 7 donor subscription products (eligible for tier-group change). */
export function isDonorSubscriptionProduct(productId: string): boolean {
  return SUBSCRIPTION_PRODUCT_IDS.has(productId);
}

/**
 * True if `productId` is one of the 7 one-time lifetime rank products. Gifting is
 * restricted to these — a gifted subscription would recur against the buyer's
 * checkout session but deliver to the recipient's PayNow customer, with no payment
 * method on file for the renewal. Lifetime purchases have no such problem.
 */
export function isLifetimeProduct(productId: string): boolean {
  return LIFETIME_PRODUCT_IDS.has(productId);
}

/** Look up a tier's metadata by its subscription product id. */
export function findTierBySubscriptionProductId(productId: string): DonorTierProductIds | null {
  return DONOR_TIERS.find((t) => t.subscriptionProductId === productId) ?? null;
}
