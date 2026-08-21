// V6 05-01 — GET /api/v2/openapi.json: the machine-readable contract for the
// live v2 surface, assembled in TypeScript (types checked, no hand-edited
// YAML file drifting). Today it documents what EXISTS; the @hono/zod-openapi
// conversion (per the blueprint) derives future routes from their Zod
// schemas so the spec cannot drift — this artifact is the stepping stone.
import { Hono } from 'hono';
import type { AppContextVariables } from '../../types/index.js';

type ApiEnv = { Variables: AppContextVariables };

export const openapiV2 = new Hono<ApiEnv>();

const jsonError = (codes: string[]) => ({
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: { code: { type: 'string', enum: codes }, message: { type: 'string' } },
    },
  },
});

const okData = (dataSchema: unknown, withMeta = false) => ({
  type: 'object',
  required: ['data'],
  properties: withMeta
    ? { data: dataSchema, meta: { type: 'object', properties: { nextCursor: { type: 'string', nullable: true } } } }
    : { data: dataSchema },
});

const SPEC = {
  openapi: '3.1.0',
  info: {
    title: 'ImperiumMC API v2',
    version: '1.0.0',
    description:
      'The versioned API surface. v2 contract: responses are enveloped ' +
      '({data, meta?} / {error:{code,message}}); error codes are a closed enum; ' +
      'list endpoints page via opaque base64url keyset cursors; unknown query ' +
      'params are rejected. v1 routes keep their legacy shapes.',
  },
  servers: [{ url: 'https://api.imperiummc.net' }],
  // V6 05-04: the four principal schemes. sessionCookie + botToken cover v1-era routes;
  // serviceToken is the delegated (X-Mc-Uuid) split; bearerKey is the imp_ API-key family
  // (scopes per key, enforced by requireScope).
  components: {
    securitySchemes: {
      sessionCookie: { type: 'apiKey', in: 'cookie', name: 'imperium_session' },
      botToken: { type: 'apiKey', in: 'header', name: 'X-Bot-Token', description: 'The shared internal bot token' },
      serviceToken: { type: 'apiKey', in: 'header', name: 'X-Bot-Token', description: 'INTERNAL_SERVICE_TOKEN — required (with X-Mc-Uuid) for delegated identity once the split is active' },
      bearerKey: { type: 'http', scheme: 'bearer', description: 'imp_ API key (hash-at-rest; read/webhook scopes only)' },
    },
  },
  paths: {
    '/api/v2/ping': {
      get: {
        summary: 'Envelope smoke test',
        responses: { '200': { description: 'Pong envelope' } },
      },
    },
    '/api/v2/leaderboards/{board}': {
      get: {
        summary: 'Leaderboard page (keyset cursor)',
        description:
          'Boards: denarius | blocks | prestige | playtime. Page with meta.nextCursor; ' +
          'cursors are stable across inserts (unlike offset pages).',
        parameters: [
          { name: 'board', in: 'path', required: true, schema: { type: 'string', enum: ['denarius', 'blocks', 'prestige', 'playtime'] } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
          { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'Opaque token from a previous meta.nextCursor' },
        ],
        responses: {
          '200': {
            description: 'Board page',
            content: {
              'application/json': {
                schema: okData(
                  {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        rank: { type: 'integer' },
                        uuid: { type: 'string' },
                        username: { type: 'string' },
                        value: { type: 'number' },
                        secondary: { type: 'number' },
                      },
                    },
                  },
                  true,
                ),
              },
            },
          },
          '400': { description: 'UNKNOWN_PARAM | INVALID_CURSOR', content: { 'application/json': { schema: jsonError(['UNKNOWN_PARAM', 'INVALID_CURSOR']) } } },
          '404': { description: 'NOT_FOUND (unknown board)', content: { 'application/json': { schema: jsonError(['NOT_FOUND']) } } },
          '503': { description: 'REGISTRY_UNAVAILABLE', content: { 'application/json': { schema: jsonError(['REGISTRY_UNAVAILABLE']) } } },
        },
      },
    },
    '/api/v2/public/player/{username}': {
      get: {
        summary: 'Public player profile (privacy-scoped)',
        description:
          'Single aggregate for shareable profile pages. The schema EXCLUDES ' +
          'aureus/auctoritas by construction (never selected into the payload). ' +
          'Name resolution reads player_names only — no Mojang fallback. ' +
          '30 req/min/IP; Redis 60s; stale-serve (X-Stale-Profile) bridges DB outages.',
        parameters: [{ name: 'username', in: 'path', required: true, schema: { type: 'string', maxLength: 20 } }],
        responses: {
          '200': {
            description: 'Public profile (denarius + civitas only; never aureus/auctoritas)',
            content: {
              'application/json': {
                schema: okData({
                  type: 'object',
                  properties: {
                    uuid: { type: 'string' },
                    username: { type: 'string' },
                    bedrock: { type: 'boolean' },
                    online: { type: 'boolean' },
                    rank: { type: 'integer' },
                    rankName: { type: 'string', nullable: true },
                    prestige: { type: 'integer' },
                    legion: { type: 'string', nullable: true },
                    denarius: { type: 'number' },
                    civitas: { type: 'number' },
                    blocksMined: { type: 'integer' },
                    playtimeSeconds: { type: 'integer' },
                    pvpKills: { type: 'integer' },
                    pvpDeaths: { type: 'integer' },
                    trophies: { type: 'integer' },
                    kothWins: { type: 'integer' },
                    elo: { type: 'object', nullable: true, properties: { rating: { type: 'integer' }, peak: { type: 'integer' } } },
                    achievementCount: { type: 'integer' },
                    recentAchievements: { type: 'array', items: { type: 'string' } },
                    parkourBests: {
                      type: 'array',
                      items: { type: 'object', properties: { course: { type: 'string' }, timeMs: { type: 'number' }, completions: { type: 'integer' } } },
                    },
                    stale: { type: 'boolean', description: 'True when served from the outage bridge' },
                  },
                }),
              },
            },
          },
          '400': { description: 'INVALID_PARAM', content: { 'application/json': { schema: jsonError(['INVALID_PARAM']) } } },
          '404': { description: 'NOT_FOUND (never joined)', content: { 'application/json': { schema: jsonError(['NOT_FOUND']) } } },
          '503': { description: 'REGISTRY_UNAVAILABLE', content: { 'application/json': { schema: jsonError(['REGISTRY_UNAVAILABLE']) } } },
        },
      },
    },
    '/api/v2/member': {
      get: {
        summary: 'Role-sync aggregate (bot token)',
        description:
          'Link identity + rank + prestige + donor state in one call. Donor truth is the ' +
          'plugin-synced donor_ranks row with expiry awareness (active:false past expires_at).',
        parameters: [{ name: 'discord_id', in: 'query', required: true, schema: { type: 'string', pattern: '^\\d{5,25}$' } }],
        responses: {
          '200': {
            description: 'Member summary',
            content: {
              'application/json': {
                schema: okData({
                  type: 'object',
                  properties: {
                    uuid: { type: 'string' },
                    discordId: { type: 'string' },
                    username: { type: 'string', nullable: true },
                    rank: { type: 'integer' },
                    prestigeLevel: { type: 'integer' },
                    donor: { type: 'object', nullable: true, properties: { tier: { type: 'string' }, type: { type: 'string' }, active: { type: 'boolean' }, expiresAt: { type: 'string', nullable: true } } },
                  },
                }),
              },
            },
          },
          '401': { description: 'UNAUTHORIZED (X-Bot-Token required)', content: { 'application/json': { schema: jsonError(['UNAUTHORIZED']) } } },
          '404': { description: 'NOT_FOUND (discord id not linked)', content: { 'application/json': { schema: jsonError(['NOT_FOUND']) } } },
          '503': { description: 'REGISTRY_UNAVAILABLE', content: { 'application/json': { schema: jsonError(['REGISTRY_UNAVAILABLE']) } } },
        },
      },
    },
    '/api/v2/events/stream': {
      get: {
        summary: 'SSE live-event stream',
        description:
          'text/event-stream. topics=status,economy,season,events (15s/60s/120s/30s). ' +
          'Change-gated frames, 25s keepalives, 10-minute cap then event:bye; ' +
          'Last-Event-ID replays from a per-topic ring.',
        parameters: [
          { name: 'topics', in: 'query', schema: { type: 'string', default: 'status' } },
          { name: 'Last-Event-ID', in: 'header', schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Event stream', content: { 'text/event-stream': { schema: { type: 'string' } } } },
          '400': { description: 'INVALID_PARAM (unknown topic)', content: { 'application/json': { schema: jsonError(['INVALID_PARAM']) } } },
        },
      },
    },
    '/api/v2/webhooks/subscriptions': {
      get: {
        summary: 'List webhook subscribers (bot token; secrets redacted)',
        responses: { '200': { description: 'Subscriber list' }, '401': { description: 'UNAUTHORIZED', content: { 'application/json': { schema: jsonError(['UNAUTHORIZED']) } } } },
      },
      post: {
        summary: 'Create a webhook subscriber (bot token; secret shown once)',
        responses: { '201': { description: 'Created' }, '400': { description: 'INVALID_PARAM', content: { 'application/json': { schema: jsonError(['INVALID_PARAM']) } } }, '401': { description: 'UNAUTHORIZED', content: { 'application/json': { schema: jsonError(['UNAUTHORIZED']) } } } },
      },
    },
    '/api/v2/webhooks/subscriptions/{id}/test': {
      post: {
        summary: 'Enqueue a test.ping delivery',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Queued' }, '404': { description: 'NOT_FOUND', content: { 'application/json': { schema: jsonError(['NOT_FOUND']) } } }, '409': { description: 'Subscriber not active' } },
      },
    },
    '/api/v2/webhooks/subscriptions/{id}': {
      delete: {
        summary: 'Delete a webhook subscriber',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Deleted' }, '404': { description: 'NOT_FOUND', content: { 'application/json': { schema: jsonError(['NOT_FOUND']) } } } },
      },
    },
    '/api/v2/webhooks/deliveries': {
      get: {
        summary: 'Webhook delivery queue inspection (bot token)',
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'failed', 'delivered', 'dead'] } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
        ],
        responses: { '200': { description: 'Delivery rows' }, '401': { description: 'UNAUTHORIZED', content: { 'application/json': { schema: jsonError(['UNAUTHORIZED']) } } } },
      },
    },
  },
} as const;

openapiV2.get('/openapi.json', (c) =>
  c.json(SPEC as unknown as Record<string, unknown>, 200, {
    'Cache-Control': 'public, max-age=300',
  }),
);
