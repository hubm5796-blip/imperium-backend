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

/** True if `productId` is one of the 7 one-time lifetime rank products. */
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

/* ── B-C30/B-C33: consumable catalogs (crate keys, boosters) ──────────────
 * The dispatch MECHANISM for both is live end-to-end (fulfillment.ts maps
 * them to STORE_PURCHASE_CRATE_KEY / STORE_PURCHASE_BOOSTER and this file's
 * ids feed isOneTimeStoreProduct, so checkout accepts them the moment they
 * exist). Crate-key products exist (2026-09-13); booster products do not yet,
 * so BOOSTER_PACKS ships empty. Each entry is created in PayNow first, then the
 * id pasted here (same discipline as AUREUS_PACKS, which must also stay in
 * sync with the frontend's gamedata.ts). */

/** A real-money crate-key bundle (one-time). */
export interface CrateKeyPackProduct {
  paynowProductId: string;
  priceUsd: number;
  /** In-game crate id the keys open (e.g. 'vote', 'plebeia'). */
  crateId: string;
  /** Keys in one bundle (multiplied by the order-line quantity at dispatch). */
  keyAmount: number;
}

/** Mirrors the frontend's CRATE_KEY_BUNDLES. Live delivery today is the PayNow
 * product's own `crate give` command (online_only); the store has no
 * order_completed webhook subscribed. Subscribing one would ALSO dispatch these
 * (and every Aureus/rank product) — strip the PayNow commands in the same change. */
export const CRATE_KEY_PACKS: readonly CrateKeyPackProduct[] = Object.freeze([
  { paynowProductId: '602731267938590720', priceUsd: 2.49, crateId: 'basic', keyAmount: 5 },
  { paynowProductId: '602731440542584832', priceUsd: 5.99, crateId: 'uncommon', keyAmount: 5 },
  { paynowProductId: '602731454740307968', priceUsd: 12.99, crateId: 'rare', keyAmount: 5 },
  { paynowProductId: '602731470078877696', priceUsd: 14.99, crateId: 'epic', keyAmount: 3 },
  { paynowProductId: '602731483005722624', priceUsd: 29.99, crateId: 'legendary', keyAmount: 3 },
  { paynowProductId: '602731496293269504', priceUsd: 24.99, crateId: 'mythic', keyAmount: 1 },
]);

/** Centurion Starter Pack ($19.99, one per customer, not giftable). Delivered by
 * the PayNow product's own commands (lifetime donor_plebeian, 500 Aureus, 3 rare
 * keys, 2h x2 sell booster) — it needs no order_completed dispatch mapping. */
export const STARTER_PACK_PRODUCT_ID = '603072663803396096';

/** A real-money booster pack (one-time). */
export interface BoosterPackProduct {
  paynowProductId: string;
  priceUsd: number;
  /**
   * In-game booster id. Must be a BoosterType enum name from the plugin's
   * economy/BoosterTypes.kt (SELL_MULTIPLIER, XP_MULTIPLIER, TOKEN_MULTIPLIER,
   * MINE_SPEED, LUCK, MONEY_RAIN) — the plugin parses case-insensitively and
   * rejects unknown values.
   */
  boosterId: string;
  /** Booster units in one pack (multiplied by the order-line quantity at dispatch). */
  boosterAmount: number;
}

/** OWNER DATA (B-C33): empty until booster products exist in PayNow. */
export const BOOSTER_PACKS: readonly BoosterPackProduct[] = Object.freeze([
  // e.g. { paynowProductId: '<id-from-paynow-dashboard>', priceUsd: 3, boosterId: 'SELL_MULTIPLIER', boosterAmount: 1 },
]);

const CRATE_KEY_PACK_PRODUCT_IDS = new Set(CRATE_KEY_PACKS.map((p) => p.paynowProductId));
const BOOSTER_PACK_PRODUCT_IDS = new Set(BOOSTER_PACKS.map((p) => p.paynowProductId));

/**
 * True for ANY product that can appear as a non-subscription line in a checkout:
 * lifetime donor ranks, rank upgrades, Aureus packs, crate-key bundles (B-C30),
 * booster packs (B-C33), or the starter pack. This is the cart's one-time
 * validation set; `isGiftableProduct` is the narrower gift set.
 */
export function isOneTimeStoreProduct(productId: string): boolean {
  return (
    LIFETIME_PRODUCT_IDS.has(productId) ||
    AUREUS_PACK_PRODUCT_IDS.has(productId) ||
    RANK_UPGRADE_PRODUCT_IDS.has(productId) ||
    CRATE_KEY_PACK_PRODUCT_IDS.has(productId) ||
    BOOSTER_PACK_PRODUCT_IDS.has(productId) ||
    productId === STARTER_PACK_PRODUCT_ID
  );
}

/**
 * True for products that can be bought as a gift for another player: lifetime
 * ranks, Aureus packs and crate-key bundles — the set with gifting enabled in
 * PayNow. Subscriptions (no payment method on the recipient for renewals),
 * upgrades (require the recipient to own the lower lifetime) and the starter
 * pack (first-purchase offer) stay self-purchase only.
 */
export function isGiftableProduct(productId: string): boolean {
  return (
    LIFETIME_PRODUCT_IDS.has(productId) ||
    AUREUS_PACK_PRODUCT_IDS.has(productId) ||
    CRATE_KEY_PACK_PRODUCT_IDS.has(productId)
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

/** Look up a crate-key bundle's metadata by its PayNow product id (B-C30). */
export function findCrateKeyPack(productId: string): CrateKeyPackProduct | null {
  return CRATE_KEY_PACKS.find((p) => p.paynowProductId === productId) ?? null;
}

/** Look up a booster pack's metadata by its PayNow product id (B-C33). */
export function findBoosterPack(productId: string): BoosterPackProduct | null {
  return BOOSTER_PACKS.find((p) => p.paynowProductId === productId) ?? null;
}
