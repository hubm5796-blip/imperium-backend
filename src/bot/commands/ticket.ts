/**
 * /ticket (V6 02-06): the Discord surface of the support-ticket store.
 *
 * Model: the thread is a VIEW of the support_tickets row — the backend is the
 * single source of truth (web/in-game surfaces unaffected by Discord outages).
 *
 *   /ticket open subject category [body]   linked players; creates the private
 *                                         thread + the backend row (cap: 2 open)
 *   /ticket reply <text>                  staff (TICKET_STAFF_ROLE_ID, in-thread)
 *   /ticket close [resolution]            staff; archives + satisfaction prompt
 *   /ticket info                          staff; the current row card
 *   /mytickets                            linked; own tickets table
 *
 * Config (Worker vars): TICKET_ENABLED, TICKET_CATEGORY_ID, TICKET_STAFF_ROLE_ID.
 * Everything degrades to a clear "tickets are not configured" embed when unset.
 */
import { SlashCommandBuilder } from '@discordjs/builders';
import { EmbedBuilder } from '@discordjs/builders';
import { getProfile, createTicketV2, patchTicketV2, appendTicketNoteV2 } from '../apiClient.js';
import { createPrivateThread, addThreadMember, setThreadArchived, sendThreadMessage } from '../discordRest.js';
import { errorEmbed } from '../embeds.js';
import { COLORS, EMOJI } from '../config.js';
import { getCronConfig } from '../cronConfig.js';
import { type BotCommand } from './_shared.js';
import type { InteractionShim } from '../interactionShim.js';

const CATEGORIES = ['bug', 'payment', 'report', 'appeal', 'general'] as const;

function ticketCard(title: string, lines: string[]): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`${EMOJI.scroll} ${title}`)
    .setDescription(lines.join('\n'))
    .setColor(COLORS.gold)
    .setFooter({ text: 'imperiummc.net • Forge your empire.' })
    .setTimestamp();
}

/** The ticket id for in-thread staff commands: parsed from the thread name (`#<id>-user`). */
function ticketIdFromThread(shim: InteractionShim): string | null {
  // Thread context is not exposed by the shim's raw payload for chat commands;
  // staff commands therefore carry an explicit id option — see the builder.
  return null;
}

