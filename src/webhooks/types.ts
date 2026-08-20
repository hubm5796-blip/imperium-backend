// V6 05-03: outbound webhook event catalog. Typed + versioned; the `v` field
// lets consumers evolve independently. Events are emitted from backend
// ingestion points (PayNow handler, web_events tailer, web_queue transitions)
// — the plugin keeps its existing writers, no new plugin surface required.

export type OutboundEvent =
  // commerce (emitted directly at ingestion)
  | { type: 'subscription.updated'; v: 1; uuid: string; productId: string; status: 'active' | 'canceled' | 'renewed'; at: string }
  | { type: 'order.delivered'; v: 1; uuid: string | null; requestId: string; sku: string; at: string }
  // game lifecycle (mapped from web_events rows by the tailer)
  | { type: 'player.rankup'; v: 1; uuid: string; username: string; fromRank: number; toRank: number; at: string }
  | { type: 'player.prestige'; v: 1; uuid: string; username: string; prestigeLevel: number; at: string }
  | { type: 'war.result'; v: 1; eventId: string; winnerLegion: string; at: string }
  | { type: 'season.roll'; v: 1; seasonId: string; name: string; at: string }
  // operational
  | { type: 'test.ping'; v: 1; at: string };

export type OutboundEventType = OutboundEvent['type'];

/** Every type a subscriber may select. */
export const ALL_EVENT_TYPES: OutboundEventType[] = [
  'subscription.updated',
  'order.delivered',
  'player.rankup',
  'player.prestige',
  'war.result',
  'season.roll',
  'test.ping',
];

/** The wire envelope consumers receive (they dedupe on `id`). */
export interface WebhookEnvelope {
  id: string;
  type: OutboundEventType;
  v: number;
  createdAt: string;
  data: Omit<OutboundEvent, 'type' | 'v'>;
}

export function envelopeOf(event: OutboundEvent, id: string): WebhookEnvelope {
  const { type, v, ...data } = event;
  return { id, type, v, createdAt: event.at, data };
}

/** web_events.event_type → outbound event type (the tailer's mapping).
 *  Types the plugin doesn't emit yet simply never appear — no error path. */
export const FEED_TYPE_MAP: Record<string, OutboundEventType> = {
  player_rankup: 'player.rankup',
  player_prestige: 'player.prestige',
  war_result: 'war.result',
  season_roll: 'season.roll',
};
