/**
 * S2-E09 (Lane D backend half) — the attribution intent store + one-shot
 * claim, per docs/season-2/requests/S2-E09.md Ask 1 and the Attribution
 * contract in docs/season-2/API-CONTRACTS-S2.md.
 *
 * Model (migrations/d1_0008_attribution.sql, D1 only):
 *   - attribution_intent — one row per salted visitor-IP hash: the source
 *     tag that IP last acted on (a copy-IP click on a tagged page). Latest
 *     intent wins (the newest copy action is the one that produced the
 *     join); rows live 48h and are pruned on every write. The RAW IP is
 *     never stored — only sha256(ip + server secret) — and tags are
 *     vocabulary-shape-validated upstream, so no PII can ride in.
 *   - attribution_claim  — one row per player uuid: the source resolved at
 *     that player's first join. ONE-SHOT per uuid (first attribution wins;
 *     re-joins never re-attribute, so a later/household intent cannot
 *     rewrite history) and persisted so the one-shot holds across restarts.
 *
 * Salt discipline: the request file pins a STATIC salt (a rotating one would
 * break matching across the 48h window). ATTRIBUTION_SALT is the dedicated
 * worker secret; until the owner sets it, env falls back to JWT_SECRET so
 * the feature is armed with zero owner action (the same compat posture as
 * INTERNAL_SERVICE_TOKEN -> BOT_API_TOKEN). Setting the dedicated var later
 * orphans at most one 48h window of intents — they expire as 'direct'.
 */
import { createHash } from 'node:crypto';
import { getD1 } from '../db/pool.js';
import { env } from '../env.js';

/* ── Schema (mirrors migrations/d1_0008_attribution.sql) ──────────────────── */

