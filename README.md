# ImperiumMC Backend

Backend API + Discord interactions for ImperiumMC.

## Architecture

- **API**: Hono (TypeScript) — REST API for player data, auth, linking, store, PayNow
  webhooks. Runs as a Cloudflare Worker (`src/worker.ts`, deployed via
  `npm run deploy` / `wrangler deploy`; `src/index.ts` is the Node/Hono dev entry).
- **Discord**: HTTP-based interactions — the bot does NOT run a gateway client. Slash
  commands are served from the same app at `/discord/interactions` (`src/bot/interactions.ts`)
  with cron jobs via the Worker schedule; register commands with `npm run register-commands`.
- **DB**: PostgreSQL (Supabase via Hyperdrive, `src/db/pool.ts`) **plus direct reads of the
  game server's MySQL DB** (`src/db/gameMysql.ts`) — the backend both reads and writes
  (donor tiers, dispatch registries, orders, votes).
- **Game MySQL (bus)**: The web command bus (2026-09-19) — signed envelopes queue in
  `web_commands`/`web_responses`/`bus_kv` on the game MariaDB (`src/db/busMysql.ts` over
  the mysqlWire client); the plugin polls at 500ms, this side at 400ms (~1s round-trip).
  Redis remains a wake-on-demand fallback transport (`BUS_TRANSPORT=redis`) — zero
  connections while unused, so the free host sleeps.

## Setup

```bash
cp .env.example .env
# Fill in your credentials
npm install
npm run dev        # API server (tsx watch)
```

## Production

```bash
npm run build          # tsc
npm run deploy         # wrangler deploy (Cloudflare Worker)
npm run test           # vitest
```

## API Endpoints

See `src/api/routes.ts` and `docs/api.md` for the full route list.

## Discord App Setup

(The app serves slash commands over HTTP interactions — no gateway client runs from
this repo, so gateway intents are not required; the REST client (`@discordjs/rest`)
is used for followups and cron notifications.)

1. Create an application at https://discord.com/developers/applications
2. Copy the Client ID, Client Secret, and (for the interactions route) the public key
   into `.env`
3. Set the redirect URI to `https://romanica.net/auth/callback`
4. Enable the `applications.commands` scope; point an Interactions Endpoint URL at
   `https://api.romanica.net/discord/interactions`
5. Register commands: `npm run register-commands`
6. Required bot permissions (if you also invite the bot user): Send Messages,
   Embed Links, Read Message History
7. Invite URL:
   ```
   https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=274877990400&scope=bot+applications.commands
   ```

## Linking Flow

1. Player runs `/discord link` in-game → gets 6-char code
2. Player visits website dashboard → enters code, or types `/link <code>` in Discord
3. Backend validates code against plugin via the game-MySQL command bus (Redis wake-on-demand fallback)
4. On success: `discord_links` table updated, player gets full dashboard access

## Bus transport history (do not re-flip naively)

`BUS_TRANSPORT=redis` was applied `08fc749` and reverted `2727d56` (2026-10-23) after client/Microsoft/Discord sign-in broke in production — the stated cause (non-string EX) was disproven (`redisSocket.ts` stringifies args); the real blocker is the month-dormant Redis path never live-tested. Re-land conditions live in `docs/reviews/2026-10-24-money-path-failure-composition.md` (post-publication note). Until then the signed command bus writes to MySQL `web_commands`, which the plugin does not read.
