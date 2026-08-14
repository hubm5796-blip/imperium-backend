// Idempotent backend-table migration for the ImperiumMC Supabase Postgres.
//
// All 7 target tables already existed (created by an earlier migration), but
// several had schemas that didn't match what src/api/routes.ts actually queries,
// which would make those routes 500. This script is fully idempotent:
//   - CREATE TABLE IF NOT EXISTS (no-op for the 7 that exist; safety net otherwise)
//   - ALTER TABLE ... ADD COLUMN IF NOT EXISTS (adds only what's missing)
//   - CREATE [UNIQUE] INDEX IF NOT EXISTS
// Each statement runs in its own try/catch so one failure can't abort the rest.
//
// Column choices are inferred directly from the SQL in:
//   src/api/routes.ts  (/tickets*, /referrals/*, /refcode/*, /marketplace/*, /player/crates)
//   src/db/pool.ts     (paynow_customers)
//
// Run from inside imperium-backend so its bundled `pg` resolves:
//   node migrate-tables.cjs
const { Pool } = require('pg');

// sslmode=require is intentionally omitted: pg 8.22 treats it as verify-full and
// rejects the Supabase pooler cert. The explicit ssl Pool option below applies.
const pool = new Pool({
  connectionString:
    'postgresql://postgres.rgqgaiwcuqmidbxggayk:KCxtU9fjBMkZDRC%26@aws-0-us-east-1.pooler.supabase.com:6543/postgres',
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
  max: 3,
});

const TABLES = [
  'support_tickets',
  'referrals',
  'referral_codes',
  'referral_redemptions',
  'paynow_customers',
  'marketplace_listings',
  'player_crate_keys',
];

