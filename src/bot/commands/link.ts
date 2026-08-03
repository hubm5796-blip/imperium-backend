/** /link <code> — confirm a Discord↔Minecraft account link. */
import { SlashCommandBuilder } from '@discordjs/builders';
import { confirmLink } from '../apiClient.js';
import { BRANDING, EMOJI } from '../config.js';
import { successEmbed, errorEmbed } from '../embeds.js';
import { type BotCommand, grantLinkedRole } from './_shared.js';

export const linkCommand: BotCommand = {
  name: 'link',
  toJSON() {
    return new SlashCommandBuilder()
      .setName('link')
      .setDescription('Link your Discord account to your Minecraft account')
      .addStringOption((o) =>
        o
          .setName('code')
          .setDescription('The 6-character code from /discord link in-game')
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
      if (result.status === 404) message = 'Invalid or expired code. Run `/discord link` in-game for a fresh one.';
      else if (result.status === 409) message = 'This Discord account is already linked, or the code belongs to a linked account.';
      await interaction.editReply({ embeds: [errorEmbed(message, 'Link failed')] });
      return;
    }

    // Best-effort: grant the linked role in the guild this command was run
    // from (an HTTP interaction only carries context for that one guild —
    // unlike the old gateway bot, there's no live cache of every guild the
    // bot happens to share with the user to loop over).
    await grantLinkedRole(interaction);

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
