/** /link <code> — confirm a Discord↔Minecraft account link. */
import { SlashCommandBuilder } from 'discord.js';
import { confirmLink } from '../apiClient.js';
import { BRANDING, EMOJI } from '../config.js';
import { successEmbed, errorEmbed } from '../embeds.js';
import {
  type BotCommand,
  grantLinkedRole,
  resolveGuild,
} from './_shared.js';

export const linkCommand: BotCommand = {
  name: 'link',
  toJSON() {
    return new SlashCommandBuilder()
      .setName('link')
      .setDescription('Link your Discord account to your Minecraft account')
      .addStringOption((o) =>
        o
          .setName('code')
          .setDescription('The 6-character code from /link in-game')
          .setRequired(true)
          .setMinLength(6)
          .setMaxLength(6),
      )
      .toJSON();
  },
  async execute(interaction) {
    const code = interaction.options.getString('code', true).trim().toUpperCase();
    const discordId = interaction.user.id;

    await interaction.deferReply({ ephemeral: true });

    const result = await confirmLink(discordId, code);
    if (!result.ok) {
      let message = result.message;
      if (result.status === 404) message = 'Invalid or expired code. Run `/link` in-game for a fresh one.';
      else if (result.status === 409) message = 'This Discord account is already linked, or the code belongs to a linked account.';
      await interaction.editReply({ embeds: [errorEmbed(message, 'Link failed')] });
      return;
    }

    // Best-effort: grant the linked role in every guild the user shares.
    for (const guild of interaction.client.guilds.cache.values()) {
      const g = await resolveGuild(interaction, guild.id);
      const member = g && (await g.members.fetch(discordId).catch(() => null));
      if (member) await grantLinkedRole(member);
    }

    const embed = successEmbed(
      `Your Discord account is now linked to **${result.data.username}**.\nUse \`/profile\`, \`/balance\`, and \`/stats\` to view your empire.`,
      `${EMOJI.eagle} Linked to ${BRANDING.serverName}`,
    );
    if (result.data.uuid) {
      embed.addFields({
        name: `${EMOJI.user} Minecraft`,
        value: `\`${result.data.username}\``,
        inline: true,
      });
    }

    await interaction.editReply({ embeds: [embed] });
  },
};
