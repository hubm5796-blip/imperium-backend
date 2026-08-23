/// <reference types="@cloudflare/workers-types" />
// Cloudflare Workers entrypoint. Mirrors src/index.ts (the Node dev/prod
// entrypoint) but sources env/DB config from Workers bindings instead of
// process.env, and exports app.fetch directly instead of using
// @hono/node-server's serve() wrapper.
//
// The Discord bot does NOT run from here — discord.js's gateway Client is a
// persistent WebSocket connection, fundamentally incompatible with Workers'
// per-request execution model. It's a separate route (src/bot/interactions.ts,
// added in a later migration stage) using Discord's HTTP Interactions
// Endpoint instead.
import { initEnvFromBindings } from './env.js';
import { initPool, initD1 } from './db/pool.js';
import { initGamePool } from './db/gameMysql.js';
import { createApp } from './app.js';
import { setCronBindings } from './bot/cronConfig.js';
import { runBotCron } from './bot/cron.js';

/**
 * The exact set of bindings this Worker needs, wired in wrangler.jsonc
 * (HYPERDRIVE) and via `wrangler secret put` (everything else — plaintext
 * vars for non-secret values like DISCORD_CLIENT_ID could move to a `vars`
 * block later, but starting everything as secrets is the safer default).
 */
export interface WorkerBindings {
  HYPERDRIVE: Hyperdrive;
  CACHE_DB: D1Database;
  /** Direct Postgres URL (Supabase pooler) — overrides HYPERDRIVE when set. */
  DATABASE_URL?: string;
  /** Game MySQL (birdflop) — real-time game data reads (hybrid architecture). */
  GAME_MYSQL_HOST?: string;
  GAME_MYSQL_PORT?: number;
  GAME_MYSQL_USER?: string;
  GAME_MYSQL_PASSWORD?: string;
  GAME_MYSQL_DATABASE?: string;
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  DISCORD_REDIRECT_URI: string;
  DISCORD_BOT_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  JWT_SECRET: string;
  REDIS_HOST: string;
  REDIS_PORT: string;
  REDIS_PASSWORD: string;
  WEBPANEL_HMAC_SECRET: string;
  BOT_API_TOKEN: string;
  /** Per-site vote callback keys ("site1:key1,site2:key2") — secret, via `wrangler secret put`. */
  VOTE_CALLBACK_KEYS?: string;
  NODE_ENV: string;
  PAYNOW_API_KEY: string;
  PAYNOW_STORE_ID: string;
  PAYNOW_WEBHOOK_SECRETS: string;
  PAYNOW_BASE_URL: string;
}

const app = createApp();

export default {
  async fetch(
    request: Request,
    bindings: WorkerBindings,
    ctx: ExecutionContext,
  ): Promise<Response> {
    // Idempotent per warm isolate — only the first request on a given
    // isolate actually builds env/opens the pool; later ones reuse both.
    initEnvFromBindings(bindings as unknown as Record<string, unknown>);
    // Hyperdrive is the connection path (TLS terminates inside Cloudflare —
    // direct pg/TLS from workerd cannot reach Supabase: node:tls shims are
    // broken and cloudflare:sockets startTls rejects the pooler cert chain).
    // A plain DATABASE_URL var is accepted as a Node-dev/local override only.
    initPool(bindings.DATABASE_URL || bindings.HYPERDRIVE.connectionString);
    initD1(bindings.CACHE_DB);
    // GAME MYSQL (hybrid, 2026-08-22): real-time reads of game data (profiles,
    // balances, stats) from the live birdflop MySQL — the same DB the plugin
    // writes. No more 5-minute WebSync staleness.
    if (bindings.GAME_MYSQL_HOST && bindings.GAME_MYSQL_USER && bindings.GAME_MYSQL_PASSWORD && bindings.GAME_MYSQL_DATABASE) {
      initGamePool({
        host: bindings.GAME_MYSQL_HOST,
        port: bindings.GAME_MYSQL_PORT ?? 3306,
        user: bindings.GAME_MYSQL_USER,
        password: bindings.GAME_MYSQL_PASSWORD,
        database: bindings.GAME_MYSQL_DATABASE,
      });
    }
    // Forwarding bindings+ctx is required, not cosmetic: without a real
    // ExecutionContext, c.executionCtx.waitUntil() in interactions.ts has
    // nothing to attach to. Its catch block assumes that means "running
    // under Node" and silently no-ops — but under real Workers it means the
    // isolate tears down all in-flight work the instant this response
    // returns, killing any deferred command (deferReply + later editReply)
    // before the editReply ever runs. That's what left every data-backed
    // slash command stuck on Discord's "thinking..." forever.
    return app.fetch(request, bindings, ctx);
  },

  // Every-minute cron (wrangler.jsonc triggers.crons): webhook queue drain +
  // events tailer (V6 05-03), notification sweep (02-05), role audit (02-07),
  // analytics rollup (02-09). Legs are isolated inside runBotCron — one
  // failing never kills the others, and everything no-ops safely until the
  // owner sets the Discord channel/role ids as vars.
  async scheduled(
    _controller: ScheduledController,
    bindings: WorkerBindings,
    ctx: ExecutionContext,
  ): Promise<void> {
    initEnvFromBindings(bindings as unknown as Record<string, unknown>);
    initPool(bindings.DATABASE_URL || bindings.HYPERDRIVE.connectionString);
    initD1(bindings.CACHE_DB);
    setCronBindings(bindings as unknown as Record<string, unknown>);
    ctx.waitUntil(
      runBotCron()
        .then((report) => {
          console.log(
            `[cron] webhooks: ${report.webhookDeliveries.delivered}/${report.webhookDeliveries.processed} delivered ` +
              `(${report.webhookDeliveries.retried} retry, ${report.webhookDeliveries.dead} dead), ` +
              `tailer: ${report.webhookTailer.queued}/${report.webhookTailer.events} queued, ` +
              `sweep: ${report.sweep.fired} fired (${report.sweep.errors} err), ` +
              `audit: ${report.audit.changed}/${report.audit.checked} changed, rollup: ${report.rollup.ran ? report.rollup.metrics + ' metrics' : 'skip'}`,
          );
        })
        .catch((err: unknown) => {
          console.error('[cron] pass crashed:', err);
        }),
    );
  },
};
