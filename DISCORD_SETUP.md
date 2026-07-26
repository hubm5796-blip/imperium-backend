# Discord Bot Setup Guide

## Step 1: Create the Application

1. Go to https://discord.com/developers/applications
2. Click "New Application" → Name it "ImperiumMC" → Create
3. Copy the **Application ID** (this is your `DISCORD_CLIENT_ID`)

## Step 2: Configure OAuth2

1. Go to **OAuth2 → General**
2. Copy the **Client Secret** (this is your `DISCORD_CLIENT_SECRET`)
3. Add Redirect URI: `https://imperiummc.net/auth/callback`
4. Also add: `http://localhost:3000/auth/callback` (for development)

## Step 3: Create the Bot

1. Go to **Bot** tab → **Add Bot**
2. Copy the **Bot Token** (this is your `DISCORD_BOT_TOKEN`)
3. Under **Privileged Gateway Intervals**: Enable **Server Members Intent**
4. Under **Message Content Intent**: Enable if you want the bot to read messages

## Step 4: Set Bot Permissions

The bot needs these permissions (integer: `274877990400`):
- ✅ Send Messages
- ✅ Embed Links
- ✅ Read Message History
- ✅ Add Reactions
- ✅ Use Slash Commands
- ✅ Manage Roles (for auto-role on link)

## Step 5: Invite the Bot

Use this URL (replace `YOUR_CLIENT_ID`):

```
https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=274877990400&scope=bot+applications.commands
```

Or use the Discord Developer Portal's URL Generator under OAuth2 → URL Generator:
- Scopes: `bot`, `applications.commands`
- Bot Permissions: Send Messages, Embed Links, Read Message History, Manage Roles

## Step 6: Configure the Backend

Create `.env` in the `imperium-backend` directory:

```env
DISCORD_CLIENT_ID=your_application_id
DISCORD_CLIENT_SECRET=your_client_secret
DISCORD_REDIRECT_URI=https://imperiummc.net/auth/callback
DISCORD_BOT_TOKEN=your_bot_token
JWT_SECRET=generate_a_random_32_char_string
DATABASE_URL=postgresql://user:password@localhost:5432/imperiummc
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=your_redis_password
WEBPANEL_HMAC_SECRET=must_match_plugin_config
PORT=3001
NODE_ENV=production
CORS_ORIGINS=https://imperiummc.net,https://www.imperiummc.net
DISCORD_LINKED_ROLE_ID=optional_role_id_for_linked_players
DISCORD_GUILD_ID=your_discord_server_id
```

## Step 7: Start the Backend

```bash
cd imperium-backend
npm install
npm run build
npm start          # API server on port 3001
npm run start:bot  # Discord bot (separate terminal)
```

## Step 8: Verify

1. Bot should appear online in your Discord server
2. Slash commands should appear when you type `/` in a channel
3. Test `/online` — should show server status
4. Test the link flow: `/discord link` in-game → `/link <code>` in Discord

## Linking Flow

```
Player in Minecraft                  Discord/Website
─────────────────                    ───────────────
/discord link                        
→ Gets 6-char code                   
                        ──────────→   /link ABC123 (Discord)
                                       OR enter code on website
                        ←──────────    Confirmation + auto-role
```

## Security Notes

- The bot token is a secret — never commit it to git
- The HMAC secret must match `webpanel.hmac-secret` in the plugin's `config.yml`
- The JWT secret should be a random 32+ character string
- PostgreSQL queries are read-only from the web backend
- All mutations go through the Redis command bus (HMAC-authenticated)
