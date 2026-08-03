import crypto from 'node:crypto';
import { nanoid } from 'nanoid';
import { env } from '../env.js';
import { logger } from '../utils/logger.js';
import { redisCommand, redisSubscribeOnce, type RedisSocketConfig } from './redisSocket.js';
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
 * Redis key prefix for in-game website-login codes. Written directly by the
 * plugin's `/webcode` command (same Redis instance, shared credentials) —
 * the backend only ever reads/consumes these, never generates them.
 */
export const LOGIN_CODE_PREFIX = 'ImperiumMC:login_code:';

function socketConfig(): RedisSocketConfig {
  return {
    host: env.redis.host,
    port: env.redis.port,
    password: env.redis.password || undefined,
    tls: env.redis.tls,
  };
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
 */
export async function sendCommand(
  type: string,
  payload: Record<string, unknown>,
): Promise<CommandEnvelope> {
  const requestId = nanoid(16);
  // Unix SECONDS — the plugin verifies a 30s window against seconds and signs
  // the message with the seconds value. Sending milliseconds broke the bus.
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16).toString('hex');
  const signature = signCommand(type, timestamp, nonce, requestId);

  const envelope: CommandEnvelope = {
    type,
    request_id: requestId,
    ts: timestamp,
    nonce,
    // Field name MUST be `sig` to match the plugin's `json.get("sig")` read.
    // Sending `signature` was rejected at the plugin's presence guard.
    sig: signature,
    payload,
  };

  await redisCommand(socketConfig(), ['PUBLISH', COMMANDS_CHANNEL, JSON.stringify(envelope)]);
  return envelope;
}

function parseResponse(message: string): ResponseEnvelope | null {
  let parsed: ResponseEnvelope;
  try {
    parsed = JSON.parse(message) as ResponseEnvelope;
  } catch {
    logger.warn({ message }, 'Could not parse response envelope');
    return null;
  }
  // The plugin publishes `status` ("OK"|"ERROR"), not `ok`. Derive `ok` so
  // callers can use the boolean regardless of which envelope shape arrived.
  if (typeof parsed.ok !== 'boolean') {
    parsed.ok = parsed.status === 'OK';
  }
  return parsed;
}

/**
 * Send a command and wait for the matching response on the responses channel.
 * Rejects if no response arrives within timeoutMs.
 *
 * Subscribes first, THEN publishes (via `onSubscribed`) — avoids the race
 * where the plugin could respond before we're listening. Each call owns its
 * own subscribe connection scoped to this one request/response pair, rather
 * than a shared long-lived subscriber multiplexing by request_id (that model
 * doesn't fit Workers' per-request execution well).
 */
export async function sendCommandWithResponse(
  type: string,
  payload: Record<string, unknown>,
  timeoutMs = 5_000,
): Promise<ResponseEnvelope> {
  let requestId = '';
  const message = await redisSubscribeOnce(
    socketConfig(),
    RESPONSES_CHANNEL,
    (raw) => {
      const parsed = parseResponse(raw);
      return parsed !== null && parsed.request_id === requestId;
    },
    timeoutMs,
    async () => {
      const envelope = await sendCommand(type, payload);
      requestId = envelope.request_id;
    },
  );

  if (message === null) {
    throw new Error(`Timed out waiting for response to ${type}`);
  }
  const parsed = parseResponse(message);
  if (parsed === null) {
    throw new Error(`Received unparseable response to ${type}`);
  }
  return parsed;
}

/**
 * Block until a response arrives for the given request_id. Returns null on
 * timeout. Mostly useful when you have an externally-produced request_id.
 */
export async function waitForResponse(
  requestId: string,
  timeoutMs = 5_000,
): Promise<ResponseEnvelope | null> {
  const message = await redisSubscribeOnce(
    socketConfig(),
    RESPONSES_CHANNEL,
    (raw) => {
      const parsed = parseResponse(raw);
      return parsed !== null && parsed.request_id === requestId;
    },
    timeoutMs,
  );
  return message === null ? null : parseResponse(message);
}

/** Online player count as published by the plugin, or null if unset. */
export async function getOnlinePlayerCount(): Promise<number | null> {
  const raw = await redisCommand(socketConfig(), ['GET', ONLINE_COUNT_KEY]);
  if (raw === null || typeof raw !== 'string') return null;
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
  await redisCommand(socketConfig(), [
    'SET',
    `${LINK_CODE_PREFIX}${code}`,
    JSON.stringify(record),
    'EX',
    ttlSeconds,
  ]);
  return code;
}

/**
 * Look up and consume (single-use delete) a link code. Returns the stored
 * record, or null if the code was not found / already consumed / expired.
 */
export async function consumeLinkCode(code: string): Promise<LinkCodeRecord | null> {
  const key = `${LINK_CODE_PREFIX}${code.toUpperCase()}`;
  const raw = await redisCommand(socketConfig(), ['GET', key]);
  if (raw === null || typeof raw !== 'string') return null;
  // Delete immediately so the code is single-use.
  await redisCommand(socketConfig(), ['DEL', key]);
  try {
    return JSON.parse(raw) as LinkCodeRecord;
  } catch {
    return null;
  }
}

/**
 * Look up and consume (single-use delete) an in-game website-login code.
 * The plugin stores the record as JSON `{uuid, username, createdAt}` under
 * `ImperiumMC:login_code:<CODE>` with a 900s (15min) TTL. Returns null if the
 * code was not found, already used, or expired.
 */
export async function consumeLoginCode(
  code: string,
): Promise<{ uuid: string; username?: string } | null> {
  const key = `${LOGIN_CODE_PREFIX}${code.trim()}`;
  const raw = await redisCommand(socketConfig(), ['GET', key]);
  if (raw === null || typeof raw !== 'string') return null;
  await redisCommand(socketConfig(), ['DEL', key]);
  try {
    const parsed = JSON.parse(raw) as { uuid?: string; username?: string };
    if (!parsed.uuid) return null;
    return { uuid: parsed.uuid, username: parsed.username };
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
