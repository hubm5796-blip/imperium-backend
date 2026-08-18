// 12a expansion: web shop (shop-lite) catalog.
//
// The shop sells AUREUS (premium currency) packs and crate key packs, priced
// in Denarius (the standard in-game currency). Payment and grant both happen
// plugin-side: the backend only validates the SKU, records the order in
// web_queue, and the plugin's queue consumer re-validates the price, withdraws
// the Denarius, and grants via the normal single paths (EconomyService
// .depositPremium for AUREUS — the AUREUS wall is never bypassed; CrateService
// for keys). Because the plugin re-validates, these prices are the *display*
// source of truth — keep them in sync with the plugin's WebQueue consumer if
// they ever change.
//
// Static (not a DB read) for the same reason /api/server/features is static:
// the catalog only changes at release boundaries, and a constant catalog
// cannot 503. Crate ids below must match the plugin's crates.yml crate ids.

export type ShopItemKind = 'aureus' | 'crate_key';

export interface ShopItem {
  sku: string;
  kind: ShopItemKind;
  name: string;
  description: string;
  /** Price in whole Denarius (display units, not minor). */
  price: number;
  /** What the plugin grants: AUREUS amount (kind='aureus') or crate keys (kind='crate_key'). */
  grant: {
    aureus?: number;
    crateId?: string;
    keyAmount?: number;
  };
}

export const SHOP_CATALOG: readonly ShopItem[] = Object.freeze([
  {
    sku: 'aureus_100',
    kind: 'aureus',
    name: '100 AUREUS',
    description: '100 units of premium currency, delivered in-game.',
    price: 5_000,
    grant: { aureus: 100 },
  },
  {
    sku: 'aureus_550',
    kind: 'aureus',
    name: '550 AUREUS',
    description: '550 units of premium currency (10% bonus), delivered in-game.',
    price: 25_000,
    grant: { aureus: 550 },
  },
  {
    sku: 'aureus_1200',
    kind: 'aureus',
    name: '1200 AUREUS',
    description: '1200 units of premium currency (20% bonus), delivered in-game.',
    price: 50_000,
    grant: { aureus: 1200 },
  },
  {
    sku: 'key_vote_5',
    kind: 'crate_key',
    name: '5 Vote Crate Keys',
    description: 'Five keys for the Vote crate.',
    price: 7_500,
    grant: { crateId: 'vote', keyAmount: 5 },
  },
  {
    sku: 'key_rare_3',
    kind: 'crate_key',
    name: '3 Rare Crate Keys',
    description: 'Three keys for the Rare crate.',
    price: 20_000,
    grant: { crateId: 'rare', keyAmount: 3 },
  },
  {
    sku: 'key_legendary_1',
    kind: 'crate_key',
    name: '1 Legendary Crate Key',
    description: 'One key for the Legendary crate.',
    price: 45_000,
    grant: { crateId: 'legendary', keyAmount: 1 },
  },
]);

export function findShopItem(sku: string): ShopItem | null {
  return SHOP_CATALOG.find((item) => item.sku === sku) ?? null;
}
