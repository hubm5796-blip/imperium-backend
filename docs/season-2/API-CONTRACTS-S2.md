# Season 2 — API contracts

> **STATUS (2026-10-24): PLANNED — 0/9 endpoints implemented** (no `/admin/deliveries` etc. in `routes.ts`). Design reference only.

Endpoints Season 2 adds or changes, and who consumes each. Agree any shape
change with the consuming lane via a cross-lane request **before** building it;
a contract discovered at integration time costs both lanes a rebase.

All `/admin/*` routes are gated by the fail-closed RBAC from **S2-D01**. Any
route added before that packet lands must still deny by default.

---

## Delivery

### `GET /admin/deliveries`
Consumer: panel / Lane E · Packet: S2-D02

Query: `status` (`pending|delivered|stale|failed`), `from`, `to`, `product_id`, `limit`, `cursor`.

```jsonc
{
  "items": [{
    "order_id": "590329622256685056",
    "pretty_id": "pn-4hgmdwlcglc0",
    "customer": { "name": "koshr", "uuid": "ebc5b958-c3f1-41b6-87d9-93388ae70cc1" },
    "product_id": "587751519030345728",
    "sku_label": "Imperator (Lifetime)",
    "commands_issued": ["lp user {uuid} parent add donor_imperator"],
    "executed_at": ["2026-08-09T22:22:04Z"],
    "grant_verified_at": "2026-08-09T22:22:09Z",
    "grant_evidence": { "donor_tier_row": 41, "tier": "IMPERATOR" },
    "status": "delivered"
  }],
  "next_cursor": null
}
```

`grant_verified_at` is the field that matters. A row with `executed_at` set and
`grant_verified_at` null means **the command ran and the player still did not
get the thing** — which is exactly the M-01 failure mode, and the reason this
endpoint exists.

### `POST /admin/deliveries/{order_id}/reverify`
Consumer: panel · Packet: S2-D02

Re-runs the grant check for one order. Idempotent; never re-issues commands.

---

## Economy

### `GET /admin/economy/snapshot`
Consumers: Lane E (S2-E05), alerting (S2-D06) · Packet: S2-D05

Query: `days` (default 90).

```jsonc
{
  "as_of": "2026-09-18",
  "series": [{
    "date": "2026-09-18",
    "total_supply": 613000000,
    "gini": 0.971,
    "top1_share": 0.911,
    "issuance_by_faucet": { "mining:sell": 0.41, "crate:reward": 0.18 },
    "drain_by_sink":     { "rank:cost": 0.52, "enchant:cost": 0.21 },
    "net_delta": 0.043
  }],
  "thresholds": { "gini_max": 0.85, "weekly_net_delta_max": 0.15, "faucet_share_max": 0.25 }
}
```

`issuance_by_faucet` and `drain_by_sink` are **shares that sum to 1**, keyed by
the `service:action` reason strings the plugin's `EconomyService` already emits.
The faucet registry (Lane A, S2-A02/S2-A09) is the authority on the key set; an
unregistered key appearing here is itself a finding.

### `GET /admin/economy/faucets`
Consumer: panel · Packet: S2-D05

Per-faucet: 7-day issuance, share of total, registry ceiling, breach count.

---

## Retention

### `GET /admin/retention/cohorts`
Consumer: Lane E (S2-E06) · Packet: S2-D07

Query: `from`, `to`, `source` (optional).

```jsonc
{
  "cohorts": [{
    "join_week": "2026-W38",
    "size": 42,
    "d1": 0.31, "d7": 0.14, "d30": 0.05,
    "by_source": { "minecraft-mp": { "size": 18, "d1": 0.28 } }
  }]
}
```

### `GET /admin/retention/funnel`
Consumer: Lane E (S2-E06) · Packet: S2-D07

Stages, in order, with absolute counts and stage-over-stage conversion:
`joined` -> `rank_ii` -> `rank_v` -> `first_purchase` -> `d7_return`.

`source` comes from Lane E's attribution (S2-E09). Agree the field name and
allowed values with them before building; an unattributed join must be
`"source": "direct"`, never null.

---

## Revenue

### `GET /admin/revenue/summary`
Consumer: panel · Packet: S2-D09

Query: `granularity` (`month|week`), `from`, `to`.

Returns gross, refunds, chargebacks, net, order count, and a per-SKU breakdown.

**Contract test:** with no date filter, the historical total is exactly one
completed order, $149.99, 2026-08-09. If it is not, the endpoint is wrong — not
the history.

---

## Observability

### `GET /admin/ops/launch`
Consumer: Lane E (S2-E-side render) / panel · Packet: S2-D08

One composite payload, fields ordered by triage priority: `error_rate`, `tps`,
`new_player_funnel`, `economy_snapshot`, `store_deliveries`. Deliberately a
single call so the launch-day page cannot half-load.

---

## Changed behaviour on existing routes

| Route | Change | Packet |
|---|---|---|
| all `/admin/*` | Fail-closed RBAC; default-credential exemption removed | S2-D01 |
| auth issue/verify | Separate secrets per JWT implementation; constant-time compare; UUID validation | S2-D04 |
| session | Shorter lifetime + revocation list (frontend counterpart S2-E04) | S2-D04 |

## Not being added, on purpose

An `order_completed` webhook subscription. Live delivery runs through PayNow
commands executed by the PayNow plugin; adding the webhook without stripping
commands in the same change **double-delivers every product**. If delivery ever
moves to webhooks, it is a single atomic change, not two.
