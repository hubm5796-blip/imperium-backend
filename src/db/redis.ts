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
/**
 * Redis key prefix for one-time OAuth session handoff codes. After the backend
 * completes Discord OAuth it stores the resolved Discord identity here under a
 * random code, then redirects the browser to the frontend with that code; the
 * frontend exchanges it (POST /api/auth/exchange) for its own session cookie.
 * Short TTL (60s) + single-use (GET+DEL) — see createSessionCode/consumeSessionCode.
 */
export const SESSION_CODE_PREFIX = 'ImperiumMC:session:';
/**
 * Redis key prefix for short-TTL response caches on hot, read-heavy backend
 * routes (currently /api/player/profile). Postgres compute-hours are the
 * tighter free-tier constraint than Upstash's request count, so caching a
 * repeated identical read here for a few seconds trades a cheap Redis GET for
 * an entire Postgres round trip on every cache hit.
 */
export const RESPONSE_CACHE_PREFIX = 'ImperiumMC:cache:';

/**
 * A hung `cloudflare:sockets` connection (no response ever, not even an
 * error) doesn't throw — it just never resolves. try/catch alone doesn't
 * protect against that, and Cloudflare's own platform watchdog killing the
 * whole invocation is a much worse failure mode than "this cache call gave
 * up quickly." Every response-cache call is raced against this so a stuck
 * Redis connection can never hang a real user-facing request — this is
 * exactly what caused a live incident: concurrent dashboard requests (the
 * same page fires 3 of these in parallel) sent enough simultaneous Redis
 * connections that some hung indefinitely with no timeout, and the whole
 * request died instead of falling through to Postgres as designed.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

const CACHE_CALL_TIMEOUT_MS = 1_200;

/**
 * Read a small JSON value from the response cache. Never throws, never hangs
 * — a cache miss, a cache failure, and a cache timeout all look identical to
 * the caller (all mean "go do the real read"), which is exactly the
 * fail-open behavior wanted here.
 */
export async function getCachedJson<T>(key: string): Promise<T | null> {
  return withTimeout(
    (async () => {
      try {
        const raw = await redisCommand(socketConfig(), ['GET', `${RESPONSE_CACHE_PREFIX}${key}`]);
        if (raw === null || typeof raw !== 'string') return null;
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    })(),
    CACHE_CALL_TIMEOUT_MS,
    null,
  );
}

/** Best-effort cache invalidation — failures/hangs are logged, never thrown or blocking. */
export async function deleteCachedJson(key: string): Promise<void> {
  await withTimeout(
    redisCommand(socketConfig(), ['DEL', `${RESPONSE_CACHE_PREFIX}${key}`]).catch((err: unknown) => {
      logger.warn({ err, key }, 'Response cache delete failed — non-fatal');
    }),
    CACHE_CALL_TIMEOUT_MS,
    undefined,
  );
}

/** Best-effort write to the response cache — failures/hangs are logged, never thrown or blocking. */
export async function setCachedJson(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  await withTimeout(
    redisCommand(socketConfig(), [
      'SETEX',
      `${RESPONSE_CACHE_PREFIX}${key}`,
      String(ttlSeconds),
      JSON.stringify(value),
    ]).then(
      () => undefined,
      (err: unknown) => {
        logger.warn({ err, key }, 'Response cache write failed — non-fatal');
      },
    ),
    CACHE_CALL_TIMEOUT_MS,
    undefined,
  );
}

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

/**
 * The Discord identity the backend resolves during OAuth, handed off to the
 * frontend via a one-time session code so the frontend can sign its own cookie
 * without ever seeing the Discord client secret.
 */
export interface SessionHandoff {
  discordId: string;
  discordUsername: string | null;
  /** Discord avatar hash (not a URL) — the frontend renders it via discordAvatarUrl(). */
  discordAvatar: string | null;
}

/**
 * Store a Discord identity under a fresh one-time code (TTL 60s) and return the
 * code. The browser is redirected to the frontend with this code; the frontend
 * then consumes it via consumeSessionCode (called by POST /api/auth/exchange).
 */
export async function createSessionCode(
  payload: SessionHandoff,
  ttlSeconds = 60,
): Promise<string> {
  const code = nanoid(24);
  const key = `${SESSION_CODE_PREFIX}${code}`;
  await redisCommand(socketConfig(), [
    'SET',
    key,
    JSON.stringify({ ...payload, createdAt: Date.now() }),
    'EX',
    ttlSeconds,
  ]);
  return code;
}

/**
 * Consume (single-use GET+DEL) a session handoff code. Returns the stored
 * Discord identity, or null if the code was missing/expired/already consumed.
 */
export async function consumeSessionCode(code: string): Promise<SessionHandoff | null> {
  const key = `${SESSION_CODE_PREFIX}${code.trim()}`;
  const raw = await redisCommand(socketConfig(), ['GET', key]);
  if (raw === null || typeof raw !== 'string') return null;
  await redisCommand(socketConfig(), ['DEL', key]);
  try {
    const parsed = JSON.parse(raw) as Partial<SessionHandoff>;
    if (!parsed.discordId) return null;
    return {
      discordId: parsed.discordId,
      discordUsername: parsed.discordUsername ?? null,
      discordAvatar: parsed.discordAvatar ?? null,
    };
  } catch {
    return null;
  }
}
