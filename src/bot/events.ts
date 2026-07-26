/**
 * Event handlers for the ImperiumMC bot.
 *
 * `registerHandlers` wires every event the bot cares about onto a single
 * Client instance. Keeping the wiring here (and the logic in the command
 * modules) keeps index.ts small.
 */
import {
  type Client,
  Events,
  type GuildMember,
  type Interaction,
} from 'discord.js';
import { BRANDING, EMOJI } from './config.js';
import { commandMap } from './commands/index.js';
import { errorEmbed, welcomeMessage } from './embeds.js';
import { getServerStatus } from './apiClient.js';

/** Log online status and set the initial presence. */
async function onReady(client: Client): Promise<void> {
  let playerCount: number | undefined;
  try {
    const status = await getServerStatus();
    if (status.ok && status.data.online) playerCount = status.data.playerCount;
  } catch {
    // Presence is best-effort; ignore.
  }

  const activity = playerCount
    ? `${playerCount} citizens on ${BRANDING.serverIp}`
    : BRANDING.serverIp;

  client.user?.setPresence({
    status: 'online',
    activities: [{ name: activity, type: 3 /* Watching */ }],
  });

  console.log(
    `${EMOJI.eagle} ${BRANDING.serverName} bot online as ${client.user?.tag}`,
  );
}

/** Route a slash command interaction to its handler. */
async function onInteractionCreate(interaction: Interaction): Promise<void> {
  if (!interaction.isChatInputCommand()) return;

  const command = commandMap.get(interaction.commandName);
  if (!command) {
    await interaction.reply({
      embeds: [errorEmbed(`Unknown command: \`${interaction.commandName}\``)],
      ephemeral: true,
    });
    return;
  }

  try {
    await command.execute(interaction);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unexpected error';
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ embeds: [errorEmbed(message)] }).catch(() => undefined);
    } else {
      await interaction
        .reply({ embeds: [errorEmbed(message)], ephemeral: true })
        .catch(() => undefined);
    }
    console.error(`Command ${command.name} failed:`, err);
  }
}

/** DM new members with link instructions. */
async function onGuildMemberAdd(member: GuildMember): Promise<void> {
  if (member.user.bot) return;
  try {
    await member.send(welcomeMessage());
  } catch {
    // DMs may be closed — non-fatal.
  }
}

/** Attach all event handlers to the given client. */
export function registerHandlers(client: Client): void {
  client.once(Events.ClientReady, (c) => {
    void onReady(c);
  });
  client.on(Events.InteractionCreate, (i) => {
    void onInteractionCreate(i);
  });
  client.on(Events.GuildMemberAdd, (m) => {
    void onGuildMemberAdd(m);
  });
}
