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
// Usage: node rebuild-currency-balances.cjs
// Requires mysql2 + pg (see package.json / .secrets/node_modules) and both
// connection strings below. Idempotent: wipes and re-inserts in one transaction.

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
  password: process.env.SUPABASE_PASSWORD ?? 'KCxtU9fjBMkZDRC&',
  ssl: { rejectUnauthorized: false },
};

(async () => {
  const my = await mysql.createConnection(MYSQL_CFG);
  const [rows] = await my.query(
    'SELECT uuid, currency, balance, updated_at FROM currency_balances'
  );
  await my.end();
  console.log('MySQL source rows:', rows.length);

  const legacy = rows.filter((r) =>
    ['money', 'tokens', 'beacons', 'gc'].includes(r.currency)
  );
  if (legacy.length > 0) {
    console.error(
      'ABORT: MySQL still has ' + legacy.length + ' legacy-key rows — run the MySQL merge first.'
    );
    process.exit(1);
  }

  const c = new Client(SUPABASE_CFG);
  await c.connect();
  await c.query('BEGIN');
  try {
    const del = await c.query('DELETE FROM currency_balances');
    console.log('deleted existing rows:', del.rowCount);
    for (let i = 0; i < rows.length; i += 50) {
      const chunk = rows.slice(i, i + 50);
      const values = chunk
        .map((_, j) => `($${j * 4 + 1},$${j * 4 + 2},$${j * 4 + 3},$${j * 4 + 4})`)
        .join(',');
      await c.query(
        'INSERT INTO currency_balances (uuid, currency, balance, updated_at) VALUES ' +
          values +
          ' ON CONFLICT (uuid, currency) DO NOTHING',
        chunk.flatMap((r) => [r.uuid, r.currency, r.balance, new Date(r.updated_at).toISOString()])
      );
    }
    const g = await c.query(
      'SELECT currency, COUNT(*)::int cnt, SUM(balance)::float total FROM currency_balances GROUP BY currency ORDER BY currency'
    );
    console.table(g.rows);
    await c.query('COMMIT');
    console.log('COMMITTED');
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('ROLLED BACK:', e.message);
    process.exit(1);
  }
  await c.end();
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
