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

redisPublisher.on('error', (err) => logger.error({ err }, 'Redis publisher error'));
redisSubscriber.on('error', (err) => logger.error({ err }, 'Redis subscriber error'));

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
    const entry = pendingResponses.get(parsed.request_id);
    if (!entry) return; // not waiting on this id (or already timed out)
    pendingResponses.delete(parsed.request_id);
    clearTimeout(entry.timer);
    entry.resolve(parsed);
  });
}

/**
 * HMAC-SHA256 signature of `"$type|$timestamp|$nonce|$requestId"` using the
 * shared WEBPANEL_HMAC_SECRET. The plugin computes the same signature on
 * receipt and rejects mismatches.
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
 */
export async function sendCommand(
  type: string,
  payload: Record<string, unknown>,
): Promise<CommandEnvelope> {
  const requestId = nanoid(16);
  const timestamp = Date.now();
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = signCommand(type, timestamp, nonce, requestId);

  const envelope: CommandEnvelope = {
    type,
    request_id: requestId,
    timestamp,
    nonce,
    signature,
    payload,
  };

  await redisPublisher.publish(COMMANDS_CHANNEL, JSON.stringify(envelope));
  return envelope;
}

/**
 * Send a command and wait for the matching response on the responses channel.
 * Rejects if no response arrives within timeoutMs.
 */
export async function sendCommandWithResponse(
  type: string,
  payload: Record<string, unknown>,
  timeoutMs = 5_000,
): Promise<ResponseEnvelope> {
  ensureResponsesSubscribed();

  const envelope = await sendCommand(type, payload);
  const requestId = envelope.request_id;

  return new Promise<ResponseEnvelope>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingResponses.delete(requestId);
      reject(new Error(`Timed out waiting for response to ${type} (${requestId})`));
    }, timeoutMs);

    pendingResponses.set(requestId, {
      resolve,
      reject,
      timer,
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
 */
export async function consumeLinkCode(code: string): Promise<LinkCodeRecord | null> {
  const key = `${LINK_CODE_PREFIX}${code.toUpperCase()}`;
  const raw = await redisPublisher.get(key);
  if (raw === null) return null;
  // Delete immediately so the code is single-use.
  await redisPublisher.del(key);
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
