// V6 05-01 — the v2 sub-app: shared contract primitives + envelope-native
// routes. Mounted at /api/v2 alongside the expansion's v2 residents (public
// profiles, member, webhooks, SSE) which predate the formal scaffold; new
// envelope-native routes live HERE.
import { Hono } from 'hono';
import { ok } from './respond.js';
import { leaderboardsV2 } from './leaderboards.js';
import { openapiV2 } from './openapi.js';
import { keysApi } from './keys.js';
import { ticketsV2 } from './tickets.js';
import { moderationV2 } from './moderation.js';
import { storeOrdersV2 } from './storeOrders.js';
import { guidesV2 } from './guides.js';
import type { AppContextVariables } from '../../types/index.js';

type ApiEnv = { Variables: AppContextVariables };

export const v2Api = new Hono<ApiEnv>();

// Envelope smoke test — proves the contract end to end (spec + monitors hit this).
v2Api.get('/ping', (c) => ok(c, { pong: true, v: 2, at: new Date().toISOString() }));

v2Api.route('/', leaderboardsV2);
v2Api.route('/', openapiV2);
v2Api.route('/', keysApi);
v2Api.route('/', ticketsV2);
v2Api.route('/', moderationV2);
v2Api.route('/', storeOrdersV2);
v2Api.route('/', guidesV2);
