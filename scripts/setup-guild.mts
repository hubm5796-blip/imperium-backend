/**
 * Guild setup — ImperiumMC Discord (guild 1350930327861727262).
 *
 * Creates the full channel structure with topics, posts the welcome/rules/
 * changelog/announcement content, and configures the categories. Idempotent:
 * every step checks for an existing channel by name first.
 *
 * Usage: DISCORD_BOT_TOKEN=... npx tsx scripts/setup-guild.mts
 *
 * Every piece of player-facing text below is written the way a server owner
 * would actually type it — short sentences, contractions, no corporate voice.
 */
import { REST } from '@discordjs/rest';
import { Routes, ChannelType, PermissionFlagsBits, type RESTPostAPIGuildChannelJSONBody } from 'discord-api-types/v10';

const GUILD_ID = '1350930327861727262';
const TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!TOKEN) throw new Error('Set DISCORD_BOT_TOKEN');
const rest = new REST({ version: '10' }).setToken(TOKEN);

// ── helpers ─────────────────────────────────────────────────────────────────

async function guildChannels(): Promise<Array<{ id: string; name: string; type: number; parent_id?: string }>> {
  return (await rest.get(Routes.guildChannels(GUILD_ID))) as never;
}

async function ensureCategory(name: string): Promise<string> {
  const existing = (await guildChannels()).find((c) => c.name === name && c.type === ChannelType.GuildCategory);
  if (existing) return existing.id;
  const created = (await rest.post(Routes.guildChannels(GUILD_ID), {
    body: { name, type: ChannelType.GuildCategory },
  })) as { id: string };
  console.log(`+ category #${name}`);
  return created.id;
}

async function ensureText(name: string, categoryId: string, topic: string, slowmode = 0): Promise<string> {
  const existing = (await guildChannels()).find((c) => c.name === name && c.type === ChannelType.GuildText);
  if (existing) {
    await rest.patch(Routes.channel(existing.id), { body: { topic } }).catch(() => {});
    return existing.id;
  }
  const created = (await rest.post(Routes.guildChannels(GUILD_ID), {
    body: {
      name,
      type: ChannelType.GuildText,
      parent_id: categoryId,
      topic,
      rate_limit_per_user: slowmode,
    } satisfies RESTPostAPIGuildChannelJSONBody,
  })) as { id: string };
  console.log(`+ channel #${name}`);
  return created.id;
}

async function postOnce(channelId: string, content: string, marker: string): Promise<void> {
  const msgs = (await rest.get(Routes.channelMessages(channelId), { query: new URLSearchParams({ limit: '20' }) })) as Array<{ content: string; id: string }>;
  if (msgs.some((m) => m.content.includes(marker))) {
    console.log(`  (already posted: ${marker})`);
    return;
  }
  await rest.post(Routes.channelMessages(channelId), { body: { content } });
  console.log(`  posted: ${marker}`);
}

// ── content (written like a person, not a marketing department) ────────────

const WELCOME = `# Welcome to ImperiumMC

We're a Roman-themed OP prison server. Mine your way up the rank ladder, prestige, and climb from a nameless prisoner to Imperator.

**IP:** \`play.imperiummc.net\` — Java + Bedrock (Geyser)

**Getting started:**
1. Join the server and pick your first pickaxe
2. Mine blocks, earn Denarius, rank up
3. Every mine has better ore than the last one

**Link your account:**
Run \`/link\` in-game, then \`/link\` here in Discord with the code it gives you. Linking unlocks balance checks, stat lookups, and the dashboard at imperiummc.net

**Store:** store.imperiummc.net — supporter tiers, Aureus, crates

If you need help, open a ticket with \`/ticket\` in <#support>. We answer fast.`;

const RULES = `# Server Rules

**1.** No exploiting. Found a dupe? Report it, don't use it. Reporters get rewarded, exploiters get banned.

**2.** No harassment, hate speech, or discrimination. Banter is fine, being a jerk isn't.

**3.** No cheating. X-ray, auto-clickers, macros — we'll catch it. Our anticheat is custom and it's good.

**4.** No advertising other servers.

**5.** No real-money trading outside the official store. Account selling = permanent ban.

**6.** Use tickets for support. Don't ping staff directly.

Breaking rules earns punishments scaled to what you did. Cheating is an instant ban. Being annoying is a mute. Use judgment.`;

