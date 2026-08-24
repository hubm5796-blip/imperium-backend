/**
 * MINIMAL MYSQL WIRE CLIENT (2026-08-24) — the workerd-safe game-MySQL reader.
 *
 * mysql2 cannot run in deployed Workers: its row parsers are built at runtime by
 * `generate-function` via `new Function` ("Code generation from strings disallowed"),
 * and workerd has no eval escape flag anymore (unsafe_eval was removed). This client
 * speaks just enough of the MySQL/MariaDB wire protocol for the backend's read-only
 * game queries:
 *
 *   - Handshake v10 → HandshakeResponse41 with mysql_native_password (MariaDB's
 *     default; the AuthSwitchRequest re-scramble path is handled too).
 *   - COM_QUERY text protocol with `?` placeholders inlined via a strict escaper
 *     (numbers verbatim, strings backslash+quote-escaped, null literal, everything
 *     else stringified then escaped — fail closed on unexpected types).
 *   - Resultset decode: column definitions (length-encoded strings), rows as
 *     length-encoded UTF-8 strings / NULL. Values come back as strings exactly like
 *     mysql2's default; callers already Number()-parse where needed.
 *
 * Scope walls (deliberate): no TLS (birdflop 3306 is plaintext from this network,
 * same trust as the plugin's own connection), no multi-statement, no packets over
 * 16MB, no LOCAL INFILE, write statements are not blocked (operator discipline —
 * every caller in this repo is a SELECT).
 */

import { logger } from '../utils/logger.js';

export interface WireConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

// ── framing ────────────────────────────────────────────────────────────────────

