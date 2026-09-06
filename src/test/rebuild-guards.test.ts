/**
 * B-36 — rebuild-currency-balances guards (pure planning helpers).
 *
 * The script used to be "DELETE everything, re-insert one unbounded SELECT,
 * COMMIT" — a zero-row or truncated source read COMMITted an empty/partial
 * mirror (the P-14 shape), dupes collapsed by chunk order via ON CONFLICT DO
 * NOTHING, and nothing was kept to recover from.
 *
 * The runner (CLI + MySQL/PG wiring) is exercised by the operator; these
 * tests pin the pure planning helpers the guards are built on:
 *   - deterministic dedupe on canonical keys (max updated_at, then balance);
 *   - the confirm token is a function of the exact deduped snapshot (stable
 *     across runs, changes when any balance changes);
 *   - per-currency delta summary feeding the cap;
 *   - planViolations: empty source, delta cap, bad timestamps.
 */
import { describe, expect, it } from 'vitest';
// The .cjs script exports its pure helpers and only runs main() when invoked
// directly, so importing it here is side-effect free. It has no type
// declarations (one-shot operator script) — the shape is asserted by the tests.
// @ts-expect-error no declaration file for the .cjs module (by design)
const helpers = (await import('../../rebuild-currency-balances.cjs')) as unknown as {
  dedupeRows: (rows: Array<Record<string, unknown>>) => { rows: Array<Record<string, unknown>>; dupes: string[] };
  deriveConfirmToken: (rows: Array<Record<string, unknown>>) => string;
  summarizeCurrencies: (
    deduped: Array<Record<string, unknown>>,
    current: Array<Record<string, unknown>>,
  ) => Array<{ currency: string; oldTotal: number; newTotal: number; deltaPct: number }>;
  planViolations: (
    deduped: Array<Record<string, unknown>>,
    current: Array<Record<string, unknown>>,
    maxDeltaPct: number,
  ) => string[];
  PRE_IMAGE_TABLE: string;
};

const row = (uuid: string, currency: string, balance: number, updated_at: string | Date | null) => ({
  uuid, currency, balance, updated_at,
});

describe('B-36: rebuild script guards', () => {
  it('dedupes canonical keys deterministically — later write wins, tie -> higher balance', () => {
    const a = row('u1', 'denarius', 100, '2026-08-01T00:00:00Z');
    const b = row('u1', 'denarius', 200, '2026-08-02T00:00:00Z'); // later write
    const c = row('u1', 'civitas', 50, '2026-08-01T00:00:00Z');
    // Feed in an order designed to catch chunk-order dependence.
    const { rows, dupes } = helpers.dedupeRows([a, b, c]);
    expect(rows).toHaveLength(2);
    expect(dupes).toEqual(['u1|denarius']);
    const den = rows.find((r) => r.currency === 'denarius')!;
    expect(den.balance).toBe(200);

    // Same input, shuffled — same output (deterministic, unlike DO NOTHING).
    const again = helpers.dedupeRows([c, b, a]);
    expect(again.rows.map((r) => `${r.uuid}|${r.currency}|${r.balance}`).sort())
      .toEqual(rows.map((r) => `${r.uuid}|${r.currency}|${r.balance}`).sort());

    // Tie on updated_at -> higher balance survives.
    const tie = helpers.dedupeRows([
      row('u2', 'aureus', 10, '2026-08-01T00:00:00Z'),
      row('u2', 'aureus', 30, '2026-08-01T00:00:00Z'),
    ]);
    expect(tie.rows[0]!.balance).toBe(30);
  });

  it('the confirm token is stable for the same snapshot and changes when any balance changes', () => {
    const snap = [row('u1', 'denarius', 100, '2026-08-01T00:00:00Z'), row('u2', 'civitas', 5, '2026-08-01T00:00:00Z')];
    const t1 = helpers.deriveConfirmToken(helpers.dedupeRows(snap).rows);
    const t2 = helpers.deriveConfirmToken(helpers.dedupeRows([...snap].reverse()).rows);
    expect(t1).toBe(t2); // order-independent
    expect(t1).toHaveLength(32);
    const changed = helpers.deriveConfirmToken(
      helpers.dedupeRows([row('u1', 'denarius', 101, '2026-08-01T00:00:00Z'), snap[1]!]).rows,
    );
    expect(changed).not.toBe(t1); // a one-unit balance shift invalidates the token
  });

  it('summarizeCurrencies computes old/new totals and percent deltas', () => {
    const deduped = [row('u1', 'denarius', 120, '2026-08-01T00:00:00Z')];
    const current = [{ currency: 'denarius', balance: 100 }];
    const [line] = helpers.summarizeCurrencies(deduped, current);
    expect(line).toMatchObject({ currency: 'denarius', oldTotal: 100, newTotal: 120 });
    expect(line!.deltaPct).toBeCloseTo(20, 5);
  });

  it('planViolations trips on an empty source (the wipe-everything case)', () => {
    const violations = helpers.planViolations([], [{ currency: 'denarius', balance: 1000 }], 25);
    expect(violations.some((v) => v.startsWith('SOURCE_EMPTY'))).toBe(true);
  });

  it('planViolations trips when a currency exceeds the delta cap', () => {
    // 300 -> 400 is a 33.3% delta: trips a 25% cap, passes a 99% cap.
    const deduped = [row('u1', 'denarius', 400, '2026-08-01T00:00:00Z')];
    const current = [{ currency: 'denarius', balance: 300 }];
    expect(helpers.planViolations(deduped, current, 25).some((v) => v.startsWith('DELTA_CAP'))).toBe(true);
    expect(helpers.planViolations(deduped, current, 99).some((v) => v.startsWith('DELTA_CAP'))).toBe(false);
  });

  it('planViolations trips on a NULL/invalid updated_at before the transaction can throw', () => {
    const deduped = [row('u1', 'denarius', 100, null)];
    expect(helpers.planViolations(deduped, [], 25).some((v) => v.startsWith('BAD_TIMESTAMP'))).toBe(true);
    const invalid = [row('u1', 'denarius', 100, 'not-a-date' as unknown as string)];
    expect(helpers.planViolations(invalid, [], 25).some((v) => v.startsWith('BAD_TIMESTAMP'))).toBe(true);
  });

  it('exports the pre-image table name the runner refuses to overwrite', () => {
    expect(helpers.PRE_IMAGE_TABLE).toBe('currency_balances_pre_rebuild');
  });
});
