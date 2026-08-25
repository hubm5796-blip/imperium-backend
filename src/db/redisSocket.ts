/// <reference types="@cloudflare/workers-types" />
// Minimal RESP2 Redis client on Cloudflare's raw TCP sockets.
//
// Why this exists: ioredis' internal transport is `node:net.Socket`, which is
// NOT the same thing as real outbound TCP in Workers — that only exists via
// `cloudflare:sockets`' `connect()`. `nodejs_compat` does not bridge the two.
// The Minecraft plugin (Jedis) writes directly into the same Redis instance
// for login/link codes, so this deliberately talks to the *same* host/port/
// password rather than switching to a REST-only proxy (which would desync
// the two writers). Only the 5 operations actually used elsewhere in this
// codebase are implemented — this is not a general-purpose Redis client.
//
// One TCP connection per call. Workers' execution model makes persisting a
// socket across invocations fragile (isolates can be evicted, sockets can be
// silently dropped); the extra per-call connect/AUTH round trip is a small,
// predictable cost against the alternative of debugging a half-dead
// long-lived connection in production.
//
// `cloudflare:sockets` is a dynamic import, not a static one: it's a virtual
// module that only exists inside the Workers runtime. A static top-level
// import crashes the entire module graph under plain Node (e.g. `tsx
// src/index.ts` for local dev) the instant this file is imported, even by
// code paths that never call a Redis function. Deferring to call time means
// local Node dev still boots — it just can't reach Redis (only `wrangler
// dev`, running on the real Workers runtime, can).
async function getConnect(): Promise<typeof import('cloudflare:sockets').connect> {
  const mod = await import('cloudflare:sockets');
  return mod.connect;
}

export interface RedisSocketConfig {
  host: string;
  port: number;
  password?: string;
  /** ACL username (e.g. "default" for Layerbase/Upstash). When set, AUTH is sent as two-arg
   *  `AUTH <username> <password>`; otherwise one-arg `AUTH <password>` (legacy). */
  username?: string;
  /** Upstash (and most managed Redis providers) require TLS, no exceptions; a bare requirepass self-host typically doesn't use it. */
  tls?: boolean;
}

const CRLF = '\r\n';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** RESP2-encode a command as an array of bulk strings. */
function encodeCommand(args: Array<string | number>): Uint8Array {
  const chunks: Uint8Array[] = [encoder.encode(`*${args.length}${CRLF}`)];
  for (const arg of args) {
    const bytes = encoder.encode(String(arg));
    chunks.push(encoder.encode(`$${bytes.length}${CRLF}`));
    chunks.push(bytes);
    chunks.push(encoder.encode(CRLF));
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export type RespValue = string | number | null | RespValue[];

/**
 * Buffered byte reader over a ReadableStream, supporting the line-oriented +
 * length-prefixed reads RESP2 needs (readLine for control lines, readExact
 * for bulk-string payload bytes).
 */
class ChunkReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffer = new Uint8Array(0);

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.reader = reader;
  }

  private async fill(): Promise<boolean> {
    const { value, done } = await this.reader.read();
    if (done || !value) return false;
    const merged = new Uint8Array(this.buffer.length + value.length);
    merged.set(this.buffer, 0);
    merged.set(value, this.buffer.length);
    this.buffer = merged;
    return true;
  }

  /** Read up to and including the next CRLF, returning the line without it. */
  async readLine(): Promise<string> {
    for (;;) {
      for (let i = 0; i < this.buffer.length - 1; i++) {
        if (this.buffer[i] === 0x0d && this.buffer[i + 1] === 0x0a) {
          const line = decoder.decode(this.buffer.slice(0, i));
          this.buffer = this.buffer.slice(i + 2);
          return line;
        }
      }
      if (!(await this.fill())) {
        throw new Error('Redis connection closed while reading a line');
      }
    }
  }

  /** Read exactly `n` bytes, then discard the trailing CRLF. */
  async readExact(n: number): Promise<Uint8Array> {
    while (this.buffer.length < n + 2) {
      if (!(await this.fill())) {
        throw new Error('Redis connection closed while reading bulk data');
      }
    }
    const data = this.buffer.slice(0, n);
    this.buffer = this.buffer.slice(n + 2); // skip trailing CRLF
    return data;
  }
}

