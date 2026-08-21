#!/usr/bin/env node
/**
 * Idempotent migration for the bot-cron state tables (V6 02-05/02-07/02-09
 * port into the backend). All other bot tables already exist:
 * bot_command_log / bot_metrics_daily / bot_state / bot_user_activity
 * (analytics, created with the 02-09 work) and discord_links (the link
 * system). webhook_* tables live in D1 and self-create at runtime.
 *
 * Run: node migrate-bot-tables.cjs   (reads DATABASE_URL from .env)
 */
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
const env = Object.fromEntries(
  envFile.split(/\r?\n/).filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);
// Same sslmode stripping as src/db/pool.ts — pg parses sslmode=require as
// verify-full, which overrides the lenient ssl option and fails on Supabase.
const url = (env.DATABASE_URL || '').replace(/[?&]sslmode=[^&]*/, '');

const STATEMENTS = [
  // Exactly-once notification ledger — INSERT .. ON CONFLICT DO NOTHING, the
  // sole dedupe mechanism (no in-memory state; safe across isolates).
  `create table if not exists discord_dedupe (
     dedupe_key text primary key,
     created_at timestamptz not null default now()
   )`,
  `create index if not exists discord_dedupe_created_idx on discord_dedupe (created_at desc)`,
  // Per-Discord-user DM opt-ins — everything default false (plan 12c).
  `create table if not exists discord_dm_prefs (
     discord_id    text primary key,
     dm_events     boolean not null default false,
     vote_reminder boolean not null default false,
     updated_at    timestamptz not null default now()
   )`,
];

(async () => {
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  for (const sql of STATEMENTS) {
    await client.query(sql);
    console.log('ok:', sql.slice(0, 60).replace(/\s+/g, ' '));
  }
  await client.end();
  console.log('bot tables migration complete');
})().catch((err) => {
  console.error('migration failed:', err.message);
  process.exit(1);
});