export const ATTRIBUTION_INTENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS attribution_intent (
  ip_hash TEXT PRIMARY KEY,
  source  TEXT NOT NULL,
  ts      INTEGER NOT NULL
)`;
export const ATTRIBUTION_CLAIM_SCHEMA = `
CREATE TABLE IF NOT EXISTS attribution_claim (
  uuid       TEXT PRIMARY KEY,
  source     TEXT NOT NULL,
  claimed_at INTEGER NOT NULL
)`;

/** The matching window: copy -> join is normally minutes; 48h is headroom. */
export const ATTRIBUTION_INTENT_WINDOW_MS = 48 * 3_600_000;

let schemaEnsured = false;
export async function ensureAttributionSchema(): Promise<void> {
  if (schemaEnsured) return;
  const d1 = getD1();
  await d1.prepare(ATTRIBUTION_INTENT_SCHEMA).run();
  await d1.prepare(ATTRIBUTION_CLAIM_SCHEMA).run();
  schemaEnsured = true;
}

export function __resetAttributionSchemaForTests(): void {
  schemaEnsured = false;
}

/* ── IP hashing (the ONE construction both sides share) ───────────────────── */

/**
 * sha256(canonical_ip + ':' + secret) — the request file's salted hash. Both
 * the intent write and the claim lookup go through THIS function, so the two
 * sides can never drift. Canonicalization maximizes the match probability
 * between Cloudflare's form (the intent side) and a Java socket address (the
 * claim side): lowercase, strip IPv6 zone indices, unwrap ::ffff: v4-mapped
 * addresses.
 */
export function hashIp(ip: string): string {
  let v = ip.trim().toLowerCase();
  const zone = v.indexOf('%');
  if (zone > 0) v = v.slice(0, zone);
  if (v.startsWith('::ffff:') && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(v.slice(7))) v = v.slice(7);
  return createHash('sha256').update(`${v}:${env.attributionSalt}`).digest('hex');
}

/* ── The source-tag vocabulary (mirror of the frontend guard) ─────────────── */

export const SOURCE_TAG_MAX = 40;

const BASE_VALUES = new Set(['direct', 'site', 'launcher', 'client']);
const PREFIXES = ['vote', 'sponsor', 'page'] as const;

/** Slug: 1..N chars, starts and ends alphanumeric, hyphens only inside. */
const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * Validate one source tag against the contract vocabulary. Tolerant on read
 * (case/whitespace normalized), strict on shape: anything outside
 * [a-z0-9-] or over SOURCE_TAG_MAX is null — this is the PII guard, so it
 * runs on EVERY value entering the store. Mirrors the frontend's
 * parseSourceTag (imperium-frontend-fresh/src/lib/attribution.ts) exactly;
 * unknown-but-well-formed values (vote-<new site>) pass — they are data,
 * not a gate.
 */
export function parseSourceTag(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const tag = raw.trim().toLowerCase();
  if (!tag || tag.length > SOURCE_TAG_MAX) return null;
  if (!/^[a-z0-9-]+$/.test(tag)) return null;
  if (BASE_VALUES.has(tag)) return tag;
  for (const prefix of PREFIXES) {
    if (tag.startsWith(`${prefix}-`)) {
      return SLUG_RE.test(tag.slice(prefix.length + 1)) ? tag : null;
    }
  }
  return null;
}

/* ── Write path (the intent route) ────────────────────────────────────────── */

/**
 * Upsert one intent (latest wins, ts refreshes) and prune rows older than
 * the 48h window in the same D1 batch. Prepared statements only; the raw IP
 * never reaches this layer — callers pass hashIp(ip).
 */
export async function storeIntent(ipHash: string, source: string, nowMs: number): Promise<void> {
  await ensureAttributionSchema();
  const d1 = getD1();
  await d1.batch([
    d1.prepare(`DELETE FROM attribution_intent WHERE ts < ?`).bind(nowMs - ATTRIBUTION_INTENT_WINDOW_MS),
    d1
      .prepare(
        `INSERT INTO attribution_intent (ip_hash, source, ts) VALUES (?, ?, ?)
         ON CONFLICT(ip_hash) DO UPDATE SET source = excluded.source, ts = excluded.ts`,
      )
      .bind(ipHash, source, nowMs),
  ]);
}

/* ── The claim (the plugin's one call at a player's first join) ───────────── */

/**
 * Resolve one player's join source. ONE-SHOT per uuid:
 *   1. a claimed uuid returns its stored source — re-joins never re-attribute;
 *   2. else the freshest intent on that IP hash within the 48h window wins,
 *      no row -> 'direct';
 *   3. the claim is persisted (INSERT OR IGNORE + re-read = first-wins even
 *      under a double-fired join).
 * Never returns null or throws on a missing intent — attribution must never
 * fail a join.
 */
export async function claimSource(uuid: string, ipHash: string, nowMs: number): Promise<string> {
  await ensureAttributionSchema();
  const d1 = getD1();

  const existing = await d1
    .prepare(`SELECT source FROM attribution_claim WHERE uuid = ?`)
    .bind(uuid)
    .first<{ source: string }>();
  if (existing) return existing.source;

  const intent = await lookupIntentSource(ipHash, nowMs);
  await d1
    .prepare(`INSERT OR IGNORE INTO attribution_claim (uuid, source, claimed_at) VALUES (?, ?, ?)`)
    .bind(uuid, intent, nowMs)
    .run();
  const stored = await d1
    .prepare(`SELECT source FROM attribution_claim WHERE uuid = ?`)
    .bind(uuid)
    .first<{ source: string }>();
  return stored?.source ?? intent;
}

/** The freshest intent on one IP hash within the window (ts-keyed upsert,
 *  so "freshest" is simply the row); 'direct' when none. */
export async function lookupIntentSource(ipHash: string, nowMs: number): Promise<string> {
  await ensureAttributionSchema();
  const row = await getD1()
    .prepare(`SELECT source FROM attribution_intent WHERE ip_hash = ? AND ts >= ?`)
    .bind(ipHash, nowMs - ATTRIBUTION_INTENT_WINDOW_MS)
    .first<{ source: string }>();
  return row?.source ?? 'direct';
}
