/** Register slash commands to the ImperiumMC guild. Usage: npx tsx scripts/register-guild-commands.mts */
const TOKEN = process.env.DISCORD_BOT_TOKEN!;
const CLIENT_ID = '1520285608906330293';
const GUILD_ID = '1350930327861727262';

const { commands } = await import('../src/bot/commands/index.js');
const body = commands.map(c => c.toJSON());
console.log(`Registering ${body.length} commands to guild ${GUILD_ID}...`);

const res = await fetch(`https://discord.com/api/v10/applications/${CLIENT_ID}/guilds/${GUILD_ID}/commands`, {
  method: 'PUT',
  headers: { Authorization: `Bot ${TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

if (!res.ok) {
  console.error(`Failed: ${res.status}`, (await res.text()).slice(0, 300));
  process.exit(1);
}
const registered = await res.json();
console.log(`Registered ${registered.length} commands:`, registered.map((c: any) => '/' + c.name).join(', '));
