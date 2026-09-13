// One-shot currency_balances reconciliation: rebuilds the Supabase table from the
// live MySQL game DB (source of truth), eliminating legacy-key rows
// (money/tokens/beacons/gc) and any stale canonical rows.
//
// Background (2026-08-14/15 incident): the DB rows were re-keyed to the branded
// names (denarius/auctoritas/civitas/aureus) on 2026-08-06, but a source
// regression made the 2026-08-14 ~16:25 jar emit legacy keys again. Every active
// player's balance split across two rows per currency, and Supabase accumulated
// phantom legacy rows (including a pre-wipe 8.5B money value). The plugin fix
// (canonical keys everywhere, ImperiumMC-Plugin d541e8f) plus a MySQL merge ran
// on 2026-08-15; this script mirrors the result into Supabase.
//
// B-36 GUARDS (this file used to be "wipe and re-insert" with nothing between
// the operator and an empty/partial COMMIT — the P-14 shape):
//   1. --dry-run            prints the full plan (per-currency old/new/delta,
//                           dupes, confirm token) and performs NO writes.
//   2. --confirm <token>    required for a live run; the token is a sha256 of
//                           the exact source snapshot, so the operator must
//                           have previewed THIS data, and the source must not
//                           have shifted between preview and apply.
//   3. pre-image            a live run first writes currency_balances_pre_rebuild
//                           (id, uuid, currency, balance) inside the same
//                           transaction; a previous unconsumed pre-image refuses
//                           to run (--clear-pre-image archives it to
//                           currency_balances_pre_rebuild_consumed_<ts>).
//   4. empty abort          zero source rows never reaches the DELETE.
//   5. delta sanity         per-currency |new-old| > --max-delta-pct (default
//                           25%) aborts before the DELETE (--force-delta escapes).
//   6. deterministic dedupe canonical (uuid, currency) keys — the survivor is
//                           max(updated_at, then balance), never chunk order.
//   7. timestamps validated BEFORE the transaction — a NULL updated_at used to
//                           throw mid-run (new Date(null).toISOString()).
//
// Usage:
//   node rebuild-currency-balances.cjs --dry-run
//   node rebuild-currency-balances.cjs --clear-pre-image        # if a previous run left one
//   node rebuild-currency-balances.cjs --confirm <token-from-dry-run>
//
// Requires mysql2 + pg and both connection strings below (env vars win).

const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
const { Client } = require('pg');

const MYSQL_CFG = {
  host: 'narwhalnose.birdflop.com',
  port: 3306,
  user: 'u1907_TI8MRg8YZh',
  password: process.env.MYSQL_PASSWORD ?? 'xnimJLk2mllZ9LmcYYFvrq.C',
  database: 's1907_imperiummc_main',
};

const SUPABASE_CFG = {
  host: 'aws-0-us-east-1.pooler.supabase.com',
  port: 6543,
  database: 'postgres',
  user: 'postgres.rgqgaiwcuqmidbxggayk',
  password: (process.env.SUPABASE_PASSWORD ?? (() => { throw new Error('set SUPABASE_PASSWORD env — credentials no longer live in scripts'); })()),
  ssl: { rejectUnauthorized: false },
};

const PRE_IMAGE_TABLE = 'currency_balances_pre_rebuild';
const LEGACY_KEYS = ['money', 'tokens', 'beacons', 'gc'];
const DEFAULT_MAX_DELTA_PCT = 25;

/* ── pure helpers (unit-tested in src/test/rebuild-guards.test.ts) ────────── */

/**
 * Deterministic dedupe on the canonical key (uuid, currency): the survivor is
 * the row with max (updated_at, balance) — identical input always yields
 * identical output, unlike ON CONFLICT DO NOTHING which picked an arbitrary
 * survivor by chunk order. Returns { rows, dupes }.
 */
