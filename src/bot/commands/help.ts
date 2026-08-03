/** /help — show all bot commands and server info. */
import { SlashCommandBuilder, EmbedBuilder } from '@discordjs/builders';
import type { BotCommand } from './_shared.js';

export const helpCommand: BotCommand = {
  name: 'help',
  toJSON() {
    return new SlashCommandBuilder()
      .setName('help')
      .setDescription('View all ImperiumMC bot commands and how to get started')
      .toJSON();
  },
  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setTitle('🏛️ ImperiumMC — Command Guide')
      .setColor(0x9932cc)
      .setDescription('A Roman-themed OP Prison MMORPG. Mine, enchant, prestige, and ascend to godhood!')
      .addFields(
        {
          name: '🔗 Account Commands',
          value: [
            '`/link` — Link your Minecraft account to Discord',
            '`/unlink` — Remove your account link',
            '`/profile` — View your player profile',
            '`/balance` — Check your currency balances',
          ].join('\n'),
          inline: true,
        },
        {
          name: '📊 Info Commands',
          value: [
            '`/stats` — View detailed statistics',
            '`/leaderboard` — Top players rankings',
            '`/online` — Check server status',
            '`/store` — Browse the store',
          ].join('\n'),
          inline: true,
        },
        {
          name: '🎮 Game Guides',
          value: [
            '`/crates` — View all 20 crate types',
            '`/pets` — View all 20+ pets',
            '`/dungeons` — View all 12 dungeons',
          ].join('\n'),
          inline: false,
        },
        {
          name: '💰 Currencies',
          value: [
            '**Denarius** 💰 — Primary currency (earned by mining)',
            '**Auctoritas** ⚡ — Secondary currency (enchants, upgrades)',
            '**Civitas** ♛ — Premium currency (crystals, rare items)',
            '**Aureus** 👑 — Store/prestige currency (limited sources)',
          ].join('\n'),
          inline: false,
        },
        {
          name: '🚀 Getting Started',
          value: [
            '1. Join the server and mine blocks to earn Denarius',
            '2. Use `/enchant` to upgrade your pickaxe',
            '3. Rank up with `/rankup` to unlock better mines',
            '4. Prestige at rank 100 for permanent bonuses',
            '5. Complete story chapters via `/story`',
            '6. Join or create a Legion with `/legion`',
          ].join('\n'),
          inline: false,
        },
      )
      .setFooter({ text: 'ImperiumMC — Roma Aeterna | Support all versions 1.8-26.2+' })
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  },
};