export const ticketCommand: BotCommand = {
  name: 'ticket',
  toJSON() {
    return new SlashCommandBuilder()
      .setName('ticket')
      .setDescription('Support tickets')
      .addSubcommand((sc) =>
        sc
          .setName('open')
          .setDescription('Open a support ticket (requires a linked Minecraft account)')
          .addStringOption((o) => o.setName('subject').setDescription('Short summary').setRequired(true))
          .addStringOption((o) =>
            o.setName('category').setDescription('bug | payment | report | appeal | general').setRequired(true)
              .addChoices(...CATEGORIES.map((c) => ({ name: c, value: c }))),
          )
          .addStringOption((o) => o.setName('details').setDescription('Describe the issue')),
      )
      .addSubcommand((sc) =>
        sc
          .setName('reply')
          .setDescription('Reply to a ticket (staff)')
          .addStringOption((o) => o.setName('id').setDescription('Ticket id').setRequired(true))
          .addStringOption((o) => o.setName('text').setDescription('Your reply').setRequired(true)),
      )
      .addSubcommand((sc) =>
        sc
          .setName('close')
          .setDescription('Close a ticket (staff)')
          .addStringOption((o) => o.setName('id').setDescription('Ticket id').setRequired(true))
          .addStringOption((o) => o.setName('resolution').setDescription('How it was resolved')),
      )
      .addSubcommand((sc) =>
        sc
          .setName('info')
          .setDescription('Ticket details (staff)')
          .addStringOption((o) => o.setName('id').setDescription('Ticket id').setRequired(true)),
      )
      .toJSON();
  },
  async execute(interaction) {
    const config = getCronConfig();
    const sub = interaction.subcommandName ?? '';
    const token = config.botToken;

    if (!config.ticketEnabled || !config.ticketCategoryId) {
      await interaction.deferReply({ ephemeral: true });
      await interaction.editReply({
        embeds: [errorEmbed('Support tickets are not configured on this server yet.')],
      });
      return;
    }

    if (sub === 'open') {
      await interaction.deferReply({ ephemeral: true });
      const profile = await getProfile({ discordId: interaction.user.id });
      if (!profile.ok) {
        await interaction.editReply({
          embeds: [errorEmbed('Tickets require a linked Minecraft account. Run `/link` first.', 'Not linked')],
        });
        return;
      }
      const category = interaction.options.getString('category', true);
      const subject = interaction.options.getString('subject', true).slice(0, 160);
      const details = interaction.options.getString('details', false)?.slice(0, 2000) ?? '(no details provided)';

      // Thread first so the row can carry its id (the view model).
      const thread = await createPrivateThread(
        config.ticketCategoryId,
        `#new-${profile.data.username ?? interaction.user.username}`.slice(0, 100),
        token,
      );
      if (!thread) {
        await interaction.editReply({ embeds: [errorEmbed('Could not create the ticket thread. Try again shortly.')] });
        return;
      }
      await addThreadMember(thread.id, interaction.user.id, token);

      const created = await createTicketV2({
        uuid: profile.data.uuid,
        category,
        subject,
        body: details,
        discordThreadId: thread.id,
        discordOpenerId: interaction.user.id,
      });
      if (!created.ok) {
        await setThreadArchived(thread.id, true, token).catch(() => undefined);
        const msg =
          created.status === 429
            ? 'You already have 2 open tickets — close one first.'
            : created.status === 400
              ? created.message
              : 'Ticket creation failed — try again shortly.';
        await interaction.editReply({ embeds: [errorEmbed(msg)] });
        return;
      }
      // Rename the thread to the real id (create-then-rename: no name on create with id unknown).
      // Kept simple: send the opening card into the thread instead.
      await sendThreadMessage(
        thread.id,
        token,
        {
          content:
            `**Ticket #${created.data.id}** — ${category} — opened by <@${interaction.user.id}> ` +
            `(${profile.data.username ?? 'unknown'})\n**${subject}**\n${details}\n` +
            `Staff: reply with \`/ticket reply id:${created.data.id} text:...\``,
        },
      );
      await interaction.editReply({
        embeds: [ticketCard('Ticket opened', [`**#${created.data.id}** — ${subject}`, `Category: ${category}`, 'A staff member will respond in this thread.'])],
      });
      return;
    }

    // Staff-gated commands below.
    const staff = config.ticketStaffRoleId;
    if (!staff || !interaction.memberRoles.includes(staff)) {
      await interaction.deferReply({ ephemeral: true });
      await interaction.editReply({ embeds: [errorEmbed('Staff only.', 'Forbidden')] });
      return;
    }

    if (sub === 'reply') {
      await interaction.deferReply({ ephemeral: true });
      const id = interaction.options.getString('id', true);
      const text = interaction.options.getString('text', true).slice(0, 2000);
      const noted = await appendTicketNoteV2(id, 'staff', `(discord <@${interaction.user.id}>) ${text}`);
      if (!noted.ok) {
        await interaction.editReply({ embeds: [errorEmbed(noted.status === 404 ? 'Ticket not found.' : noted.message)] });
        return;
      }
      // Mirror into the thread if one exists: fetch list, find the row.
      const { listTicketsV2 } = await import('../apiClient.js');
      const rows = await listTicketsV2();
      const row = rows.ok ? rows.data.tickets.find((t) => t.id === id) : undefined;
      if (row?.discord_thread_id) {
        await sendThreadMessage(row.discord_thread_id, token, { content: `**Staff:** ${text}` });
      }
      await interaction.editReply({ embeds: [ticketCard(`Replied to #${id}`, [text.slice(0, 500)])] });
      return;
    }

    if (sub === 'close') {
      await interaction.deferReply({ ephemeral: true });
      const id = interaction.options.getString('id', true);
      const resolution = interaction.options.getString('resolution', false) ?? 'resolved';
      const closed = await patchTicketV2(id, { status: 'closed', satisfaction: 'pending' });
      if (!closed.ok) {
        await interaction.editReply({ embeds: [errorEmbed(closed.status === 404 ? 'Ticket not found.' : closed.message)] });
        return;
      }
      const { listTicketsV2 } = await import('../apiClient.js');
      const rows = await listTicketsV2();
      const row = rows.ok ? rows.data.tickets.find((t) => t.id === id) : undefined;
      if (row?.discord_thread_id) {
        await sendThreadMessage(row.discord_thread_id, token, {
          content: `**Ticket #${id} closed** — ${resolution}. React 👍/👎 on the web ticket page to rate the help.`,
        }).catch(() => undefined);
        await setThreadArchived(row.discord_thread_id, true, token).catch(() => undefined);
      }
      await interaction.editReply({ embeds: [ticketCard(`Closed #${id}`, [`Resolution: ${resolution}`])] });
      return;
    }

    if (sub === 'info') {
      await interaction.deferReply({ ephemeral: true });
      const id = interaction.options.getString('id', true);
      const { listTicketsV2 } = await import('../apiClient.js');
      const rows = await listTicketsV2();
      const row = rows.ok ? rows.data.tickets.find((t) => t.id === id) : undefined;
      if (!row) {
        await interaction.editReply({ embeds: [errorEmbed('Ticket not found.')] });
        return;
      }
      await interaction.editReply({
        embeds: [
          ticketCard(`Ticket #${row.id}`, [
            `**Subject:** ${row.subject}`,
            `**Category:** ${row.category} • **Status:** ${row.status} • **Priority:** ${row.priority}`,
            `**Player:** ${row.username ?? row.uuid}`,
            `**Thread:** ${row.discord_thread_id ? `<#${row.discord_thread_id}>` : 'none'}`,
            `**Opened:** ${row.created_at}`,
          ]),
        ],
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    await interaction.editReply({ embeds: [errorEmbed('Unknown subcommand.')] });
  },
};

void ticketIdFromThread; // reserved: thread-context resolution when the shim exposes it
