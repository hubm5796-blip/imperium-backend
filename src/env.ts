import dotenv from 'dotenv';

dotenv.config();

function required(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optional(key: string, fallback = ''): string {
  return process.env[key] ?? fallback;
}

function optionalInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${key} must be an integer, got: ${raw}`);
  }
  return parsed;
}

export const env = {
  discord: {
    clientId: required('DISCORD_CLIENT_ID'),
    clientSecret: required('DISCORD_CLIENT_SECRET'),
    redirectUri: required(
      'DISCORD_REDIRECT_URI',
      'https://imperiummc.net/auth/callback',
    ),
    botToken: optional('DISCORD_BOT_TOKEN'),
  },
  jwtSecret: required('JWT_SECRET'),
  databaseUrl: required('DATABASE_URL'),
  redis: {
    host: optional('REDIS_HOST', 'localhost'),
    port: optionalInt('REDIS_PORT', 6379),
    password: optional('REDIS_PASSWORD'),
  },
  webpanelHmacSecret: required('WEBPANEL_HMAC_SECRET'),
  port: optionalInt('PORT', 3001),
  nodeEnv: optional('NODE_ENV', 'development'),
  isProduction: optional('NODE_ENV', 'development') === 'production',
  /** Path to the plugin's SQLite database (for link code verification when Redis is not available). */
  sqlitePath: optional('SQLITE_PATH', ''),
} as const;

export type Env = typeof env;
