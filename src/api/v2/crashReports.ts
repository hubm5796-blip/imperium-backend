/**
 * ImperiumMC#3 — launcher crash-report intake + staff triage reads.
 *
 *   POST /api/v2/client/crash-report          anonymous, 5/hour/IP → D1 row
 *   GET  /api/v2/client/crash-report/:id      staff (helper+) — full record
 *   GET  /api/v2/client/crash-reports?limit=  staff (helper+) — newest-first
 *                                              triage list + counts by cause
 *
 * AUTH MODEL: the launcher has no user token — it can crash before sign-in —
 * so the POST is anonymous and the entire abuse bound is the per-IP window on
 * the shared D1 limiter (crashReportRateLimit). No service token is demanded:
 * requiring one would lock out the pre-sign-in crashes this exists for, and
 * the launcher binary is public anyway (the token would be public too).
 *
 * SIZE DISCIPLINE: bodies over 256 KB are refused before parsing (413); the
 * two text blobs are hard-truncated to 32 KB (log_tail) / 64 KB
 * (crash_report) on the SERVER, never trusted to the caller's own clamping.
 *
 * PRIVACY: rows store an HMAC prefix of the client IP (keyed by JWT_SECRET —
 * keyed, because a bare SHA-256 of the IPv4 space is a rainbow table away),
 * never the raw address, and no player identity is attached (the launcher
 * sends none). The free-text fields (cause, logTail, crashReport) are also
 * scrubbed on receipt with the shared rule set (src/utils/crashTextRedaction.ts
 * — mirrored in the launcher's app/main/redact.js) BEFORE truncation and
 * storage: usernames in profile paths, %APPDATA%-style env refs and echoed
 * credentials never reach D1, even from an old launcher build that predates
 * the client-side scrub. Stack traces, mod ids and error text pass through
 * untouched — that is the diagnostic value of the report.
 *
 * Degradation: D1 unavailable → 503 REGISTRY_UNAVAILABLE, never a crash
 * (same posture as gallery). There is no panel HTML surface for this table
 * yet — the staff-facing "view" returned to the launcher is this API's own
 * staff-gated GET path.
 */
import { Hono } from 'hono';
import { createHmac, randomBytes } from 'node:crypto';
import { getD1 } from '../../db/pool.js';
import { requireStaffRole } from '../../middleware/gates.js';
import { crashReportRateLimit, clientIp, readRateLimit } from '../../middleware/rateLimit.js';
import { env } from '../../env.js';
import { logger } from '../../utils/logger.js';
import { ok, fail } from './respond.js';
import { scrubCrashText } from '../../utils/crashTextRedaction.js';
import type { AppContextVariables } from '../../types/index.js';
import { limitParam } from '../../utils/paging.js';

type ApiEnv = { Variables: AppContextVariables };

export const crashReportsV2 = new Hono<ApiEnv>();

