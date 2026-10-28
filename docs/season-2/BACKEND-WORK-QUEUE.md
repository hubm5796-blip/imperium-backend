# Lane D — Backend Work Queue (Season 2)

> **STATUS (2026-10-28, updated at the one-trunk merge):** S2-D01 (fail-closed RBAC, `src/middleware/gates.ts`), S2-D02 (delivery ledger + `GET /api/v2/admin/deliveries`) and S2-D03 (failed-delivery alerting) LANDED 2026-10-28 from the origin lineage. `API-CONTRACTS-S2.md` is PARTIAL — remaining packets still not started.

Backend-specific detail for the nine Lane D packets. The authoritative status
column lives in `ImperiumMC-Plugin/docs/season-2/08-WORK-QUEUE.md`; update both.

---

## Wave 0

### S2-D01 — B-01 staff RBAC (MUST, wave barrier)

**The defect.** The default-credential path bypasses every `/admin/*` role gate.
Valid staff credentials get **less** access than none — the privilege model is
inverted. Two findings compound it: `X-04` (the frontend never sends staff
headers, so it always lands on the exemption) and `X-03` (audit attribution is
defeated; real staff actions log spoof warnings).

**Do.**
1. Remove the default-credential exemption entirely. No credential means no access.
2. Make every `/admin/*` route declare its required role explicitly; deny by default.
3. Attribute every admin action to the authenticated principal, and make a
   spoofed or absent principal a 401, not a warning.
4. Coordinate with Lane E: the frontend must send staff headers (S2-E-side
   change — file a cross-lane request).

**Acceptance.** Regression tests that fail on the old code: default path 401/403
on every `/admin/*` route; a valid staff token reaches exactly its role's routes
and nothing else; an admin action writes an attributed audit row.

---

## Wave 1

### S2-D02 — Delivery ledger (MUST)

**Why.** There is currently no way to answer "did this purchase deliver?"
without manual inspection. The one order in the store's history was bought into
a catalog whose donor perks did not deliver at all (finding M-01).

**Schema sketch.**

| Column | Notes |
|---|---|
| `order_id` | PayNow order id |
| `product_id`, `sku_label` | as of purchase |
| `commands_issued` | JSON array, as sent |
| `executed_at` | per command, nullable |
| `grant_verified_at` | set when the in-game effect is confirmed |
| `grant_evidence` | e.g. donor tier row id, currency delta, key count |
| `status` | `pending` / `delivered` / `stale` / `failed` |

**Endpoint.** `GET /admin/deliveries` with filters by status and date.

**Acceptance.** A purchase writes a row; a command that never executes is
visible as `stale`, not as silence.

### S2-D03 — Failed-delivery alerting (MUST)

Any delivery command queued more than 24h unexecuted raises a Discord alert.
**Dedupe:** a seeded stale row produces exactly one alert, not a loop, and a
later execution posts a resolve.

### S2-D04 — Token hygiene (MUST)

Four findings, one packet:

- **X-01** — one `JWT_SECRET` shared across two JWT implementations. Separate them.
- **B-02** — the delegated-principal token split is logically unreachable. Make
  the delegation path reachable and test it, or delete it. Dead auth code is worse
  than none because it reads as a control that exists.
- **B-03** — non-timing-safe token compare, and `:`-delimited token maps.
  Constant-time compare; a delimiter that cannot appear in a token component.
- **B-06** — delegated UUID accepted without format validation.

Also **B-07** (7-day JWT with no `jti` or revocation) and **B-10** (the
slash-command route signs a nonce it never stores) fold in here if capacity
allows.

---

## Wave 2

### S2-D05 — Economy snapshot API (MUST)

Persist a **daily row**: total supply, gini, top-1% share, issuance by faucet,
drain by sink, net supply delta. `WealthMonitor` in the plugin already computes
gini live; this packet is about surfacing and **persisting** it so history
exists — the absence of history is why a 0.971 gini was a discovery rather than
a trend.

`GET /admin/economy/snapshot` returns today plus a 90-day series.
Consumed by Lane E (S2-E05).

### S2-D06 — Economy alerting (MUST)

Three thresholds to Discord, deduped, one alert per breach window with a resolve:

- gini > 0.85
- weekly net supply delta > +15%
- any single faucet > 25% of issuance in a rolling 7-day window

That last one is the important one: in this genre, an overtuned faucet and an
actively exploited faucet look identical from the outside, and both need the
same response.

---

## Wave 3

### S2-D07 — Retention instrumentation API (MUST)

- Per-account `first_seen`, `last_seen`, session count, session length.
- `GET /admin/retention/cohorts` — D1/D7/D30 by join week, sliceable by
  acquisition source.
- `GET /admin/retention/funnel` — joined -> rank II -> rank V -> first purchase
  -> D7 return.

Acquisition source arrives from Lane E's attribution work (S2-E09); agree the
field shape with them via a cross-lane request before building.

**Acceptance.** Correct numbers against a seeded dataset with known cohorts —
not "it returns rows".

---

## Wave 4

### S2-D08 — Launch-day observability (MUST)

One page, in this order, because that is the triage order in the launch runbook:
**error rate -> TPS -> new-player funnel -> economy snapshot -> store
deliveries.** It should be the only page the owner needs open for the first four
hours.

### S2-D09 — Revenue dashboard (SHOULD)

Gross, refunds, chargebacks, per-SKU, per-month, so the `[assumption]` rows in
`01-BUSINESS-PLAN.md` can be replaced with actuals.

**Reconciliation test:** the historical total must come out at exactly one
completed order — `pn-4hgmdwlcglc0`, $149.99 (including $9.81 Ohio tax),
2026-08-09, product *Imperator (Lifetime)*. If the dashboard disagrees with
that, the dashboard is wrong.

---

## Verification for every packet

`tsc --noEmit` green, `vitest run` green, and for anything security- or
economy-related a regression test that **fails on the pre-fix code**. A type
that says an endpoint should work is not a test that it does.
