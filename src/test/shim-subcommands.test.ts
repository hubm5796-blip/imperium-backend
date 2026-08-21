/**
 * V6 02-06 — subcommand support in InteractionShim: /ticket open subject:...
 * wraps its real arguments inside a type-1 SUB_COMMAND option; the getters
 * must read at that depth, and memberRoles powers the staff gate.
 */
import { describe, expect, it } from 'vitest';
import { InteractionShim, type RawInteraction } from '../bot/interactionShim.js';

function ticketInteraction(): RawInteraction {
  return {
    id: '1', token: 't', application_id: 'a', type: 2,
    data: {
      name: 'ticket',
      options: [
        {
          name: 'open',
          type: 1,
          options: [
            { name: 'subject', type: 3, value: 'Crate keys missing' },
            { name: 'category', type: 3, value: 'bug' },
          ],
        },
      ],
    },
    member: { user: { id: '42', username: 'tester' }, roles: ['999', 'staff-role'] },
    guild_id: '777',
  };
}

describe('InteractionShim subcommands', () => {
  it('exposes subcommandName', () => {
    const shim = new InteractionShim(ticketInteraction(), 'token');
    expect(shim.subcommandName).toBe('open');
  });

  it('getString reads inside the subcommand wrapper', () => {
    const shim = new InteractionShim(ticketInteraction(), 'token');
    expect(shim.options.getString('subject', true)).toBe('Crate keys missing');
    expect(shim.options.getString('category', true)).toBe('bug');
    expect(shim.options.getString('missing', false)).toBeNull();
  });

  it('exposes member roles for the staff gate', () => {
    const shim = new InteractionShim(ticketInteraction(), 'token');
    expect(shim.memberRoles).toContain('staff-role');
  });

  it('flat commands still resolve options at the top level', () => {
    const raw = ticketInteraction();
    raw.data = { name: 'stats', options: [{ name: 'user', type: 6, value: 'u1' }] };
    const shim = new InteractionShim(raw, 'token');
    expect(shim.subcommandName).toBeUndefined();
    expect(shim.options.getUser('user', true)?.id).toBe('u1');
  });
});