const CHANGELOG = `# Changelog

Everything we change on the server, posted here. Newest at the top.

**13 September**
- Crate key bundles are now on the store (basic through mythic)
- Donor tiers reworked — the old "auto-sell" perk never actually worked, it's been replaced with real sell-tax discounts (Imperator = tax free)
- Legion member caps now benefit from the owner's donor tier
- Mining payouts now show a live "+X auto-sold" ticker above your hotbar

**12 September**
- New crate animation tier system (different opens per crate quality)
- Rank kits rebalanced — PvP kit now requires rank 10, gear scaled appropriately
- The Hall of Fortune tracks server lifetime crate opens
- 85 mine worlds prepped for the next content drop

**10 September**
- Rank L unlocks /fly
- Fly-time vouchers added to vote crates

Want something changed? Post in <#suggestions>.`;

const ANNOUNCE = `# Announcements

Server news, events, and downtime notices. @everyone pings here are rare — when you see one, it matters.

**Current event:** Weekend Forum — 1.3x Denarius + Auctoritas, double pickaxe XP

**Season 1** is live. New ranking ladder, new mines up to L, prestige system with eras and endings.`;

const LINK_INFO = `# Account Linking

**Why link?**
- Check your balance from Discord with \`/balance\`
- See your stats, crate keys, and progress with \`/profile\`
- Log into the dashboard at imperiummc.net
- Get the Linked role here

**How to link:**
1. In Minecraft, run \`/link\` — it gives you a short code
2. Here in Discord, run \`/link code:YOUR_CODE\`
3. Done. You're linked.

**To unlink:** \`/unlink\` — works here or in-game.

Having trouble? Open a ticket in <#support>.`;

const SUGGESTIONS = `Got an idea for the server? Post it here.

Good suggestions: specific, realistic, explains the *why*.
Bad suggestions: "add skyblock" with no context.

We read everything. Stuff that gets implemented tends to come from this channel.`;

// ── run ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('Setting up ImperiumMC guild...');

  // Info category
  const info = await ensureCategory('IMPERIUMMC');
  const welcomeId = await ensureText('welcome', info, 'Start here — IP, basics, linking guide');
  const rulesId = await ensureText('rules', info, 'Read before playing. Breaking these = punishment.');
  await ensureText('announcements', info, 'Server news, events, downtime. Rare @everyone pings.', 3600);
  await ensureText('changelog', info, 'Every change we ship, newest first.');
  const linkId = await ensureText('link-your-account', info, 'How to link Minecraft ↔ Discord');

  // Community
  const community = await ensureCategory('COMMUNITY');
  await ensureText('general', community, 'Talk about anything. Keep it civil.');
  await ensureText('suggestions', community, 'Server improvement ideas — specific ones get implemented.', 300);
  await ensureText('showcase', community, 'Your builds, your rank-ups, your lucky crate pulls.');
  await ensureText('media', community, 'Clips and screenshots.');

  // Support
  const support = await ensureCategory('SUPPORT');
  await ensureText('support', support, 'Use /ticket to open a support ticket. Staff respond fast.', 60);
  await ensureText('bug-reports', support, 'Found something broken? Describe it + how to reproduce.', 120);

  // Post the pinned content (idempotent — checks for markers)
  await postOnce(welcomeId, WELCOME, 'Welcome to ImperiumMC');
  await postOnce(rulesId, RULES, 'Server Rules');
  await postOnce(linkId, LINK_INFO, 'Account Linking');
  const channels = await guildChannels();
  const announceCh = channels.find((c) => c.name === 'announcements');
  const changelogCh = channels.find((c) => c.name === 'changelog');
  const suggestCh = channels.find((c) => c.name === 'suggestions');
  if (announceCh) await postOnce(announceCh.id, ANNOUNCE, 'Announcements');
  if (changelogCh) await postOnce(changelogCh.id, CHANGELOG, 'Changelog');
  if (suggestCh) await postOnce(suggestCh.id, SUGGESTIONS, 'Got an idea');

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
