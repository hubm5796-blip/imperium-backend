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
import { createApp } from './app.js';

/**
 * The exact set of bindings this Worker needs, wired in wrangler.jsonc
 * (HYPERDRIVE) and via `wrangler secret put` (everything else — plaintext
 * vars for non-secret values like DISCORD_CLIENT_ID could move to a `vars`
 * block later, but starting everything as secrets is the safer default).
 */
export interface WorkerBindings {
  HYPERDRIVE: Hyperdrive;
  CACHE_DB: D1Database;
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
    initPool(bindings.HYPERDRIVE.connectionString);
    initD1(bindings.CACHE_DB);
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
};
