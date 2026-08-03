/**
 * Discord Interactions Endpoint — replaces the old gateway connection
 * entirely. Discord POSTs every interaction (slash commands, button clicks)
 * here instead of over a WebSocket; this is what makes the bot runnable on
 * Workers (a persistent gateway `Client` can't). See interactionShim.ts for
 * why the first ack is returned directly from this handler rather than sent
 * via a side-channel REST call.
 *
 * Two things this bot used to do are gone as a direct consequence and have
 * no HTTP equivalent: live "Watching N citizens" presence, and DMing new
 * members a welcome message on join (both gateway-only).
 */
import { Hono } from 'hono';
import { verifyKey } from 'discord-interactions';
import { env } from '../env.js';
import { logger } from '../utils/logger.js';
import { commandMap } from './commands/index.js';
import { isLeaderboardComponent, handleLeaderboardComponent } from './commands/leaderboard.js';
import { errorEmbed } from './embeds.js';
import { InteractionShim, type RawInteraction } from './interactionShim.js';

const INTERACTION_TYPE = {
  PING: 1,
  APPLICATION_COMMAND: 2,
  MESSAGE_COMPONENT: 3,
} as const;

/** Timeout guard: if a command never acks (bug, hang), still respond before Discord's 3s cutoff. */
const FIRST_ACK_TIMEOUT_MS = 2_500;

export const discordInteractions = new Hono();

discordInteractions.post('/', async (c) => {
  const signature = c.req.header('x-signature-ed25519');
  const timestamp = c.req.header('x-signature-timestamp');
  const rawBody = await c.req.text();

  if (!signature || !timestamp || !env.discord.publicKey) {
    return c.json({ error: 'Missing signature' }, 401);
  }

  const valid = await verifyKey(rawBody, signature, timestamp, env.discord.publicKey);
  if (!valid) {
    return c.json({ error: 'Invalid signature' }, 401);
  }

  const raw = JSON.parse(rawBody) as RawInteraction;

  if (raw.type === INTERACTION_TYPE.PING) {
    return c.json({ type: 1 }); // PONG
  }

  if (raw.type !== INTERACTION_TYPE.APPLICATION_COMMAND && raw.type !== INTERACTION_TYPE.MESSAGE_COMPONENT) {
    return c.json({ error: 'Unsupported interaction type' }, 400);
  }

  const shim = new InteractionShim(raw, env.discord.botToken);

  const run = async (): Promise<void> => {
    try {
      if (raw.type === INTERACTION_TYPE.MESSAGE_COMPONENT) {
        const customId = shim.customId ?? '';
        if (isLeaderboardComponent(customId)) {
          await handleLeaderboardComponent(shim);
        } else {
          await shim.deferUpdate();
        }
        return;
      }

      const command = commandMap.get(shim.commandName);
      if (!command) {
        await shim.reply({ embeds: [errorEmbed(`Unknown command: \`${shim.commandName}\``)], ephemeral: true });
        return;
      }
      await command.execute(shim);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unexpected error';
      if (shim.deferred || shim.replied) {
        await shim.editReply({ embeds: [errorEmbed(message)] }).catch(() => undefined);
      } else {
        await shim.reply({ embeds: [errorEmbed(message)], ephemeral: true }).catch(() => undefined);
      }
      logger.error({ err, command: shim.commandName }, 'Interaction handling failed');
    }
  };

  const executePromise = run();

  // Wait for the first ack (deferReply/reply/deferUpdate) so we can return it
  // as the direct response Discord requires within 3s; if nothing acks in
  // time (a bug upstream), fall back to a deferred ack so the interaction
  // doesn't just fail outright — the error handler above can still editReply
  // once `run()` actually finishes.
  const ackPayload = await Promise.race([
    shim.firstAck,
    new Promise((resolve) => setTimeout(() => resolve({ type: 5 }), FIRST_ACK_TIMEOUT_MS)),
  ]);

  // Let the rest of the handler (editReply calls, etc.) keep running after
  // we've returned. Workers only guarantees execution continues past a
  // returned Response when the promise is registered with waitUntil; Node
  // has no such requirement (the process just keeps running), and Hono's
  // executionCtx getter *throws* rather than returning undefined when no
  // ExecutionContext exists (e.g. under @hono/node-server) — a plain
  // optional-chained access isn't enough to guard it.
  const backgroundWork = executePromise.catch((err) =>
    logger.error({ err }, 'Interaction background execution failed'),
  );
  try {
    c.executionCtx.waitUntil(backgroundWork);
  } catch {
    // No ExecutionContext (Node) — the process keeps running on its own.
  }

  return c.json(ackPayload as Record<string, unknown>);
});
