/**
 * V6 05-05 — pre-built cost-class rate limits for import at route level.
 * These are the endpoint-class presets from the blueprint's cost table.
 */
import { rateLimit } from './rateLimit.js';

/** Cached reads (leaderboards, seasons, features) — generous. */
export const cheapReadLimit = rateLimit(120, 60_000, 'cheap-read');

/** Standard reads (profiles, aggregates, order history) — moderate. */
export const standardReadLimit = rateLimit(60, 60_000, 'std-read');

/** Heavy uncached joins (public profile cold, admin lists) — strict. */
export const heavyReadLimit = rateLimit(24, 60_000, 'heavy-read');

/** Writes (comments, tickets, orders) — restrictive. */
export const writeCostLimit = rateLimit(12, 60_000, 'write-cost');

/** Public API surface per-IP. */
export const publicIpLimit = rateLimit(120, 60_000, 'public-ip');
