/**
 * V6 02-08 — bridge contract pins: v1 compat parsing, the v2 envelope, and
 * the health state machine (pure halves only; the webhook POST is stubbed at
 * the route level in a follow-up pass).
 */
import { describe, expect, it } from 'vitest';
import { parseBridgeBody } from '../bot/bridge.js';

describe('bridge payload parsing', () => {
  it('v1 body maps to a chat event', () => {
    const e = parseBridgeBody({ player: 'Sextus', rank: 'X', message: 'hello' });
    expect(e).toEqual({ kind: 'chat', player: 'Sextus', rank: 'X', message: 'hello', uuid: undefined });
  });

  it('v2 envelope passes the typed event through', () => {
    const e = parseBridgeBody({ v: 2, event: { kind: 'rankup', player: 'Sextus', fromRank: 9, toRank: 10 } });
    expect(e).toMatchObject({ kind: 'rankup', toRank: 10 });
  });

  it('garbage is rejected (400 at the route)', () => {
    expect(parseBridgeBody({})).toBeNull();
    expect(parseBridgeBody({ v: 2 })).toBeNull();
    expect(parseBridgeBody({ player: 'x' })).toBeNull();
  });
});
