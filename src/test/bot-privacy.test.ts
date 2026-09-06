import { describe, expect, it } from 'vitest';

/**
 * B-44: premium balances are self-scope in the bot's public embeds —
 * /profile @someone and /balance @someone render WITHOUT Aureus/Auctoritas
 * (the web privacy contract strips exactly those two); self views keep all
 * four currencies.
 */
import { balanceEmbed, profileEmbed } from '../bot/embeds.js';

const DATA = {
  uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  username: 'Griefos',
  rank: 12,
  prestigeLevel: 1,
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

function fieldNames(embed: { data: { fields?: Array<{ name: string }> } }): string[] {
  return (embed.data.fields ?? []).map((f) => f.name);
}

describe('B-44 premium currency privacy in bot embeds', () => {
  it('self profile keeps Aureus and Auctoritas fields', () => {
    const names = fieldNames(profileEmbed(DATA, { includePremium: true }));
    expect(names.some((n) => n.includes('Aureus'))).toBe(true);
    expect(names.some((n) => n.includes('Auctoritas'))).toBe(true);
  });

  it('non-self profile strips Aureus and Auctoritas fields', () => {
    const names = fieldNames(profileEmbed(DATA, { includePremium: false }));
    expect(names.some((n) => n.includes('Aureus'))).toBe(false);
    expect(names.some((n) => n.includes('Auctoritas'))).toBe(false);
    // Public fields stay (rank/stats may keep targets).
    expect(names.some((n) => n.includes('Denarius'))).toBe(true);
    expect(names.some((n) => n.includes('Civitas'))).toBe(true);
  });

  it('self balance lists all four currencies', () => {
    const embed = balanceEmbed(DATA, { includePremium: true });
    const desc = embed.data.description ?? '';
    for (const name of ['Denarius', 'Auctoritas', 'Civitas', 'Aureus']) {
      expect(desc).toContain(name);
    }
  });

  it('non-self balance lists only the public currencies', () => {
    const embed = balanceEmbed(DATA, { includePremium: false });
    const desc = embed.data.description ?? '';
    expect(desc).toContain('Denarius');
    expect(desc).toContain('Civitas');
    expect(desc).not.toContain('Aureus');
    expect(desc).not.toContain('Auctoritas');
  });

  it('defaults keep current behavior (all fields) for callers that pass nothing', () => {
    expect(fieldNames(profileEmbed(DATA)).some((n) => n.includes('Aureus'))).toBe(true);
    expect((balanceEmbed(DATA).data.description ?? '').length).toBeGreaterThan(0);
  });
});
