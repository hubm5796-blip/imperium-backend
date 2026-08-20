// Env is populated once per warm isolate/process, not read eagerly at module
// load time — Workers only exposes its bindings (Hyperdrive, secrets, vars)
// per-request via the fetch handler's `env` parameter, unlike Node's
// always-available `process.env`. The Node dev/prod entrypoint
// (src/index.ts) calls initEnvFromProcess() once at startup; the Workers
// entrypoint (src/worker.ts) calls initEnvFromBindings(c.env) from request
// middleware. Every existing call site (`import { env } from './env.js'`,
// used throughout routes/middleware/paynow/bot) is unchanged — `env` is
// still a plain importable object, just backed by a proxy that reads
// whichever build populated it.

export interface EnvShape {
  discord: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    botToken: string;
    /** Ed25519 public key used to verify Discord Interactions webhook signatures. */
    publicKey: string;
  };
  jwtSecret: string;
  /** Node dev/prod only — Workers gets its Postgres connection via the Hyperdrive binding instead. */
  databaseUrl: string;
  /** Trust X-Forwarded-For for client IP (rate limiting). The rate limiter reads this so a
   *  deployment behind a known proxy can honor forwarded IPs without re-opening the XFF bypass. */
  trustProxy: boolean;
  redis: {
    host: string;
    port: number;
    password: string;
    username: string;
    /** Managed providers (Upstash, etc.) require TLS; a bare requirepass self-host typically doesn't use it. */
    tls: boolean;
  };
  webpanelHmacSecret: string;
  /**
   * Per-site shared secrets for vote-site callback endpoints (POST /api/vote/:site),
   * parsed from VOTE_CALLBACK_KEYS as a comma-separated list of `site:key` pairs
   * (same convention as PAYNOW_WEBHOOK_SECRETS). A vote site's callback must send
   * its key in the `X-Vote-Key` header; the key is compared timing-safely.
   */
  voteCallbackKeys: Record<string, string>;
  /**
   * Shared secret required on bot-only endpoints (/link/confirm, DELETE /link,
   * /player/profile with ?uuid=/?discord_id=). The bot sends it in the
   * `X-Bot-Token` header. Optional in dev; if unset, bot-auth-only checks fail.
   */
  botApiToken: string;
  /** Owner DM overrides for error alerts — optional; defaults to username search. */
  ownerDiscordId?: string;
  ownerDiscordUsername?: string;
  /** Discord webhook for staff error alerts — optional; unset = alerting off. */
  staffAlertWebhookUrl?: string;
  port: number;
  nodeEnv: string;
  isProduction: boolean;
  /** Path to the plugin's SQLite database — Node dev fallback only; unused on Workers (no local filesystem). */
  sqlitePath: string;
  paynow: {
    apiKey: string;
    storeId: string;
    webhookSecrets: string[];
    baseUrl: string;
  };
}

type Getter = (key: string, fallback?: string) => string | undefined;

/**
 * Parse a comma-separated `name:key` map ("site1:key1,site2:key2") into a
 * Record with lowercased names and trimmed values. Empty/missing input → {}.
 */
function parseKeyMap(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(':');
    if (sep <= 0) continue; // no name, or empty name
    const name = trimmed.slice(0, sep).trim().toLowerCase();
    const value = trimmed.slice(sep + 1).trim();
    if (name && value) out[name] = value;
  }
  return out;
}

