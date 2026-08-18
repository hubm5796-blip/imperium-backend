// 12a expansion: Zod schemas for the new POST bodies and shared param shapes.
// zod + @hono/zod-validator are already declared dependencies of this repo —
// the expansion is simply the first surface to use them for body validation.
import { z } from 'zod';

/**
 * Minecraft UUID, dashed or undashed (case-insensitive), normalized to the
 * dashed lowercase form the plugin stores (VARCHAR(36) in every game table).
 * Bedrock `.name` identities are usernames, not UUIDs — they go through the
 * username field, never here.
 */
export const mcUuidSchema = z
  .string()
  .regex(
    /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/,
    'must be a Minecraft UUID',
  )
  .transform((raw) => {
    const hex = raw.replace(/-/g, '').toLowerCase();
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  });

/**
 * Minecraft username: 3-16 chars, letters/digits/underscore, optional Bedrock
 * `.` prefix (Floodgate names start with a dot and may be up to 16 chars).
 */
export const mcUsernameSchema = z
  .string()
  .regex(/^\.?[A-Za-z0-9_]{3,16}$/, 'must be a Minecraft username');

/**
 * POST /api/vote/:site body. Vote-site webhooks send at least one of
 * username/uuid; `timestamp` is the vote site's own claim time (unix seconds,
 * informational only — reward eligibility is decided plugin-side).
 */
export const voteBodySchema = z
  .object({
    username: mcUsernameSchema.optional(),
    uuid: mcUuidSchema.optional(),
    timestamp: z.number().int().nonnegative().optional(),
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((body) => Boolean(body.uuid || body.username), {
    message: 'at least one of uuid or username is required',
    path: ['uuid'],
  });

/** POST /api/shop/order body. */
export const shopOrderSchema = z.object({
  sku: z.string().min(3).max(64),
  quantity: z.number().int().min(1).max(10).default(1),
});

/**
 * Discord snowflake: 17-20 decimal digits (current snowflakes are 18-19; the
 * bounds just keep obviously-wrong values out without baking in Discord's
 * internal epoch math).
 */
export const discordIdSchema = z.string().regex(/^\d{17,20}$/, 'must be a Discord id');

/** Dungeon/board slug: lowercase letters, digits, underscore, dash, space-free. */
export const slugSchema = z.string().regex(/^[a-z0-9_-]{1,64}$/, 'must be a lowercase slug');

/**
 * POST /api/lfg/posts body (12c): the Discord worker posts a dungeon LFG call
 * on behalf of a linked player. `username` is the linked Minecraft name
 * (resolved by the worker from its account_links row); the plugin surfaces
 * the post in-game with that name as the leader.
 */
export const lfgPostSchema = z.object({
  dungeon: slugSchema,
  note: z.string().trim().min(1).max(140).optional(),
  discordId: discordIdSchema,
  username: mcUsernameSchema,
});
