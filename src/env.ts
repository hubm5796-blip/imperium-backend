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
  redis: {
    host: string;
    port: number;
    password: string;
  };
  webpanelHmacSecret: string;
  /**
   * Shared secret required on bot-only endpoints (/link/confirm, DELETE /link,
   * /player/profile with ?uuid=/?discord_id=). The bot sends it in the
   * `X-Bot-Token` header. Optional in dev; if unset, bot-auth-only checks fail.
   */
  botApiToken: string;
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

  const nodeEnv = optional('NODE_ENV', 'development');

  return {
    discord: {
      clientId: required('DISCORD_CLIENT_ID'),
      clientSecret: required('DISCORD_CLIENT_SECRET'),
      redirectUri: required('DISCORD_REDIRECT_URI', 'https://imperiummc.net/auth/callback'),
      botToken: optional('DISCORD_BOT_TOKEN'),
      publicKey: optional('DISCORD_PUBLIC_KEY'),
    },
    jwtSecret: required('JWT_SECRET'),
    databaseUrl: opts.requireDatabaseUrl ? required('DATABASE_URL') : optional('DATABASE_URL'),
    redis: {
      host: optional('REDIS_HOST', 'localhost'),
      port: optionalInt('REDIS_PORT', 6379),
      password: optional('REDIS_PASSWORD'),
    },
    webpanelHmacSecret: required('WEBPANEL_HMAC_SECRET'),
    botApiToken: optional('BOT_API_TOKEN'),
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
