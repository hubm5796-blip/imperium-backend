/**
 * Grant Discord permission bits to the guild's staff roles so the
 * default_member_permissions gates on the staff commands resolve to real
 * roles. ORs bits in — never removes anything a human set by hand.
 *
 * Tiering (must mirror moderation.ts):
 *   helper tier  → ModerateMembers (4096): sees /lookup /warn /botstats
 *   mod tier     → + KickMembers (2):       also /history /mute /kick /tempban
 *   admin tier   → + BanMembers (4):        also /ban
 *
 * The RUNTIME gate stays the backend LuckPerms resolve on the linked MC
 * account — these bits only decide command visibility in the client.
 *
 * Usage: node --env-file=.env scripts/grant-staff-perms.mts
 */
const TOKEN = process.env.DISCORD_BOT_TOKEN!;
if (!TOKEN) throw new Error('Set DISCORD_BOT_TOKEN');
const GUILD_ID = '1350930327861727262';
const BASE = 'https://discord.com/api/v10';

const MODERATE = 1n << 40n; // ModerateMembers (timeout bit — NOT 1<<12, that's TTS)
const KICK = 1n << 1n; // KickMembers
const BAN = 1n << 2n; // BanMembers

const HELPER_ROLES = ['Staff', 'Trainee', 'Jr. Mod'];
const MOD_ROLES = ['Moderator', 'Sr. Mod'];
const ADMIN_ROLES = ['Admin', 'Sr. Admin', 'Manager', 'Developer'];
// Owner + Head Admin already hold Administrator, which implies every bit.

async function dapi(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bot ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? null : res.json();
}

const roles: Array<{ id: string; name: string; permissions: string }> = await dapi(
  'GET',
  `/guilds/${GUILD_ID}/roles`,
);

const grants: Record<string, bigint> = {};
for (const name of HELPER_ROLES) grants[name] = MODERATE;
for (const name of MOD_ROLES) grants[name] = MODERATE | KICK;
for (const name of ADMIN_ROLES) grants[name] = MODERATE | KICK | BAN;

for (const role of roles) {
  const want = grants[role.name];
  if (want === undefined) continue;
  const current = BigInt(role.permissions);
  // Exact-set (not just OR): the first run of this script ORed the wrong bit
  // (1<<12, TTS) — writing the exact intended value also strips that.
  const next = want;
  if (current === next) {
    console.log(`= ${role.name} already correct (${next.toString()})`);
    continue;
  }
  await dapi('PATCH', `/guilds/${GUILD_ID}/roles/${role.id}`, { permissions: next.toString() });
  console.log(`+ ${role.name}: ${current.toString()} -> ${next.toString()}`);
  await new Promise((r) => setTimeout(r, 600)); // rate-limit courtesy
}
console.log('Done.');