// (label, sql) pairs. Order matters only within a table (columns before indexes).
const STATEMENTS = [
  // ===================== support_tickets =====================
  // routes.ts: INSERT (uuid, username, category, subject, body) RETURNING id
  //           SELECT id, uuid, username, category, subject, status, priority,
  //                  staff_response, responded_at, created_at
  //           UPDATE SET staff_response, responded_by, responded_at, status
  // Existing table had: id, player_uuid, category, message, status, created_at,
  //                     resolved_at  (legacy; routes.ts uses different names)
  ['support_tickets CREATE', `CREATE TABLE IF NOT EXISTS support_tickets (
     id BIGSERIAL PRIMARY KEY,
     uuid VARCHAR(36),
     username VARCHAR(64),
     category VARCHAR(50) DEFAULT 'general',
     subject VARCHAR(200),
     body TEXT,
     status VARCHAR(20) DEFAULT 'open',
     priority VARCHAR(20) DEFAULT 'normal',
     staff_response TEXT,
     responded_by VARCHAR(36),
     responded_at TIMESTAMPTZ,
     discord_thread_id VARCHAR(64),
     assigned_to VARCHAR(36),
     resolution TEXT,
     created_at TIMESTAMPTZ DEFAULT NOW()
   )`],
  ['support_tickets ADD uuid',            `ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS uuid VARCHAR(36)`],
  ['support_tickets ADD username',        `ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS username VARCHAR(64)`],
  ['support_tickets ADD subject',         `ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS subject VARCHAR(200)`],
  ['support_tickets ADD body',            `ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS body TEXT`],
  ['support_tickets ADD priority',        `ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS priority VARCHAR(20) DEFAULT 'normal'`],
  ['support_tickets ADD staff_response',  `ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS staff_response TEXT`],
  ['support_tickets ADD responded_by',    `ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS responded_by VARCHAR(36)`],
  ['support_tickets ADD responded_at',    `ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS responded_at TIMESTAMPTZ`],
  ['support_tickets ADD discord_thread_id', `ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS discord_thread_id VARCHAR(64)`],
  ['support_tickets ADD assigned_to',     `ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS assigned_to VARCHAR(36)`],
  ['support_tickets ADD resolution',      `ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS resolution TEXT`],
  ['support_tickets idx uuid',            `CREATE INDEX IF NOT EXISTS idx_support_tickets_uuid ON support_tickets(uuid)`],
  ['support_tickets idx status',          `CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status)`],

  // ===================== referrals =====================
  // routes.ts: INSERT (referrer_uuid, referred_uuid, referred_username, status) 'pending'
  //           ON CONFLICT (referrer_uuid, referred_uuid) DO NOTHING
  //           SELECT id, referred_username, status, referrer_rewarded,
  //                  referred_rewarded, created_at, completed_at
  //           WHERE referrer_uuid = $1  /  WHERE referred_uuid = $1
  // Existing table had: id, referrer_uuid, code, uses, max_uses, created_at
  //                     (old code-based design; routes.ts is now person-to-person)
  ['referrals CREATE', `CREATE TABLE IF NOT EXISTS referrals (
     id BIGSERIAL PRIMARY KEY,
     referrer_uuid VARCHAR(36),
     referred_uuid VARCHAR(36),
     referred_username VARCHAR(64),
     status VARCHAR(20) DEFAULT 'pending',
     referrer_rewarded BOOLEAN DEFAULT FALSE,
     referred_rewarded BOOLEAN DEFAULT FALSE,
     created_at TIMESTAMPTZ DEFAULT NOW(),
     completed_at TIMESTAMPTZ
   )`],
  ['referrals ADD referred_uuid',       `ALTER TABLE referrals ADD COLUMN IF NOT EXISTS referred_uuid VARCHAR(36)`],
  ['referrals ADD referred_username',   `ALTER TABLE referrals ADD COLUMN IF NOT EXISTS referred_username VARCHAR(64)`],
  ['referrals ADD status',              `ALTER TABLE referrals ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'pending'`],
  ['referrals ADD referrer_rewarded',   `ALTER TABLE referrals ADD COLUMN IF NOT EXISTS referrer_rewarded BOOLEAN DEFAULT FALSE`],
  ['referrals ADD referred_rewarded',   `ALTER TABLE referrals ADD COLUMN IF NOT EXISTS referred_rewarded BOOLEAN DEFAULT FALSE`],
  ['referrals ADD completed_at',        `ALTER TABLE referrals ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`],
  // UNIQUE for the ON CONFLICT (referrer_uuid, referred_uuid) clause. Safe: every
  // pre-existing row has NULL referred_uuid (new column), and PG treats multiple
  // NULLs as distinct under a unique index, so no conflict is possible.
  ['referrals UNIQUE (referrer,referred)', `CREATE UNIQUE INDEX IF NOT EXISTS uniq_referrals_referrer_referred ON referrals(referrer_uuid, referred_uuid)`],
  ['referrals idx referrer',            `CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_uuid)`],
  ['referrals idx referred',            `CREATE INDEX IF NOT EXISTS idx_referrals_referred ON referrals(referred_uuid)`],

  // ===================== referral_codes =====================
  // Already matches routes.ts (uuid PK, code, username, is_custom,
  // total_redemptions, last_changed_at). Add a UNIQUE on code so the random-
  // generation loop's ON CONFLICT DO NOTHING can't insert a duplicate, and an
  // index to back the WHERE code = $1 lookups.
  ['referral_codes CREATE', `CREATE TABLE IF NOT EXISTS referral_codes (
     uuid VARCHAR(36) PRIMARY KEY,
     code VARCHAR(16) NOT NULL,
     username VARCHAR(64),
     is_custom BOOLEAN NOT NULL DEFAULT FALSE,
     total_redemptions INTEGER NOT NULL DEFAULT 0,
     last_changed_at TIMESTAMPTZ DEFAULT NOW(),
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`],
  ['referral_codes ADD total_redemptions', `ALTER TABLE referral_codes ADD COLUMN IF NOT EXISTS total_redemptions INTEGER NOT NULL DEFAULT 0`],
  ['referral_codes ADD username',        `ALTER TABLE referral_codes ADD COLUMN IF NOT EXISTS username VARCHAR(64)`],
  // UNIQUE(code) may fail if duplicate codes already exist; guarded below.
  ['referral_codes UNIQUE code',         `CREATE UNIQUE INDEX IF NOT EXISTS uniq_referral_codes_code ON referral_codes(code)`],

  // ===================== referral_redemptions =====================
  // routes.ts: INSERT (redeemer_uuid, code_used, referrer_uuid, reward_paid)
  //           SELECT 1 WHERE redeemer_uuid = $1 AND code_used = $2
  // Existing table had: id, referrer_uuid, redeemer_uuid, redeemed_at,
  //                     reward_claimed  (routes.ts uses code_used + reward_paid)
  ['referral_redemptions CREATE', `CREATE TABLE IF NOT EXISTS referral_redemptions (
     id BIGSERIAL PRIMARY KEY,
     redeemer_uuid VARCHAR(36) NOT NULL,
     code_used VARCHAR(16) NOT NULL,
     referrer_uuid VARCHAR(36) NOT NULL,
     reward_paid BOOLEAN NOT NULL DEFAULT FALSE,
     redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`],
  ['referral_redemptions ADD code_used',   `ALTER TABLE referral_redemptions ADD COLUMN IF NOT EXISTS code_used VARCHAR(16)`],
  ['referral_redemptions ADD reward_paid', `ALTER TABLE referral_redemptions ADD COLUMN IF NOT EXISTS reward_paid BOOLEAN DEFAULT FALSE`],
  // UNIQUE for the "already redeemed?" guard. Safe: code_used is new (NULL on
  // all existing rows), multiple NULLs treated as distinct.
  ['referral_redemptions UNIQUE (redeemer,code)', `CREATE UNIQUE INDEX IF NOT EXISTS uniq_referral_redemptions_redeemer_code ON referral_redemptions(redeemer_uuid, code_used)`],
  ['referral_redemptions idx redeemer',    `CREATE INDEX IF NOT EXISTS idx_referral_redemptions_redeemer ON referral_redemptions(redeemer_uuid)`],

  // ===================== paynow_customers =====================
  // Already matches pool.ts (uuid PK, customer_id). Add an index on customer_id
  // for the webhook reverse-lookup getUuidByPaynowCustomerId().
  ['paynow_customers CREATE', `CREATE TABLE IF NOT EXISTS paynow_customers (
     uuid VARCHAR(36) PRIMARY KEY,
     customer_id VARCHAR(64) NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`],
  ['paynow_customers idx customer_id', `CREATE INDEX IF NOT EXISTS idx_paynow_customers_customer_id ON paynow_customers(customer_id)`],

  // ===================== marketplace_listings (plugin-owned) =====================
  // Already matches routes.ts. IF NOT EXISTS is a no-op; just ensures existence.
  ['marketplace_listings CREATE', `CREATE TABLE IF NOT EXISTS marketplace_listings (
     id BIGSERIAL PRIMARY KEY,
     seller_uuid VARCHAR(36) NOT NULL,
     item_nbt TEXT,
     quantity INTEGER NOT NULL DEFAULT 1,
     price_each BIGINT NOT NULL DEFAULT 0,
     category VARCHAR(50),
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     expires_at TIMESTAMPTZ
   )`],
  ['marketplace_listings idx seller', `CREATE INDEX IF NOT EXISTS idx_marketplace_listings_seller ON marketplace_listings(seller_uuid)`],
  ['marketplace_listings idx expires', `CREATE INDEX IF NOT EXISTS idx_marketplace_listings_expires ON marketplace_listings(expires_at)`],

  // ===================== player_crate_keys (plugin-owned) =====================
  // Already matches routes.ts. IF NOT EXISTS is a no-op; just ensures existence.
  ['player_crate_keys CREATE', `CREATE TABLE IF NOT EXISTS player_crate_keys (
     id BIGSERIAL PRIMARY KEY,
     uuid VARCHAR(36) NOT NULL,
     crate_type VARCHAR(64) NOT NULL,
     key_count INTEGER NOT NULL DEFAULT 0,
     UNIQUE (uuid, crate_type)
   )`],
  ['player_crate_keys idx uuid', `CREATE INDEX IF NOT EXISTS idx_player_crate_keys_uuid ON player_crate_keys(uuid)`],
];

