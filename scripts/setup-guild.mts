/**
 * Guild setup — ImperiumMC Discord (guild 1350930327861727262).
 * Idempotent: creates channels/categories if missing, posts content once.
 * Usage: npx tsx scripts/setup-guild.mts
 */
const TOKEN = process.env.DISCORD_BOT_TOKEN!;
if (!TOKEN) throw new Error('Set DISCORD_BOT_TOKEN');
const GUILD_ID = '1350930327861727262';
const BASE = 'https://discord.com/api/v10';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function dapi(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bot ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429) {
    const retry = (JSON.parse(await res.text()).retry_after ?? 5) * 1000 + 500;
    console.log(`  rate-limited, waiting ${Math.ceil(retry / 1000)}s...`);
    await sleep(retry);
    return dapi(method, path, body);
  }
  if (!res.ok && res.status !== 204) {
    const text = await res.text();
    throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.status === 204 ? null : res.json();
}

async function channels(): Promise<any[]> {
  return dapi('GET', `/guilds/${GUILD_ID}/channels`);
}

async function ensureCategory(name: string): Promise<string> {
  const existing = (await channels()).find((c: any) => c.name === name && c.type === 4);
  if (existing) return existing.id;
  const created = await dapi('POST', `/guilds/${GUILD_ID}/channels`, { name, type: 4 });
  console.log(`+ category ${name}`);
  return created.id;
}

async function ensureText(name: string, categoryId: string, topic: string, slowmode = 0): Promise<string> {
  const existing = (await channels()).find((c: any) => c.name === name && c.type === 0);
  if (existing) {
    await dapi('PATCH', `/channels/${existing.id}`, { topic }).catch(() => {});
    return existing.id;
  }
  const created = await dapi('POST', `/guilds/${GUILD_ID}/channels`, {
    name, type: 0, parent_id: categoryId, topic, rate_limit_per_user: slowmode,
  });
  console.log(`+ channel #${name}`);
  return created.id;
}

async function postOnce(channelId: string, content: string, marker: string): Promise<void> {
  const msgs = await dapi('GET', `/channels/${channelId}/messages?limit=20`);
  if (msgs.some((m: any) => (m.content || '').includes(marker))) {
    console.log(`  (already: ${marker})`);
    return;
  }
  await dapi('POST', `/channels/${channelId}/messages`, { content });
  console.log(`  posted: ${marker}`);
}

// ── content ─────────────────────────────────────────────────────────────────

const WELCOME = `# Welcome to Romanica

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

Want something changed? Post in suggestions.`;

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

Having trouble? Open a ticket in support.`;

const SUGGESTIONS = `Got an idea for the server? Post it here.

Good suggestions: specific, realistic, explains the *why*.
Bad suggestions: "add skyblock" with no context.

We read everything. Stuff that gets implemented tends to come from this channel.`;

// ── run ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('Setting up Romanica guild...');

  const info = await ensureCategory('ROMANICA');
  const welcomeId = await ensureText('welcome', info, 'Start here — IP, basics, linking guide');
  const rulesId = await ensureText('rules', info, 'Read before playing. Breaking these = punishment.');
  const announceId = await ensureText('announcements', info, 'Server news, events, downtime. Rare @everyone pings.', 3600);
  const changelogId = await ensureText('changelog', info, 'Every change we ship, newest first.');
  const linkId = await ensureText('link-your-account', info, 'How to link Minecraft ↔ Discord');

  const community = await ensureCategory('COMMUNITY');
  const generalId = await ensureText('general', community, 'Talk about anything. Keep it civil.');
  const suggestId = await ensureText('suggestions', community, 'Server improvement ideas — specific ones get implemented.', 300);
  await ensureText('showcase', community, 'Your builds, your rank-ups, your lucky crate pulls.');
  await ensureText('media', community, 'Clips and screenshots.');

  const support = await ensureCategory('SUPPORT');
  await ensureText('support', support, 'Use /ticket to open a support ticket. Staff respond fast.', 60);
  await ensureText('bug-reports', support, 'Found something broken? Describe it + how to reproduce.', 120);

  await postOnce(welcomeId, WELCOME, 'Welcome to Romanica');
  await postOnce(rulesId, RULES, 'Server Rules');
  await postOnce(linkId, LINK_INFO, 'Account Linking');
  await postOnce(announceId, ANNOUNCE, 'Announcements');
  await postOnce(changelogId, CHANGELOG, 'Changelog');
  await postOnce(suggestId, SUGGESTIONS, 'Got an idea');

  console.log('Done.');
}

main().catch((err) => { console.error(err); process.exit(1); });
