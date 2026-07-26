# ImperiumMC Backend

Backend API + Discord bot for ImperiumMC.

## Architecture

- **API**: Hono (TypeScript) — REST API for player data, auth, linking
- **Bot**: discord.js v14 — slash commands, profile cards, link validation
- **DB**: PostgreSQL (shared with game server, read-only queries)
- **Redis**: Command bus to plugin (HMAC-authenticated, existing protocol)

## Setup

```bash
cp .env.example .env
# Fill in your credentials
npm install
npm run dev        # API server
npm run dev:bot    # Discord bot (separate terminal)
```

## Production

```bash
npm run build
npm start          # API
npm run start:bot  # Bot
```

## API Endpoints

See `src/api/routes.ts` for the full route list.

## Discord Bot Setup

1. Create an application at https://discord.com/developers/applications
2. Add a Bot to the application
3. Copy the Client ID, Client Secret, and Bot Token into `.env`
4. Set the redirect URI to `https://imperiummc.net/auth/callback`
5. Enable the `applications.commands` and `bot` scopes
6. Required permissions: Send Messages, Embed Links, Read Message History
7. Invite URL:
   ```
   https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=274877990400&scope=bot+applications.commands
   ```

## Linking Flow

1. Player runs `/discord link` in-game → gets 6-char code
2. Player visits website dashboard → enters code, or types `/link <code>` in Discord
3. Backend validates code against plugin via Redis command bus
4. On success: `discord_links` table updated, player gets full dashboard access
