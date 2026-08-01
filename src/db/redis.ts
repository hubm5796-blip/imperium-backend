import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Redis } from 'ioredis';
import { nanoid } from 'nanoid';
import { env } from '../env.js';
import { logger } from '../utils/logger.js';
import type { CommandEnvelope, ResponseEnvelope } from '../types/index.js';

/** Redis channel used to push commands from the web panel to the plugin. */
export const COMMANDS_CHANNEL = 'ImperiumMC:commands';
/** Redis channel the plugin uses to push responses back to the web panel. */
export const RESPONSES_CHANNEL = 'ImperiumMC:responses';
/** Redis key prefix for online-player-count style live state. */
export const ONLINE_COUNT_KEY = 'ImperiumMC:online_count';
/** Redis key prefix for link codes (link:initiate). */
export const LINK_CODE_PREFIX = 'ImperiumMC:link_code:';

/**
 * Publisher client (used for sending commands). Kept separate from the
 * subscriber client because ioredis blocks a connection in subscribe mode.
 */
export const redisPublisher = new Redis({
  host: env.redis.host,
  port: env.redis.port,
  password: env.redis.password || undefined,
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
});

/**
 * Subscriber client (used for receiving responses). Lazily subscribed to the
 * responses channel on first use.
 */
export const redisSubscriber = new Redis({
  host: env.redis.host,
  port: env.redis.port,
  password: env.redis.password || undefined,
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  lazyConnect: false,
});

redisPublisher.on('error', (err) => logger.warn({ err: { message: err.message } }, 'Redis publisher unavailable — in-game actions will be disabled until Redis is running'));
redisSubscriber.on('error', (err) => logger.warn({ err: { message: err.message } }, 'Redis subscriber unavailable — response polling disabled until Redis is running'));

/** In-flight response promises keyed by request_id. */
const pendingResponses = new Map<
  string,
  {
    resolve: (env: ResponseEnvelope) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }
>();

let responsesSubscribed = false;

function ensureResponsesSubscribed(): void {
  if (responsesSubscribed) return;
  responsesSubscribed = true;
  redisSubscriber.subscribe(RESPONSES_CHANNEL).catch((err) => {
    logger.error({ err }, 'Failed to subscribe to responses channel');
    responsesSubscribed = false;
  });

  redisSubscriber.on('message', (channel, message) => {
    if (channel !== RESPONSES_CHANNEL) return;
    let parsed: ResponseEnvelope;
    try {
      parsed = JSON.parse(message) as ResponseEnvelope;
    } catch {
      logger.warn({ message }, 'Could not parse response envelope');
      return;
    }
    // The plugin publishes `status` ("OK"|"ERROR"), not `ok`. Derive `ok` so
    // callers can use the boolean regardless of which envelope shape arrived.
    if (typeof parsed.ok !== 'boolean') {
      parsed.ok = parsed.status === 'OK';
    }
    const entry = pendingResponses.get(parsed.request_id);
    if (!entry) return; // not waiting on this id (or already timed out)
    pendingResponses.delete(parsed.request_id);
    clearTimeout(entry.timer);
    entry.resolve(parsed);
  });
}

/**
 * HMAC-SHA256 signature of `"$type|$ts|$nonce|$requestId"` using the shared
 * WEBPANEL_HMAC_SECRET, where `ts` is unix SECONDS (matching the plugin's
 * `WebPanelCommandHandler.verifyCommandSignature`, which signs
 * `"$type|$ts|$nonce|$requestId"` with `ts = currentTimeMillis()/1000` and a
 * 30s freshness window). The plugin computes the same signature on receipt and
 * rejects mismatches.
 */
export function signCommand(
  type: string,
  timestamp: number,
  nonce: string,
  requestId: string,
): string {
  const message = `${type}|${timestamp}|${nonce}|${requestId}`;
  return crypto
    .createHmac('sha256', env.webpanelHmacSecret)
    .update(message)
    .digest('hex');
}

/** Verify an incoming signature (used by the bot when relaying commands). */
export function verifyCommand(
  type: string,
  timestamp: number,
  nonce: string,
  requestId: string,
  signature: string,
): boolean {
  const expected = signCommand(type, timestamp, nonce, requestId);
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature),
    );
  } catch {
    return false;
  }
}

/**
 * Send a command to the plugin via the commands channel. The command envelope
 * is HMAC-signed. Does NOT wait for a response — use sendCommandWithResponse
 * for that.
 *
 * A pre-generated `requestId` may be passed so the caller can register a
 * pending-response waiter BEFORE the command is published (avoids the race
 * where a fast plugin response arrives before the waiter exists). When omitted,
 * a fresh id is generated here.
 */
export async function sendCommand(
  type: string,
  payload: Record<string, unknown>,
  requestId?: string,
): Promise<CommandEnvelope> {
  const id = requestId ?? nanoid(16);
  // Unix SECONDS — the plugin verifies a 30s window against seconds and signs
  // the message with the seconds value. Sending milliseconds broke the bus.
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = signCommand(type, timestamp, nonce, id);

  const envelope: CommandEnvelope = {
    type,
    request_id: id,
    ts: timestamp,
    nonce,
    // Field name MUST be `sig` to match the plugin's `json.get("sig")` read.
    // Sending `signature` was rejected at the plugin's presence guard.
    sig: signature,
    payload,
  };

  await redisPublisher.publish(COMMANDS_CHANNEL, JSON.stringify(envelope));
  return envelope;
}

