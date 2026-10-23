/**
 * imperium-backend #7 (name sweep): the Discord bot's user-facing strings must
 * say "Romanica", never "ImperiumMC". The bot renders every branded surface
 * through BRANDING (src/bot/config.ts) and the embed builders in
 * src/bot/embeds.ts — these tests exercise the real builders so a regression
 * that reintroduces the old name in an embed or DM fails here. Internal
 * identifiers (Redis key namespaces like 'ImperiumMC:reg_nonce:', the
 * plugins/ImperiumMC probe paths) are deliberately out of scope.
 */
import { describe, expect, it } from 'vitest';
import { BRANDING } from '../bot/config.js';
import { profileEmbed, storeEmbed, welcomeMessage } from '../bot/embeds.js';

const DATA = {
  uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  username: 'Griefos',
  rank: 12,
  prestigeLevel: 0,
  denarius: 1000,
  auctoritas: 40,
  civitas: 7,
  aureus: 5,
  blocksMined: 9999,
  playtimeSeconds: 3600,
  pvpKills: 3,
  pvpDeaths: 4,
  trophies: 2,
} as Parameters<typeof profileEmbed>[0];

describe('#7 name sweep — bot strings render Romanica', () => {
  it('BRANDING.serverName is Romanica (single source for embed branding)', () => {
    expect(BRANDING.serverName).toBe('Romanica');
  });

  it('welcome DM greets Romanica, not ImperiumMC', () => {
    const text = welcomeMessage();
    expect(text).toContain('Welcome to Romanica!');
    expect(text).not.toContain('ImperiumMC');
  });

  it('store embed is titled Romanica Store', () => {
    expect(storeEmbed().data.title).toContain('Romanica');
    expect(storeEmbed().data.title).not.toContain('ImperiumMC');
  });

  it('profile embed describes a citizen of Romanica', () => {
    const desc = profileEmbed(DATA).data.description ?? '';
    expect(desc).toContain('Citizen of Romanica.');
    expect(desc).not.toContain('ImperiumMC');
  });
});
