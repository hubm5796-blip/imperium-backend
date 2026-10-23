/**
 * Crash-report text scrubber, backend half (defense in depth).
 *
 * The launcher scrubs its crash reports before upload, but the endpoint must
 * not trust that: an OLD launcher build (or anything else that can POST) must
 * not be able to land a username, a profile path or a credential in D1. So the
 * same rule set runs here, on receipt, before storage — see the intake route
 * in src/api/v2/crashReports.ts.
 *
 * SHARED REDACTION RULES (v1) — this block is mirrored verbatim in the
 * launcher half, ImperiumLauncher app/main/redact.js. The two implementations
 * must stay pattern-for-pattern identical: the launcher scrub protects the
 * player, this one is the backstop. Change BOTH or neither; bump the version
 * tag when the rule set changes.
 *
 *   P1  Windows profile paths — any drive letter, either slash direction,
 *       case-insensitive:  C:\Users\<name>\...  →  C:\Users\REDACTED\...
 *       (this also covers expanded %APPDATA% / %LOCALAPPDATA% paths, which
 *       sit under the profile root)
 *   P2  POSIX homes, mac and linux spellings, case-insensitive:
 *       /Users/<name>/... and /home/<name>/...  →  REDACTED segment
 *   P3  Unexpanded profile env references, case-insensitive:
 *       %USERPROFILE% | %APPDATA% | %LOCALAPPDATA%  →  %REDACTED%
 *   T1  Bearer credentials:  Bearer <value>  →  Bearer [REDACTED]
 *   T2  Labelled secrets — token/secret/password/passwd/api[-_]key, with
 *       access-/session-/refresh-/client-/auth- prefixed forms, followed by
 *       `=`, `:` or a space and a 16+ char base64/hex-ish value:
 *       token=<value>  →  token=[REDACTED]  (the label is kept on purpose)
 *   T3  Bare JWTs — eyJ<header>.<payload>.<signature>  →  [REDACTED]
 *
 * Deliberately KEPT (that is the diagnostic value): stack traces with class,
 * method and line numbers, mod ids, error text, bare hashes/digests without
 * a secret label, UUIDs, IP addresses.
 */

// P1: drive-colon-slash prefix + the "Users" segment + the username run.
// The username run stops at whitespace, either slash, quotes and ':' so
// trailing punctuation and quoted JSON paths survive intact.
const WINDOWS_PROFILE_RE = /([A-Za-z]:[\\/]+users[\\/]+)[^\s\\/:"']+/gi;

// P2: start-of-string, whitespace, quotes, brackets, parens, '=' or another
// slash directly before /Users/ or /home/ — a bare URL path segment
// ("example.com/home/page") does not match, a real home path does.
const POSIX_HOME_RE = /(^|[\s"'=([]|\/)(\/(?:users|home)\/)[^\s/\\:"']+/gi;

// P3: the three Windows env vars that resolve inside the user's profile.
const ENV_PROFILE_RE = /%(?:userprofile|appdata|localappdata)%/gi;

// T1: RFC 6750 token68 charset after the Bearer auth-scheme keyword. The
// keyword itself is captured so its original casing survives.
const BEARER_RE = /\b(bearer)\s+[A-Za-z0-9\-._~+/]+=*/gi;

// T2: secret-labelled assignment — `=`, `:` or a plain space between label
// and value (log lines like "session token 3f2b..."). Label kept via $1,
// separator via $2; the 16-char floor keeps ordinary words ("password
// incorrect") untouched.
const LABELLED_SECRET_RE =
  /\b((?:access[_-]?|session[_-]?|refresh[_-]?|client[_-]?|auth[_-]?)?(?:token|tokens|secret|secrets|password|passwords|passwd|api[_-]?key|apikey))\b(['"]?\s*[:=]\s*['"]?|\s+)([A-Za-z0-9+/_\-.=]{16,})/gi;

// T3: a JWT is structurally unambiguous — base64url of a JSON header always
// starts with eyJ — so no label is needed for these.
const JWT_RE = /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{6,}/g;

/**
 * Scrub a crash-report text with the shared rule set above. Pure: no I/O,
 * no globals, idempotent (scrubCrashText(scrubCrashText(x)) === x once
 * applied). Empty input passes through untouched.
 */
export function scrubCrashText(value: string): string {
  if (value.length === 0) return value;
  return value
    .replace(WINDOWS_PROFILE_RE, '$1REDACTED')
    .replace(POSIX_HOME_RE, '$1$2REDACTED')
    .replace(ENV_PROFILE_RE, '%REDACTED%')
    .replace(BEARER_RE, '$1 [REDACTED]')
    .replace(LABELLED_SECRET_RE, '$1$2[REDACTED]')
    .replace(JWT_RE, '[REDACTED]');
}