/**
 * Send a command and wait for the matching response on the responses channel.
 * Rejects if no response arrives within timeoutMs.
 *
 * Ordering: the pending-response entry is registered BEFORE the command is
 * published. Otherwise a fast plugin response could arrive (and be silently
 * dropped by the subscriber) before the waiter exists, causing spurious
 * timeouts.
 */
export async function sendCommandWithResponse(
  type: string,
  payload: Record<string, unknown>,
  timeoutMs = 5_000,
): Promise<ResponseEnvelope> {
  ensureResponsesSubscribed();

  // Generate the request_id up front so the waiter can be registered first.
  const requestId = nanoid(16);

  return new Promise<ResponseEnvelope>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingResponses.delete(requestId);
      reject(new Error(`Timed out waiting for response to ${type} (${requestId})`));
    }, timeoutMs);

    // Register the waiter BEFORE publishing so a fast response is never dropped.
    pendingResponses.set(requestId, {
      resolve,
      reject,
      timer,
    });

    // Publish now that the waiter exists. Swallow errors: if the publish fails
    // we must clean up the pending entry we just registered.
    sendCommand(type, payload, requestId).catch((err) => {
      const entry = pendingResponses.get(requestId);
      if (entry) {
        pendingResponses.delete(requestId);
        clearTimeout(entry.timer);
      }
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

/**
 * Block until a response arrives for the given request_id. Returns null on
 * timeout. Mostly useful when you have an externally-produced request_id.
 */
export async function waitForResponse(
  requestId: string,
  timeoutMs = 5_000,
): Promise<ResponseEnvelope | null> {
  ensureResponsesSubscribed();

  // If the response already arrived it would already be resolved; this helper
  // is for the waiting-from-scratch case.
  return new Promise<ResponseEnvelope | null>((resolve) => {
    const timer = setTimeout(() => {
      pendingResponses.delete(requestId);
      resolve(null);
    }, timeoutMs);

    pendingResponses.set(requestId, {
      resolve: (env) => resolve(env),
      reject: (err) => resolve(null),
      timer,
    });
  });
}

/** Online player count as published by the plugin, or null if unset. */
export async function getOnlinePlayerCount(): Promise<number | null> {
  const raw = await redisPublisher.get(ONLINE_COUNT_KEY);
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Either half of a pending link, as stored against a link code. */
export interface LinkCodeRecord {
  /** Set when the link was initiated from the web panel (Discord known). */
  discordId?: string;
  /** Set when the link was initiated in-game (Minecraft UUID known). */
  uuid?: string;
  createdAt: number;
}

/**
 * Generate a 6-character alphanumeric link code and store it in Redis.
 * The code carries whichever identity half is already known at initiation
 * time (discordId for the web flow, uuid for the in-game flow); the other
 * half is supplied by the caller of /api/link/confirm.
 */
export async function createLinkCode(
  partial: Pick<LinkCodeRecord, 'discordId'> | Pick<LinkCodeRecord, 'uuid'>,
  ttlSeconds = 600,
): Promise<string> {
  const code = generateLinkCode();
  const record: LinkCodeRecord = { ...partial, createdAt: Date.now() };
  await redisPublisher.set(
    `${LINK_CODE_PREFIX}${code}`,
    JSON.stringify(record),
    'EX',
    ttlSeconds,
  );
  return code;
}

/**
 * Look up and consume (single-use delete) a link code. Returns the stored
 * record, or null if the code was not found / already consumed / expired.
 *
 * Uses GETDEL (Redis 6.2+) so the read and the delete happen in a single
 * atomic step. Two concurrent confirmations can no longer both observe the
 * code before either deletes it. If GETDEL is unavailable on the server, a Lua
 * `EVAL` equivalent is used as a fallback.
 */
const GETDEL_LUA = `return redis.call('GETDEL', KEYS[1])`;
// EVALSHA cache: avoid re-sending the script body on every call after the first.
let getdelSha: string | null = null;

export async function consumeLinkCode(code: string): Promise<LinkCodeRecord | null> {
  const key = `${LINK_CODE_PREFIX}${code.toUpperCase()}`;

  let raw: string | null;
  try {
    raw = await redisPublisher.getdel(key);
  } catch (err) {
    // Older Redis (<6.2) or command disabled: fall back to atomic Lua GETDEL.
    logger.warn({ err: { message: (err as Error).message } }, 'GETDEL unavailable, falling back to Lua');
    if (!getdelSha) {
      getdelSha = (await redisPublisher.script('LOAD', GETDEL_LUA).catch(() => null)) as
        | string
        | null;
    }
    raw =
      getdelSha !== null
        ? ((await redisPublisher.evalsha(getdelSha, 1, key)) as string | null)
        : ((await redisPublisher.eval(GETDEL_LUA, 1, key)) as string | null);
  }

  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw) as LinkCodeRecord;
  } catch {
    return null;
  }
}

const LINK_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars

function generateLinkCode(length = 6): string {
  let out = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    out += LINK_CODE_ALPHABET[bytes[i]! % LINK_CODE_ALPHABET.length];
  }
  return out;
}

/** Used only by tests/helpers to flush in-flight state. */
export async function __flushPendingForTests(): Promise<void> {
  for (const [, entry] of pendingResponses) {
    clearTimeout(entry.timer);
    entry.reject(new Error('flushed'));
  }
  pendingResponses.clear();
  await delay(0);
}