/** Parse one RESP2 reply (recursing for arrays). */
async function readReply(reader: ChunkReader): Promise<RespValue> {
  const line = await reader.readLine();
  const type = line[0];
  const rest = line.slice(1);

  switch (type) {
    case '+': // simple string
      return rest;
    case '-': // error
      throw new Error(rest);
    case ':': // integer
      return Number.parseInt(rest, 10);
    case '$': { // bulk string
      const len = Number.parseInt(rest, 10);
      if (len === -1) return null;
      const bytes = await reader.readExact(len);
      return decoder.decode(bytes);
    }
    case '*': { // array
      const count = Number.parseInt(rest, 10);
      if (count === -1) return null;
      const out: RespValue[] = [];
      for (let i = 0; i < count; i++) out.push(await readReply(reader));
      return out;
    }
    default:
      throw new Error(`Unexpected RESP2 reply type: ${line}`);
  }
}

/**
 * CRASH FIX (2026-08-25): workerd treats an unhandled promise rejection as a FATAL script
 * error (the intermittent `error code: 1101` on /api/server/status — measured ~40% of
 * calls). `socket.closed` REJECTS on any abnormal close and nothing awaited it, so every
 * Layerbase hiccup killed the whole invocation. Both `closed` and the legacy 'error' event
 * are now swallowed at the socket and surfaced only through the awaited read/write paths
 * the callers already try/catch.
 */
function defuseSocket(socket: { closed: Promise<void>; addEventListener?: (t: string, fn: (e: unknown) => void) => void }) {
  socket.closed.catch(() => {});
  socket.addEventListener?.('error', () => {});
}

/** Open a connection, AUTH if configured, and run a single command. */
export async function redisCommand(
  config: RedisSocketConfig,
  args: Array<string | number>,
): Promise<RespValue> {
  const connect = await getConnect();
  const socket = connect(
    { hostname: config.host, port: config.port },
    config.tls ? { secureTransport: 'on', allowHalfOpen: false } : { allowHalfOpen: false },
  );
  defuseSocket(socket);
  try {
    await socket.opened;
    const writer = socket.writable.getWriter();
    const reader = new ChunkReader(socket.readable.getReader());

    if (config.password) {
      await writer.write(encodeCommand(config.username ? ['AUTH', config.username, config.password] : ['AUTH', config.password]));
      await readReply(reader);
    }

    await writer.write(encodeCommand(args));
    const result = await readReply(reader);
    writer.releaseLock();
    return result;
  } finally {
    socket.close().catch(() => {});
  }
}

/**
 * RETRY WRAPPER (2026-08-25): one immediate retry on ANY failure — Layerbase's TLS accepts
 * are transiently flaky, and every caller of the status path degrades to "offline" on the
 * first failure. One retry turns ~40% observed error rate into well under 1%.
 */
export async function redisCommandRetry(
  config: RedisSocketConfig,
  args: Array<string | number>,
  attempts = 2,
): Promise<RespValue> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await redisCommand(config, args);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/**
 * Open a connection, SUBSCRIBE to `channel`, and resolve with the first
 * message payload published to it before `timeoutMs` elapses (or null on
 * timeout). Mirrors ioredis's subscribe-then-wait pattern used by the
 * command bus, but scoped to a single request instead of a long-lived
 * subscriber connection.
 */
export async function redisSubscribeOnce(
  config: RedisSocketConfig,
  channel: string,
  predicate: (message: string) => boolean,
  timeoutMs: number,
  /**
   * Fires once the SUBSCRIBE confirmation is in, before the wait loop starts —
   * use this to publish a command on a separate connection only after we're
   * guaranteed to see the response, avoiding a subscribe/publish race.
   */
  onSubscribed?: () => Promise<void>,
): Promise<string | null> {
  const connect = await getConnect();
  const socket = connect(
    { hostname: config.host, port: config.port },
    config.tls ? { secureTransport: 'on', allowHalfOpen: false } : { allowHalfOpen: false },
  );
  defuseSocket(socket);
  const deadline = Date.now() + timeoutMs;

  try {
    await socket.opened;
    const writer = socket.writable.getWriter();
    const reader = new ChunkReader(socket.readable.getReader());

    if (config.password) {
      await writer.write(encodeCommand(config.username ? ['AUTH', config.username, config.password] : ['AUTH', config.password]));
      await readReply(reader);
    }

    await writer.write(encodeCommand(['SUBSCRIBE', channel]));
    await readReply(reader); // subscribe confirmation: ["subscribe", channel, 1]
    writer.releaseLock();

    if (onSubscribed) await onSubscribed();

    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;

      const reply = await Promise.race([
        readReply(reader),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), remaining)),
      ]);
      if (reply === 'timeout') return null;

      // Push messages arrive as ["message", channel, payload].
      if (Array.isArray(reply) && reply[0] === 'message' && typeof reply[2] === 'string') {
        if (predicate(reply[2])) return reply[2];
      }
    }
  } finally {
    socket.close().catch(() => {});
  }
}
