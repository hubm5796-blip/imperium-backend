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
- **Redis**: Command bus to plugin (HMAC-authenticated, existing protocol) — per-call
  connections (`src/db/redisSocket.ts`); also the rate-limit/D1 cache layer.

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
3. Set the redirect URI to `https://imperiummc.net/auth/callback`
4. Enable the `applications.commands` scope; point an Interactions Endpoint URL at
   `https://api.imperiummc.net/discord/interactions`
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
3. Backend validates code against plugin via Redis command bus
4. On success: `discord_links` table updated, player gets full dashboard access