const MAX_BODY_BYTES = 256 * 1024;
const MAX_LOG_TAIL_BYTES = 32 * 1024;
const MAX_CRASH_REPORT_BYTES = 64 * 1024;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;
const ID_RE = /^[a-f0-9]{16}$/;

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS client_crash_reports (
     id text primary key,
     created_at integer not null,
     ip_hash text not null,
     launcher text not null,
     launcher_version text not null,
     client_version text,
     mc_version text,
     platform text not null,
     cause text not null,
     mod text,
     log_tail text not null,
     crash_report text
   )`,
  `CREATE INDEX IF NOT EXISTS idx_client_crash_reports_created ON client_crash_reports(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_client_crash_reports_cause ON client_crash_reports(cause)`,
];

let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  const d1 = getD1();
  // D1 constraints: prepare() takes ONE statement, batch() rejects DDL — sequential prepares.
  for (const stmt of SCHEMA_STATEMENTS) {
    await d1.prepare(stmt).run();
  }
  schemaReady = true;
}

/** Keyed IP fingerprint — correlation without storing the address. */
function ipHash(ip: string): string {
  return createHmac('sha256', env.jwtSecret).update(ip).digest('hex').slice(0, 16);
}

/**
 * Hard byte-budget truncation, filled exactly: binary search for the longest
 * char prefix whose UTF-8 size fits the budget (byte size is monotonic in
 * prefix length). A trailing high surrogate — the cut landing between a
 * surrogate pair — is dropped so the stored value stays valid Unicode.
 */
export function truncateToBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  // Invariant: byteLength(slice(0, lo)) <= maxBytes < byteLength(slice(0, hi + 1)).
  let lo = 0;
  let hi = value.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi + 1) / 2);
    if (Buffer.byteLength(value.slice(0, mid), 'utf8') <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  let out = value.slice(0, lo);
  const last = out.length > 0 ? out.charCodeAt(out.length - 1) : 0;
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

interface CrashReportRow {
  id: string;
  created_at: number;
  ip_hash: string;
  launcher: string;
  launcher_version: string;
  client_version: string | null;
  mc_version: string | null;
  platform: string;
  cause: string;
  mod: string | null;
  log_tail: string;
  crash_report: string | null;
}

function fullRecord(r: CrashReportRow) {
  return {
    id: r.id,
    createdAt: new Date(r.created_at).toISOString(),
    ipHash: r.ip_hash,
    launcher: r.launcher,
    launcherVersion: r.launcher_version,
    clientVersion: r.client_version,
    mcVersion: r.mc_version,
    platform: r.platform,
    cause: r.cause,
    mod: r.mod,
    logTail: r.log_tail,
    crashReport: r.crash_report,
  };
}

/** Triage-list projection — the two big text blobs stay off the list view. */
function listEntry(r: CrashReportRow) {
  return {
    id: r.id,
    createdAt: new Date(r.created_at).toISOString(),
    launcher: r.launcher,
    launcherVersion: r.launcher_version,
    clientVersion: r.client_version,
    mcVersion: r.mc_version,
    platform: r.platform,
    cause: r.cause,
    mod: r.mod,
  };
}

// ── Anonymous intake ────────────────────────────────────────────────────────

crashReportsV2.post('/client/crash-report', crashReportRateLimit, async (c) => {
  // Size gate BEFORE parsing — a runaway log must never reach JSON.parse.
  const raw = await c.req.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    return fail(c, 413, 'PAYLOAD_TOO_LARGE', 'Body exceeds the 256 KB limit.');
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail(c, 400, 'INVALID_PARAM', 'Invalid JSON body.');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return fail(c, 400, 'INVALID_PARAM', 'Expected a JSON object.');
  }
  const b = body as Record<string, unknown>;

  // Required short strings: type-checked, trimmed, length-clamped.
  const short = (key: string, max: number): string | null => {
    const v = b[key];
    if (typeof v !== 'string') return null;
    const t = v.trim().slice(0, max);
    return t.length > 0 ? t : null;
  };
  const launcher = short('launcher', 64);
  if (!launcher) return fail(c, 400, 'INVALID_PARAM', '`launcher` must be a non-empty string (max 64 chars).');
  const launcherVersion = short('launcherVersion', 64);
  if (!launcherVersion) return fail(c, 400, 'INVALID_PARAM', '`launcherVersion` must be a non-empty string (max 64 chars).');
  const platform = short('platform', 64);
  if (!platform) return fail(c, 400, 'INVALID_PARAM', '`platform` must be a non-empty string (max 64 chars).');
  // The cause is free text parsed from the log (a FileNotFoundException
  // carries the sender's profile path) — validate like the other short
  // strings, but scrub the FULL raw line before the 200-char clamp:
  // slicing first could cut a credential in half and leave an unscrubbable
  // partial in storage.
  if (typeof b.cause !== 'string' || b.cause.trim().length === 0) {
    return fail(c, 400, 'INVALID_PARAM', '`cause` must be a non-empty string (max 200 chars).');
  }
  const cause = scrubCrashText(b.cause).trim().slice(0, 200);

  // Optional short strings: absent/empty → null.
  const optShort = (key: string, max: number): string | null => {
    const v = b[key];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') return null; // rejected below via the unknown-type check
    const t = v.trim().slice(0, max);
    return t.length > 0 ? t : null;
  };
  for (const key of ['clientVersion', 'mcVersion', 'mod'] as const) {
    const v = b[key];
    if (v !== undefined && v !== null && typeof v !== 'string') {
      return fail(c, 400, 'INVALID_PARAM', `\`${key}\` must be a string when present.`);
    }
  }
  const clientVersion = optShort('clientVersion', 64);
  const mcVersion = optShort('mcVersion', 64);
  const mod = optShort('mod', 200);

  // The blobs: type-checked, then scrubbed, then hard-truncated server-side.
  // Scrub BEFORE truncating — a truncated token is a partial leak, and the
  // byte budget must apply to the form that is actually stored.
  if (typeof b.logTail !== 'string') {
    return fail(c, 400, 'INVALID_PARAM', '`logTail` must be a string.');
  }
  if (b.crashReport !== undefined && b.crashReport !== null && typeof b.crashReport !== 'string') {
    return fail(c, 400, 'INVALID_PARAM', '`crashReport` must be a string when present.');
  }
  const logTailScrubbed = scrubCrashText(b.logTail);
  const logTail = truncateToBytes(logTailScrubbed, MAX_LOG_TAIL_BYTES);
  const crashReportRaw = typeof b.crashReport === 'string' ? b.crashReport : null;
  const crashReportScrubbed = crashReportRaw === null ? null : scrubCrashText(crashReportRaw);
  const crashReport = crashReportScrubbed === null ? null : truncateToBytes(crashReportScrubbed, MAX_CRASH_REPORT_BYTES);

  try {
    await ensureSchema();
  } catch (err) {
    // B-33: driver text can carry SQL fragments — log it, never reflect it.
    logger.error({ err: String(err) }, 'crash-report schema ensure failed');
    return fail(c, 503, 'REGISTRY_UNAVAILABLE', 'Crash reporting unavailable.');
  }

  const id = randomBytes(8).toString('hex');
  try {
    await getD1()
      .prepare(
        `INSERT INTO client_crash_reports
           (id, created_at, ip_hash, launcher, launcher_version, client_version, mc_version, platform, cause, mod, log_tail, crash_report)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        Date.now(),
        ipHash(clientIp(c)), // same resolver the rate limiter keys on
        launcher,
        launcherVersion,
        clientVersion,
        mcVersion,
        platform,
        cause,
        mod,
        logTail,
        crashReport,
      )
      .run();
  } catch (err) {
    logger.error({ err: String(err) }, 'crash-report insert failed');
    return fail(c, 503, 'REGISTRY_UNAVAILABLE', 'Crash reporting unavailable.');
  }

  logger.info({ id, cause, platform, launcherVersion }, 'client crash report accepted');
  // No panel HTML surface exists for this table yet — the staff-facing view is
  // this API's own staff-gated GET path (noted in #3).
  return ok(c, {
    id,
    url: `/api/v2/client/crash-report/${id}`,
    truncated: {
      // Redaction alone must not read as truncation — compare the stored
      // form against the scrubbed input, not the raw request text.
      logTail: logTail !== logTailScrubbed,
      crashReport: crashReportScrubbed !== null && crashReport !== crashReportScrubbed,
    },
  });
});

// ── Staff reads ─────────────────────────────────────────────────────────────
//
// Per-route middleware (NOT a use('/client/crash-report*') glob): that glob
// would also match /client/crash-reports AND the anonymous POST, leaking the
// staff gate onto the intake route (the adminPanel.ts comment documents the
// same trap).

crashReportsV2.get('/client/crash-report/:id', readRateLimit, requireStaffRole('helper'), async (c) => {
  const id = c.req.param('id');
  if (!ID_RE.test(id)) return fail(c, 400, 'INVALID_PARAM', 'Bad id.');

  try {
    await ensureSchema();
  } catch {
    return fail(c, 503, 'REGISTRY_UNAVAILABLE', 'Crash reporting unavailable.');
  }

  try {
    const row = await getD1()
      .prepare(
        `SELECT id, created_at, ip_hash, launcher, launcher_version, client_version, mc_version, platform, cause, mod, log_tail, crash_report
         FROM client_crash_reports WHERE id = ?`,
      )
      .bind(id)
      .first<CrashReportRow>();
    if (!row) return fail(c, 404, 'NOT_FOUND', 'No such crash report.');
    return ok(c, fullRecord(row));
  } catch (err) {
    logger.error({ err: String(err), id }, 'crash-report fetch failed');
    return fail(c, 503, 'REGISTRY_UNAVAILABLE', 'Crash reporting unavailable.');
  }
});

crashReportsV2.get('/client/crash-reports', readRateLimit, requireStaffRole('helper'), async (c) => {
  // v2 discipline: unknown query params are rejected, not ignored.
  const unknown = Object.keys(c.req.query()).filter((k) => k !== 'limit');
  if (unknown.length > 0) {
    return fail(c, 400, 'UNKNOWN_PARAM', `Unknown query parameter(s): ${unknown.join(', ')}`, { allowed: ['limit'] });
  }
  const limit = limitParam(c.req.query('limit'), DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);

  try {
    await ensureSchema();
  } catch {
    return fail(c, 503, 'REGISTRY_UNAVAILABLE', 'Crash reporting unavailable.');
  }

  try {
    const d1 = getD1();
    const { results } = await d1
      .prepare(
        `SELECT id, created_at, launcher, launcher_version, client_version, mc_version, platform, cause, mod
         FROM client_crash_reports ORDER BY created_at DESC LIMIT ?`,
      )
      .bind(limit)
      .all<CrashReportRow>();
    const total = await d1.prepare('SELECT COUNT(*) AS n FROM client_crash_reports').first<{ n: number }>();
    const { results: countRows } = await d1
      .prepare('SELECT cause, COUNT(*) AS n FROM client_crash_reports GROUP BY cause ORDER BY n DESC LIMIT 10')
      .all<{ cause: string; n: number }>();
    return ok(c, {
      reports: (results ?? []).map(listEntry),
      total: Number(total?.n ?? 0),
      countsByCause: (countRows ?? []).map((r) => ({ cause: r.cause, count: Number(r.n) })),
    });
  } catch (err) {
    logger.error({ err: String(err) }, 'crash-report list failed');
    return fail(c, 503, 'REGISTRY_UNAVAILABLE', 'Crash reporting unavailable.');
  }
});