function dedupeRows(sourceRows) {
  const byKey = new Map();
  const dupes = [];
  const rank = (r) => `${r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at ?? '')}|${Number(r.balance ?? 0)}`;
  for (const row of sourceRows) {
    const key = `${row.uuid}|${row.currency}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, row);
      continue;
    }
    dupes.push(key);
    // Keep the higher rank (later write wins; tie -> higher balance).
    if (rank(row) > rank(existing)) byKey.set(key, row);
  }
  // Sort output by canonical key so the plan and the token are stable.
  const rows = [...byKey.values()].sort((a, b) => (a.uuid + '|' + a.currency < b.uuid + '|' + b.currency ? -1 : 1));
  return { rows, dupes: [...new Set(dupes)] };
}

/** sha256 over the sorted canonical rows — the confirm token for this snapshot. */
function deriveConfirmToken(dedupedRows) {
  const canonical = dedupedRows
    .map((r) => `${r.uuid}|${r.currency}|${r.balance}`)
    .join('\n');
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}

/** Per-currency old-vs-new totals + percent delta. `currentRows` = Postgres pre-image shape. */
function summarizeCurrencies(dedupedRows, currentRows) {
  const sum = (list) => {
    const out = new Map();
    for (const r of list) out.set(r.currency, (out.get(r.currency) ?? 0) + Number(r.balance ?? 0));
    return out;
  };
  const oldSums = sum(currentRows);
  const newSums = sum(dedupedRows);
  const currencies = new Set([...oldSums.keys(), ...newSums.keys()]);
  const lines = [];
  for (const c of [...currencies].sort()) {
    const oldTotal = oldSums.get(c) ?? 0;
    const newTotal = newSums.get(c) ?? 0;
    const deltaPct = oldTotal === 0 ? (newTotal === 0 ? 0 : Infinity) : Math.abs((newTotal - oldTotal) / oldTotal) * 100;
    lines.push({ currency: c, oldTotal, newTotal, deltaPct });
  }
  return lines;
}

/** Guard violations for the plan: empty source, per-currency delta cap, bad timestamps. */
function planViolations(dedupedRows, currentRows, maxDeltaPct) {
  const violations = [];
  if (dedupedRows.length === 0) violations.push('SOURCE_EMPTY: MySQL returned 0 rows — refusing to wipe the mirror');
  for (const l of summarizeCurrencies(dedupedRows, currentRows)) {
    if (l.deltaPct > maxDeltaPct) {
      violations.push(
        `DELTA_CAP: ${l.currency} would change ${l.oldTotal} -> ${l.newTotal} (${l.deltaPct.toFixed(1)}% > ${maxDeltaPct}%)`,
      );
    }
  }
  // Invalid timestamps would throw inside the transaction (new Date(null).toISOString()).
  for (const r of dedupedRows) {
    const t = r.updated_at;
    const invalid = t === null || t === undefined || Number.isNaN(new Date(t).getTime());
    if (invalid) {
      violations.push(`BAD_TIMESTAMP: ${r.uuid}/${r.currency} has updated_at=${JSON.stringify(t)}`);
      break; // one report is enough to stop the run
    }
  }
  return violations;
}

module.exports = { dedupeRows, deriveConfirmToken, summarizeCurrencies, planViolations, PRE_IMAGE_TABLE };

/* ── one-shot runner (only when invoked directly, not under test) ─────────── */

function parseArgs(argv) {
  const out = { dryRun: false, confirm: null, clearPreImage: false, maxDeltaPct: DEFAULT_MAX_DELTA_PCT, forceDelta: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--confirm') out.confirm = argv[++i] ?? null;
    else if (a === '--clear-pre-image') out.clearPreImage = true;
    else if (a === '--force-delta') out.forceDelta = true;
    else if (a === '--max-delta-pct') out.maxDeltaPct = Number(argv[++i]);
    else { console.error(`Unknown flag: ${a}`); process.exit(2); }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const my = await mysql.createConnection(MYSQL_CFG);
  const [rows] = await my.query(
    'SELECT uuid, currency, balance, updated_at FROM currency_balances'
  );
  await my.end();
  console.log('MySQL source rows:', rows.length);

  const legacy = rows.filter((r) => LEGACY_KEYS.includes(r.currency));
  if (legacy.length > 0) {
    console.error(
      'ABORT: MySQL still has ' + legacy.length + ' legacy-key rows — run the MySQL merge first.'
    );
    process.exit(1);
  }

  const { rows: deduped, dupes } = dedupeRows(rows);
  if (dupes.length > 0) {
    console.warn(`Dedupe: ${dupes.length} canonical-key duplicate(s) collapsed deterministically (max updated_at, then balance)`);
  }
  const token = deriveConfirmToken(deduped);

  const c = new Client(SUPABASE_CFG);
  await c.connect();

  // Unconsumed pre-image from a previous run: refuse until acknowledged.
  const preExists = await c.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = '${PRE_IMAGE_TABLE}') AS ok`,
  );
  if (preExists.rows[0]?.ok) {
    const preCount = await c.query(`SELECT COUNT(*)::int AS n FROM ${PRE_IMAGE_TABLE}`);
    if ((preCount.rows[0]?.n ?? 0) > 0 && !args.clearPreImage) {
      console.error(
        `ABORT: ${PRE_IMAGE_TABLE} still holds ${preCount.rows[0].n} unconsumed rows from a previous run — ` +
        `verify/recover from it, then re-run with --clear-pre-image (it is archived, not deleted).`,
      );
      await c.end();
      process.exit(1);
    }
    if (args.clearPreImage) {
      const archive = `${PRE_IMAGE_TABLE}_consumed_${Date.now()}`;
      await c.query(`ALTER TABLE ${PRE_IMAGE_TABLE} RENAME TO ${archive}`);
      console.log(`Archived previous pre-image as ${archive}`);
    }
  }

  // Current mirror state — the delta baseline and the pre-image source.
  const current = await c.query('SELECT id, uuid, currency, balance FROM currency_balances');
  const currentRows = current.rows;

  const summary = summarizeCurrencies(deduped, currentRows);
  console.table(summary.map((l) => ({ ...l, deltaPct: Number.isFinite(l.deltaPct) ? l.deltaPct.toFixed(2) + '%' : 'new' })));

  const violations = planViolations(deduped, currentRows, args.maxDeltaPct);
  if (violations.length > 0) {
    for (const v of violations) console.error('GUARD:', v);
    if (!args.forceDelta) {
      console.error('ABORT: guards tripped (see above). --force-delta overrides DELTA_CAP only — SOURCE_EMPTY and BAD_TIMESTAMP are never overridable.');
      await c.end();
      process.exit(1);
    }
    if (violations.some((v) => v.startsWith('SOURCE_EMPTY') || v.startsWith('BAD_TIMESTAMP'))) {
      console.error('ABORT: SOURCE_EMPTY / BAD_TIMESTAMP are never overridable.');
      await c.end();
      process.exit(1);
    }
    console.warn("--force-delta: proceeding past DELTA_CAP at the operator's explicit risk.");
  }

  if (args.dryRun) {
    console.log('DRY RUN — no writes performed.');
    console.log('Confirm token for this exact source snapshot:');
    console.log('  ' + token);
    console.log('Apply with: node rebuild-currency-balances.cjs --confirm ' + token);
    await c.end();
    return;
  }

  if (!args.confirm) {
    console.error('ABORT: live runs need --confirm <token>. Run with --dry-run first to preview the plan and get the token.');
    await c.end();
    process.exit(1);
  }
  if (args.confirm !== token) {
    console.error(
      'ABORT: confirm token mismatch — the MySQL source changed since the preview (or the token is wrong). Re-run --dry-run for the current token.',
    );
    await c.end();
    process.exit(1);
  }

  await c.query('BEGIN');
  try {
    // Pre-image FIRST, inside the transaction (B-36): the exact rows being
    // replaced, recoverable with plain SQL if anything looks wrong after.
    await c.query(
      `CREATE TABLE ${PRE_IMAGE_TABLE} AS SELECT id, uuid, currency, balance FROM currency_balances`,
    );
    console.log('Pre-image written:', currentRows.length, 'rows into', PRE_IMAGE_TABLE);

    const del = await c.query('DELETE FROM currency_balances');
    console.log('deleted existing rows:', del.rowCount);
    for (let i = 0; i < deduped.length; i += 50) {
      const chunk = deduped.slice(i, i + 50);
      const values = chunk
        .map((_, j) => `($${j * 4 + 1},$${j * 4 + 2},$${j * 4 + 3},$${j * 4 + 4})`)
        .join(',');
      await c.query(
        'INSERT INTO currency_balances (uuid, currency, balance, updated_at) VALUES ' +
          values,
        chunk.flatMap((r) => [r.uuid, r.currency, r.balance, new Date(r.updated_at).toISOString()]),
      );
    }
    const g = await c.query(
      'SELECT currency, COUNT(*)::int cnt, SUM(balance)::float total FROM currency_balances GROUP BY currency ORDER BY currency'
    );
    console.table(g.rows);

    const inserted = await c.query('SELECT COUNT(*)::int AS n FROM currency_balances');
    if (inserted.rows[0].n !== deduped.length) {
      throw new Error(`post-verify failed: inserted ${inserted.rows[0].n} rows, expected ${deduped.length}`);
    }
    await c.query('COMMIT');
    console.log('COMMITTED (pre-image kept in', PRE_IMAGE_TABLE, 'for recovery; next run refuses until --clear-pre-image)');
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('ROLLED BACK:', e.message);
    process.exit(1);
  }
  await c.end();
}

if (require.main === module) {
  main().catch((e) => {
    console.error('ERR', e.message);
    process.exit(1);
  });
}