(async () => {
  let client;
  try {
    client = await pool.connect();
    console.log('Connected to Supabase Postgres.\n');

    // Pre-check: which UNIQUE indexes might already have duplicate data that
    // would make CREATE UNIQUE INDEX fail? (only referral_codes(code) is at risk
    // since the others key on brand-new NULL columns.)
    try {
      const dup = await client.query(
        `SELECT code, COUNT(*) AS n FROM referral_codes GROUP BY code HAVING COUNT(*) > 1`,
      );
      if (dup.rows.length > 0) {
        console.log('WARNING: duplicate referral_codes.code values found — UNIQUE(code) index will be skipped/fail:');
        for (const r of dup.rows) console.log(`    code=${r.code}  count=${r.n}`);
      }
    } catch (e) {
      console.log(`(dup pre-check skipped: ${e.message})`);
    }
    console.log('');

    let ok = 0, skipped = 0, failed = 0;
    for (const [label, sql] of STATEMENTS) {
      try {
        const res = await client.query(sql);
        // PG returns empty commandTag for no-op CREATE/ALTER IF NOT EXISTS only
        // in some cases; we can't reliably distinguish "created" from "already
        // existed" without parsing. Treat success as OK.
        ok++;
        console.log(`  OK     | ${label}`);
      } catch (err) {
        // Common harmless no-op errors:
        //  - "already exists" for a CREATE that found the object
        //  - "already exists" column on ADD COLUMN IF NOT EXISTS (shouldn't happen on PG>=9.6)
        const msg = (err.message || '').toLowerCase();
        if (msg.includes('already exists')) {
          skipped++;
          console.log(`  SKIP   | ${label}  (already exists)`);
        } else {
          failed++;
          console.log(`  FAILED | ${label}  -> ${err.code || ''} ${err.message}`);
        }
      }
    }

    console.log(`\nSummary: ${ok} applied, ${skipped} already-existed, ${failed} failed.`);

    // Final verification: dump every target table's real columns.
    console.log('\nPost-migration verification:');
    for (const t of TABLES) {
      const r = await client.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1
          ORDER BY ordinal_position`,
        [t],
      );
      const cols = r.rows.map((c) => c.column_name);
      console.log(`  ${t.padEnd(24)} [${cols.join(', ')}]`);
    }
    console.log('\nMigration complete.');
  } catch (err) {
    console.error('FATAL:', err.code || err.message);
    if (err.stack) console.error(err.stack);
    process.exitCode = 1;
  } finally {
    if (client) client.release();
    await pool.end();
  }
})();