function buildEnv(get: Getter, opts: { requireDatabaseUrl: boolean }): EnvShape {
  function required(key: string, fallback?: string): string {
    const value = get(key, fallback);
    if (value === undefined || value === '') {
      throw new Error(`Missing required environment variable: ${key}`);
    }
    return value;
  }
  function optional(key: string, fallback = ''): string {
    return get(key, fallback) ?? fallback;
  }
  function optionalInt(key: string, fallback: number): number {
    const raw = get(key);
    if (raw === undefined || raw === '') return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) {
      throw new Error(`Environment variable ${key} must be an integer, got: ${raw}`);
    }
    return parsed;
  }
  function optionalBool(key: string, fallback: boolean): boolean {
    const raw = get(key);
    if (raw === undefined || raw === '') return fallback;
    return raw === 'true' || raw === '1';
  }

  const nodeEnv = optional('NODE_ENV', 'development');

  // M2: HS256 security relies on a strong secret. Reject short secrets at boot so
  // misconfiguration fails loudly instead of silently weakening token signing.
  const jwtSecret = required('JWT_SECRET');
  if (jwtSecret.length < 32) {
    throw new Error(
      'Environment variable JWT_SECRET must be at least 32 characters long.',
    );
  }

  return {
    discord: {
      clientId: required('DISCORD_CLIENT_ID'),
      clientSecret: required('DISCORD_CLIENT_SECRET'),
      // Derive the OAuth redirect URI from BACKEND_API_BASE (reliably set in wrangler
      // config to https://api.imperiummc.net). DISCORD_REDIRECT_URI is NOT trusted as-is:
      // it kept getting clobbered to a stale frontend-path value on every Workers Builds
      // redeploy, breaking Discord login with "invalid redirect_uri". The callback is a
      // fixed path on THIS backend, so computing it from the backend's own origin is always
      // correct. Only honor an explicit override if it points at a backend callback URL.
      redirectUri: (() => {
        const base = optional('BACKEND_API_BASE', 'https://api.imperiummc.net').replace(/\/$/, '');
        const derived = `${base}/api/auth/discord/callback`;
        const override = optional('DISCORD_REDIRECT_URI');
        // Honor the override only if it's the correct backend callback (not the stale
        // frontend-path value that the clobbering keeps reintroducing).
        if (override && override.includes('/api/auth/discord/callback')) return override.trim();
        return derived;
      })(),
      botToken: optional('DISCORD_BOT_TOKEN'),
      publicKey: optional('DISCORD_PUBLIC_KEY'),
    },
    jwtSecret,
    trustProxy: optionalBool('TRUST_PROXY', false),
    databaseUrl: opts.requireDatabaseUrl ? required('DATABASE_URL') : optional('DATABASE_URL'),
    redis: {
      host: optional('REDIS_HOST', 'localhost'),
      port: optionalInt('REDIS_PORT', 6379),
      password: optional('REDIS_PASSWORD'),
      username: optional('REDIS_USERNAME'),
      tls: optionalBool('REDIS_TLS', false),
    },
    webpanelHmacSecret: required('WEBPANEL_HMAC_SECRET'),
    // VOTE_CALLBACK_KEYS is "site1:key1,site2:key2". Optional — an empty map
    // means no vote sites are configured and every vote callback 404s (unknown
    // site), which is the safe default until keys are provisioned.
    voteCallbackKeys: parseKeyMap(optional('VOTE_CALLBACK_KEYS')),
    // BOT_API_TOKEN is required in production — without it, all bot-auth endpoints
    // (linking, profile lookups, store checkout) silently 401. Fail loudly instead.
    botApiToken: nodeEnv === 'production' ? required('BOT_API_TOKEN') : optional('BOT_API_TOKEN'),
    staffAlertWebhookUrl: optional('STAFF_ALERT_WEBHOOK_URL') || '',
    ownerDiscordId: optional('OWNER_DISCORD_ID') || '',
    ownerDiscordUsername: optional('OWNER_DISCORD_USERNAME') || '',
    port: optionalInt('PORT', 3001),
    nodeEnv,
    isProduction: nodeEnv === 'production',
    sqlitePath: optional('SQLITE_PATH', ''),
    paynow: {
      apiKey: required('PAYNOW_API_KEY'),
      storeId: required('PAYNOW_STORE_ID'),
      webhookSecrets: required('PAYNOW_WEBHOOK_SECRETS')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      baseUrl: optional('PAYNOW_BASE_URL', 'https://api.paynow.gg'),
    },
  };
}

let current: EnvShape | null = null;

/** Node dev/prod entrypoint only. Idempotent — safe to call more than once. */
export async function initEnvFromProcess(): Promise<void> {
  if (current) return;
  const dotenv = await import('dotenv');
  dotenv.config();
  current = buildEnv((key, fallback) => process.env[key] ?? fallback, { requireDatabaseUrl: true });
}

/**
 * Workers entrypoint only. Idempotent per warm isolate — the Hono middleware
 * that calls this runs on every request, but only the first call on a given
 * isolate actually builds the env; later calls are no-ops, same as
 * db/pool.ts's initPool().
 */
export function initEnvFromBindings(bindings: Record<string, unknown>): void {
  if (current) return;
  const get: Getter = (key, fallback) => {
    const value = bindings[key];
    return typeof value === 'string' ? value : fallback;
  };
  current = buildEnv(get, { requireDatabaseUrl: false });
}

/** Plain, importable object every existing call site already uses unchanged. */
export const env: EnvShape = new Proxy({} as EnvShape, {
  get(_target, prop, receiver) {
    if (!current) {
      throw new Error(
        'env accessed before initialization — call initEnvFromProcess() or initEnvFromBindings() first',
      );
    }
    return Reflect.get(current, prop, receiver);
  },
});

/** Test-only: reset so a test suite can call initEnvFromProcess()/initEnvFromBindings() fresh. */
export function __resetEnvForTests(): void {
  current = null;
}
