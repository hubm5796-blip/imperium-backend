/** Central registry of all slash commands. */
import { balanceCommand } from './balance.js';
import { leaderboardCommand } from './leaderboard.js';
import { linkCommand } from './link.js';
import { onlineCommand } from './online.js';
import { profileCommand } from './profile.js';
import { statsCommand } from './stats.js';
import { storeCommand } from './store.js';
import { unlinkCommand } from './unlink.js';
import type { BotCommand } from './_shared.js';

export const commands: BotCommand[] = [
  linkCommand,
  unlinkCommand,
  profileCommand,
  balanceCommand,
  statsCommand,
  leaderboardCommand,
  onlineCommand,
  storeCommand,
];

/** Map of command name -> command for O(1) dispatch. */
export const commandMap: ReadonlyMap<string, BotCommand> = new Map(
  commands.map((c) => [c.name, c]),
);