class WireStream {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private buf = new Uint8Array(0);
  constructor(socket: { readable: ReadableStream<Uint8Array> }) {
    this.reader = socket.readable.getReader();
  }
  private async fill(): Promise<boolean> {
    const { done, value } = await this.reader.read();
    if (done || !value) return false;
    const merged = new Uint8Array(this.buf.length + value.length);
    merged.set(this.buf);
    merged.set(value, this.buf.length);
    this.buf = merged;
    return true;
  }
  async readBytes(n: number): Promise<Uint8Array> {
    while (this.buf.length < n) {
      if (!(await this.fill())) throw new Error('mysql-wire: socket closed mid-packet');
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.slice(n);
    return out;
  }
}

interface Packet {
  sequence: number;
  payload: Uint8Array;
}

async function readPacket(s: WireStream): Promise<Packet> {
  const header = await s.readBytes(4);
  const len = header[0] | (header[1] << 8) | (header[2] << 16);
  const sequence = header[3];
  return { sequence, payload: await s.readBytes(len) };
}

async function writePacket(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  payload: Uint8Array,
  sequence: number,
): Promise<void> {
  const frame = new Uint8Array(4 + payload.length);
  frame[0] = payload.length & 0xff;
  frame[1] = (payload.length >> 8) & 0xff;
  frame[2] = (payload.length >> 16) & 0xff;
  frame[3] = sequence;
  frame.set(payload, 4);
  await writer.write(frame);
}

// ── length-encoded primitives ─────────────────────────────────────────────────

function readLenenc(p: Uint8Array, off: { i: number }): bigint | number | null {
  const first = p[off.i++];
  if (first === 0xfb) return null; // NULL column
  if (first < 0xfb) return first;
  if (first === 0xfc) { const v = p[off.i] | (p[off.i + 1] << 8); off.i += 2; return v; }
  if (first === 0xfd) {
    const v = p[off.i] | (p[off.i + 1] << 8) | (p[off.i + 2] << 16); off.i += 3; return v;
  }
  let v = 0n;
  for (let k = 7; k >= 0; k--) v = (v << 8n) | BigInt(p[off.i + k]);
  off.i += 8;
  return v;
}

function readLenencString(p: Uint8Array, off: { i: number }): string | null {
  const len = readLenenc(p, off);
  if (len === null) return null;
  const n = Number(len);
  const s = new TextDecoder().decode(p.subarray(off.i, off.i + n));
  off.i += n;
  return s;
}

// ── auth (mysql_native_password) ──────────────────────────────────────────────

async function sha1(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-1', data as unknown as ArrayBuffer);
  return new Uint8Array(digest);
}

function xorBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

async function nativeScramble(password: string, seed: Uint8Array): Promise<Uint8Array> {
  const pwd = new TextEncoder().encode(password);
  if (pwd.length === 0) return new Uint8Array(0);
  const stage1 = await sha1(pwd);
  const stage2 = await sha1(stage1);
  const seedPlus = new Uint8Array(seed.length + stage2.length);
  seedPlus.set(seed);
  seedPlus.set(stage2, seed.length);
  const stage3 = await sha1(seedPlus);
  return xorBytes(stage1, stage3);
}

// ── escaping / placeholders ────────────────────────────────────────────────────

function escapeValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'string') {
    return `'${v.replace(/\\/g, '\\\\').replace(/\0/g, '\\0').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;
  }
  // Unknown types never interpolate raw — stringify through the escaper.
  return escapeValue(String(v));
}

function applyPlaceholders(sql: string, params: readonly unknown[]): string {
  if (params.length === 0) return sql;
  let out = '';
  let param = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === '?' && param < params.length) {
      out += escapeValue(params[param++]);
    } else {
      out += ch;
    }
  }
  if (param !== params.length) {
    throw new Error(`mysql-wire: ${params.length} params, only ${param} placeholders`);
  }
  return out;
}

// ── connection ─────────────────────────────────────────────────────────────────

interface Handshake {
  seed: Uint8Array;
  plugin: string;
}

function parseHandshake(payload: Uint8Array): Handshake {
  const off = { i: 1 }; // skip protocol version (10)
  const readNullString = (): string => {
    const end = payload.indexOf(0, off.i);
    const s = new TextDecoder().decode(payload.subarray(off.i, end));
    off.i = end + 1;
    return s;
  };
  readNullString(); // server version
  off.i += 4; // thread id
  const seed1 = payload.subarray(off.i, off.i + 8);
  off.i += 8 + 1; // seed part 1 + filler
  off.i += 2; // capability lower
  off.i += 1; // charset
  off.i += 2; // status flags
  off.i += 2; // capability upper
  const authLen = payload[off.i]; off.i += 1;
  off.i += 10; // reserved
  const seed2Len = Math.max(13, authLen - 8);
  const seed2 = payload.subarray(off.i, off.i + seed2Len - 1); // trailing NUL excluded
  off.i += seed2Len;
  // Some servers pad; plugin name is the next NUL-terminated string when present.
  let plugin = 'mysql_native_password';
  if (off.i < payload.length) {
    const p = readNullString();
    if (p) plugin = p;
  }
  const seed = new Uint8Array(seed1.length + seed2.length);
  seed.set(seed1);
  seed.set(seed2, seed1.length);
  return { seed: seed.subarray(0, 20), plugin };
}

async function sendHandshakeResponse(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  handshake: Handshake,
  config: WireConfig,
  authResponse: Uint8Array,
  sequence: number,
): Promise<void> {
  const CLIENT_LONG_PASSWORD = 1;
  const CLIENT_FOUND_ROWS = 2;
  const CLIENT_CONNECT_WITH_DB = 8;
  const CLIENT_PROTOCOL_41 = 0x200;
  const CLIENT_TRANSACTIONS = 0x2000;
  const CLIENT_SECURE_CONNECTION = 0x8000;
  const CLIENT_PLUGIN_AUTH = 1 << 19;
  const caps =
    CLIENT_LONG_PASSWORD | CLIENT_FOUND_ROWS | CLIENT_CONNECT_WITH_DB |
    CLIENT_PROTOCOL_41 | CLIENT_TRANSACTIONS | CLIENT_SECURE_CONNECTION | CLIENT_PLUGIN_AUTH;
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const capBuf = Buffer.alloc(4); capBuf.writeUInt32LE(caps);
  parts.push(capBuf);
  const maxBuf = Buffer.alloc(4); maxBuf.writeUInt32LE(1 << 24);
  parts.push(maxBuf);
  parts.push(new Uint8Array([33])); // utf8_general_ci
  parts.push(new Uint8Array(23));
  parts.push(enc.encode(config.user + '\0'));
  parts.push(new Uint8Array([authResponse.length]));
  parts.push(authResponse);
  parts.push(enc.encode(config.database + '\0'));
  parts.push(enc.encode((handshake.plugin || 'mysql_native_password') + '\0'));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const payload = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { payload.set(p, o); o += p.length; }
  await writePacket(writer, payload, sequence);
}

function isEof(p: Uint8Array): boolean {
  return p.length > 0 && p[0] === 0xfe && p.length < 9;
}
function isErr(p: Uint8Array): boolean {
  return p.length > 0 && p[0] === 0xff;
}
function errText(p: Uint8Array): string {
  const off = { i: 3 }; // skip 0xFF + error code(2)
  const sqlStateMarker = p[off.i];
  if (sqlStateMarker === 0x23) off.i += 6; // '#'+5 chars state
  return new TextDecoder().decode(p.subarray(off.i));
}

// ── public API ─────────────────────────────────────────────────────────────────

export async function wireQuery<T extends Record<string, unknown>>(
  sql: string,
  params: readonly unknown[],
  config: WireConfig,
  connect: (address: { hostname: string; port: number }, options?: { secureTransport?: 'off' | 'starttls' | 'on' }) => Promise<{ readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>; opened?: Promise<unknown> }>,
): Promise<T[]> {
  const socket = await connect({ hostname: config.host, port: config.port }, { secureTransport: 'off' });
  if (socket.opened) await socket.opened;
  const stream = new WireStream(socket);
  const writer = socket.writable.getWriter();
  try {
    let packet = await readPacket(stream);
    if (isErr(packet.payload)) throw new Error('mysql-wire handshake ERR: ' + errText(packet.payload));
    let handshake = parseHandshake(packet.payload);
    let auth = await nativeScramble(config.password, handshake.seed);
    let seq = packet.sequence + 1;
    await sendHandshakeResponse(writer, handshake, config, auth, seq);
    packet = await readPacket(stream);
    // AuthSwitchRequest → re-scramble with the fresh seed, once.
    if (packet.payload.length > 0 && packet.payload[0] === 0xfe && !isEof(packet.payload)) {
      const off = { i: 1 };
      const plugin = readLenencString(packet.payload, off) ?? 'mysql_native_password';
      const seed = packet.payload.subarray(off.i, off.i + 20);
      if (!plugin.includes('native_password')) {
        throw new Error(`mysql-wire: server demands auth plugin '${plugin}' (only mysql_native_password supported)`);
      }
      auth = await nativeScramble(config.password, seed);
      await writePacket(writer, auth, packet.sequence + 1);
      packet = await readPacket(stream);
      handshake = { ...handshake, plugin };
    }
    if (isErr(packet.payload)) throw new Error('mysql-wire auth ERR: ' + errText(packet.payload));
    if (packet.payload[0] !== 0x00) throw new Error('mysql-wire: unexpected post-auth packet 0x' + packet.payload[0].toString(16));

    // COM_QUERY
    const enc = new TextEncoder();
    const query = new Uint8Array(1 + enc.encode(applyPlaceholders(sql, params)).length);
    query[0] = 0x03;
    query.set(enc.encode(applyPlaceholders(sql, params)), 1);
    await writePacket(writer, query, 0);
    packet = await readPacket(stream);
    if (isErr(packet.payload)) throw new Error('mysql-wire query ERR: ' + errText(packet.payload));

    // Column count (length-encoded).
    const colOff = { i: 0 };
    const columnCount = Number(readLenenc(packet.payload, colOff) ?? 0);
    if (columnCount === 0) throw new Error('mysql-wire: no columns');

    const columns: string[] = [];
    for (let c = 0; c < columnCount; c++) {
      const def = await readPacket(stream);
      const off = { i: 0 };
      readLenencString(def.payload, off); // catalog
      readLenencString(def.payload, off); // schema
      readLenencString(def.payload, off); // table
      readLenencString(def.payload, off); // org_table
      columns.push(readLenencString(def.payload, off) ?? `c${c}`);
    }
    // EOF after column definitions (classic) — OK packet (CLIENT_DEPRECATE_EOF) not requested.
    const afterCols = await readPacket(stream);
    if (isErr(afterCols.payload)) throw new Error('mysql-wire cols ERR: ' + errText(afterCols.payload));

    const rows: T[] = [];
    for (;;) {
      const row = await readPacket(stream);
      if (isEof(row.payload) || isErr(row.payload)) break;
      const off = { i: 0 };
      const record: Record<string, unknown> = {};
      for (let c = 0; c < columnCount; c++) {
        record[columns[c]] = readLenencString(row.payload, off);
      }
      rows.push(record as T);
      if (rows.length >= 200) break; // hard read cap — politeness, callers LIMIT anyway
    }
    return rows;
  } finally {
    try { await writer.close(); } catch { /* socket already gone */ }
    logger.debug('mysql-wire: query complete');
  }
}
