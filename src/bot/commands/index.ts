/** Central registry of all slash commands. */
import { accessibilityCommand } from './accessibility.js';
import { balanceCommand } from './balance.js';
import { botstatsCommand } from './botstats.js';
import { cratesCommand } from './crates.js';
import { dungeonsCommand } from './dungeons.js';
import { factionsCommand } from './factions.js';
import { gadgetsCommand } from './gadgets.js';
import { helpCommand } from './help.js';
import { leaderboardCommand } from './leaderboard.js';
import { linkCommand } from './link.js';
import { morphCommand } from './morph.js';
import { onlineCommand } from './online.js';
import { parkourCommand } from './parkour.js';
import { petsCommand } from './pets.js';
import { profileCommand } from './profile.js';
import { skillsCommand } from './skills.js';
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
  cratesCommand,
  petsCommand,
  dungeonsCommand,
  skillsCommand,
  morphCommand,
  parkourCommand,
  factionsCommand,
  gadgetsCommand,
  accessibilityCommand,
  botstatsCommand,
  helpCommand,
];

/** Map of command name -> command for O(1) dispatch. */
export const commandMap: ReadonlyMap<string, BotCommand> = new Map(
  commands.map((c) => [c.name, c]),
);
