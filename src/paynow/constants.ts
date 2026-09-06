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

/** Look up a tier's metadata by its lifetime product id. */
export function findTierByLifetimeProductId(productId: string): DonorTierProductIds | null {
  return DONOR_TIERS.find((t) => t.lifetimeProductId === productId) ?? null;
}

/* ------------------------------------------------ One-time store products */
/* B-C17/B-C19: the store also sells Aureus currency packs and one-time rank
 * upgrades as real-money one-time products. These ids/amounts MUST stay in
 * sync with the frontend's `gamedata.ts` (AUREUS_PACKS / RANK_UPGRADES) and
 * the PayNow dashboard — same discipline as DONOR_TIERS above. */

/** A real-money AUREUS currency pack (one-time). */
export interface AureusPackProduct {
  paynowProductId: string;
  priceUsd: number;
  /** Total AUREUS credited in-game (base + bulk bonus). */
  totalAureus: number;
}

export const AUREUS_PACKS: readonly AureusPackProduct[] = Object.freeze([
  { paynowProductId: '588822537060753408', priceUsd: 5, totalAureus: 500 },
  { paynowProductId: '588822549299724288', priceUsd: 10, totalAureus: 1000 },
  { paynowProductId: '588822560213311488', priceUsd: 15, totalAureus: 1500 },
  { paynowProductId: '588822572762660864', priceUsd: 25, totalAureus: 2750 },
  { paynowProductId: '588822585022619648', priceUsd: 50, totalAureus: 5600 },
  { paynowProductId: '588822595898445824', priceUsd: 100, totalAureus: 11500 },
  { paynowProductId: '588822608615571456', priceUsd: 150, totalAureus: 17700 },
  { paynowProductId: '588822619780812800', priceUsd: 200, totalAureus: 24000 },
  { paynowProductId: '588822632183369728', priceUsd: 250, totalAureus: 31250 },
  { paynowProductId: '588822644602707968', priceUsd: 500, totalAureus: 75000 },
]);

/** A one-time move up the lifetime donor ladder (only for existing lifetime owners). */
export interface RankUpgradeProduct {
  paynowProductId: string;
  priceUsd: number;
  /** Donor tier id (DonorTier enum name, uppercase) the upgrade grants. */
  toTier: string;
}

export const RANK_UPGRADES: readonly RankUpgradeProduct[] = Object.freeze([
  { paynowProductId: '587789607240728576', priceUsd: 15, toTier: 'PLEBEIAN' },
  { paynowProductId: '587789619249029120', priceUsd: 15, toTier: 'LIBERTUS' },
  { paynowProductId: '587789629961273344', priceUsd: 15, toTier: 'EQUES' },
  { paynowProductId: '587789640614805504', priceUsd: 30, toTier: 'PATRICIAN' },
  { paynowProductId: '587789652820234240', priceUsd: 30, toTier: 'CONSUL' },
  { paynowProductId: '587789661796048896', priceUsd: 30, toTier: 'IMPERATOR' },
]);

const AUREUS_PACK_PRODUCT_IDS = new Set(AUREUS_PACKS.map((p) => p.paynowProductId));
const RANK_UPGRADE_PRODUCT_IDS = new Set(RANK_UPGRADES.map((u) => u.paynowProductId));

/**
 * True for ANY product that can appear as a non-subscription line in a checkout:
 * lifetime donor ranks, rank upgrades, or Aureus packs. This is the cart's
 * one-time validation set — `isLifetimeProduct` deliberately stays narrower
 * because gifting is restricted to lifetime rank products only.
 */
export function isOneTimeStoreProduct(productId: string): boolean {
  return (
    LIFETIME_PRODUCT_IDS.has(productId) ||
    AUREUS_PACK_PRODUCT_IDS.has(productId) ||
    RANK_UPGRADE_PRODUCT_IDS.has(productId)
  );
}

/** Look up an Aureus pack's metadata by its PayNow product id. */
export function findAureusPack(productId: string): AureusPackProduct | null {
  return AUREUS_PACKS.find((p) => p.paynowProductId === productId) ?? null;
}

/** Look up a rank upgrade's metadata by its PayNow product id. */
export function findRankUpgrade(productId: string): RankUpgradeProduct | null {
  return RANK_UPGRADES.find((u) => u.paynowProductId === productId) ?? null;
}
