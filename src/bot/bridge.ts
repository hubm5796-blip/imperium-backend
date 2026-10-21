/**
 * V6 02-08 — Bridge Chat v2 (ported into the backend worker; the standalone
 * discord repo's copy never deployed).
 *
 * Wire contract: POST /bridge/send, Bearer BRIDGE_SECRET.
 * v1 (unchanged): { player, rank?, message }
 * v2 envelope: { v: 2, event: BridgeEvent }
 *
 * Routing: chat + system → the chat webhook with the PLAYER's identity
 * (webhook username + mc-heads avatar — one webhook, per-message identity);
 * everything else (death/rankup/prestige/trade/boss/lottery) → the events
 * webhook as embeds. Events bypass the per-player chat rate (server-driven)
 * but carry a global 30/min ceiling — a dropped event embed is acceptable,
 * chat stays the lossless path. Webhook health self-heals: 3 consecutive
 * 4xx (except 429) disables posting for 5 minutes, loudly.
 */
import { Hono, type MiddlewareHandler } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';
import { logger } from '../utils/logger.js';
import type { AppContextVariables } from '../types/index.js';
type ApiEnv = { Variables: AppContextVariables };
export type BridgeEvent =
 | { kind: 'chat'; player: string; rank?: string; message: string; uuid?: string }
 | { kind: 'death'; player: string; cause: string; killer?: string; streakLost?: number }
 | { kind: 'rankup'; player: string; fromRank: number; toRank: number }
 | { kind: 'prestige'; player: string; prestigeLevel: number }
 | { kind: 'trade'; seller: string; buyer: string; item: string; price: number }
 | { kind: 'boss'; boss: string; killedBy: string[]; durationSeconds: number }
 | { kind: 'lottery'; winner: string; amount: number }
 | { kind: 'system'; message: string };
export interface BridgeSendV2 {
 v: 2;
 event: BridgeEvent;
}
const EVENT_EMBED_COLORS: Record<string, number> = {
 death: 0x8b0000,
 rankup: 0xd4af37,
 prestige: 0x9b59b6,
 trade: 0x2ecc71,
 boss: 0xc0392b,
 lottery: 0xf1c40f,
};
function eventEmbedText(e: Extract<BridgeEvent, { kind: 'death' | 'rankup' | 'prestige' | 'trade' | 'boss' | 'lottery' }>): string {
 switch (e.kind) {
 case 'death':
 return ` **${e.player}** died${e.killer ? ` to **${e.killer}**` : ''} — ${e.cause}${e.streakLost ? ` (lost a ${e.streakLost}-streak)` : ''}`;
 case 'rankup':
 return ` **${e.player}** ranked up to rank ${e.toRank}`;
 case 'prestige':
 return ` **${e.player}** reached prestige ${e.prestigeLevel}`;
 case 'trade':
 return ` **${e.buyer}** bought ${e.item} from **${e.seller}**`;
 case 'boss':
 return ` **${e.boss}** defeated in ${Math.round(e.durationSeconds / 60)}min by ${e.killedBy.slice(0, 8).join(', ')}`;
 case 'lottery':
 return ` **${e.winner}** won the lottery`;
 }
}
// ── webhook state + health ──────────────────────────────────────────────────
interface WebhookHealth {
 lastErrorAt: number;
 consecutiveFailures: number;
 disabledUntil: number;
}
const health = { chat: { lastErrorAt: 0, consecutiveFailures: 0, disabledUntil: 0 } };
const EVENT_WINDOW_MS = 60_000;
const EVENT_CEILING = 30;
let eventTimestamps: number[] = [];
function bridgeEnabled(): boolean {
 return Boolean(env.bridgeSecret && env.bridgeWebhookUrl);
}
async function postWebhook(url: string, body: Record<string, unknown>, h: WebhookHealth, label: string): Promise<boolean> {
 if (Date.now() < h.disabledUntil) return false;
 try {
 const res = await fetch(url, {
 method: 'POST',
 headers: { 'Content-Type': 'application/json' },
 body: JSON.stringify({ allowed_mentions: { parse: [] }, ...body }),
 signal: AbortSignal.timeout(8_000),
 });
 if (res.ok || res.status === 429) {
 // 429 is backpressure, not breakage — reset the failure streak but keep going.
 h.consecutiveFailures = 0;
 return res.ok;
 }
 h.consecutiveFailures++;
 h.lastErrorAt = Date.now();
 if (res.status >= 400 && res.status < 500 && h.consecutiveFailures >= 3) {
 h.disabledUntil = Date.now() + 5 * 60_000;
 logger.error({ status: res.status }, `bridge: ${label} webhook failing (4xx x3) — posting disabled 5min (deleted webhook?)`);
 }
 return false;
 } catch {
 h.consecutiveFailures++;
 return false;
 }
}
/** Webhook username rules: no 'discord'/'clyde'/'@', max 80 chars. */
function safeUsername(name: string): string {
 let n = name.replace(/discord|clyde|@/gi, '').trim();
 if (!n) n = 'player';
 return n.slice(0, 80);
}
async function sendChat(e: Extract<BridgeEvent, { kind: 'chat' | 'system' }>): Promise<boolean> {
 if (e.kind === 'chat') {
 return postWebhook(env.bridgeWebhookUrl!, {
 username: safeUsername(e.rank ? `${e.player} [${e.rank}]` : e.player),
 avatar_url: `https://mc-heads.net/avatar/${e.uuid || e.player}/64`,
 content: e.message.slice(0, 1900),
 }, health.chat, 'chat');
 }
 return postWebhook(env.bridgeWebhookUrl!, {
 username: 'Romanica',
 content: e.message.slice(0, 1900),
 }, health.chat, 'chat');
}
async function sendEvent(e: BridgeEvent): Promise<boolean> {
 if (e.kind === 'chat' || e.kind === 'system') return sendChat(e);
 if (!env.bridgeEventsWebhookUrl) return false;
 // Global event ceiling: 30/min (drop silently — chat is the lossless path).
 const now = Date.now();
 eventTimestamps = eventTimestamps.filter((t) => now - t < EVENT_WINDOW_MS);
 if (eventTimestamps.length >= EVENT_CEILING) return false;
 eventTimestamps.push(now);
 return postWebhook(env.bridgeEventsWebhookUrl, {
 username: 'Romanica Events',
 embeds: [
 {
 color: EVENT_EMBED_COLORS[e.kind] ?? 0xd4af37,
 description: eventEmbedText(e),
 },
 ],
 }, { lastErrorAt: 0, consecutiveFailures: 0, disabledUntil: 0 }, 'events');
}
/** v1 body OR v2 envelope → a typed event (v1 maps to chat). */
export function parseBridgeBody(body: Record<string, unknown>): BridgeEvent | null {
 if (body.v === 2 && body.event && typeof body.event === 'object') {
 return validateBridgeEvent(body.event as Record<string, unknown>);
 }
 if (typeof body.player === 'string' && typeof body.message === 'string') {
 return validateBridgeEvent({
 kind: 'chat',
 player: body.player,
 rank: typeof body.rank === 'string' ? body.rank : undefined,
 uuid: typeof body.uuid === 'string' ? body.uuid : undefined,
 message: body.message,
 });
 }
 return null;
}
/* ── B-23 per-kind envelope validation ──────────────────────────────────────
 * The v2 envelope used to accept ANY object with a string `kind` — the rest
 * of the shape was trusted, so a malformed/hostile event flowed straight
 * into embed text and webhook usernames. Every kind now declares its exact
 * required fields, types, and length bounds; anything else is a 400, not a
 * best-effort render. */
function str(v: unknown, max: number): string | null {
 if (typeof v !== 'string') return null;
 const t = v.trim();
 if (!t || t.length > max) return null;
 return t;
}
function num(v: unknown): number | null {
 return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function strArr(v: unknown, maxItems: number): string[] | null {
 if (!Array.isArray(v) || v.length === 0 || v.length > maxItems) return null;
 const out: string[] = [];
 for (const x of v) {
 if (typeof x !== 'string') return null;
 const t = x.trim().slice(0, 80);
 if (!t) return null;
 out.push(t);
 }
 return out;
}
/** Validate a v2 event object against the BridgeEvent union. null = reject. */
export function validateBridgeEvent(e: Record<string, unknown>): BridgeEvent | null {
 switch (e.kind) {
 case 'chat': {
 const player = str(e.player, 80);
 const message = str(e.message, 1900);
 if (!player || !message) return null;
 let rank: string | undefined;
 if (e.rank !== undefined) {
 const r = str(e.rank, 40);
 if (!r) return null;
 rank = r;
 }
 let uuid: string | undefined;
 if (e.uuid !== undefined) {
 const u = str(e.uuid, 64);
 if (!u) return null;
 uuid = u;
 }
 return { kind: 'chat', player, rank, uuid, message };
 }
 case 'death': {
 const player = str(e.player, 80);
 const cause = str(e.cause, 200);
 if (!player || !cause) return null;
 let killer: string | undefined;
 if (e.killer !== undefined) {
 const k = str(e.killer, 80);
 if (!k) return null;
 killer = k;
 }
 let streakLost: number | undefined;
 if (e.streakLost !== undefined) {
 const s = num(e.streakLost);
 if (s === null) return null;
 streakLost = s;
 }
 return { kind: 'death', player, cause, killer, streakLost };
 }
 case 'rankup': {
 const player = str(e.player, 80);
 const fromRank = num(e.fromRank);
 const toRank = num(e.toRank);
 if (!player || fromRank === null || toRank === null) return null;
 return { kind: 'rankup', player, fromRank, toRank };
 }
 case 'prestige': {
 const player = str(e.player, 80);
 const prestigeLevel = num(e.prestigeLevel);
 if (!player || prestigeLevel === null) return null;
 return { kind: 'prestige', player, prestigeLevel };
 }
 case 'trade': {
 const seller = str(e.seller, 80);
 const buyer = str(e.buyer, 80);
 const item = str(e.item, 120);
 const price = num(e.price);
 if (!seller || !buyer || !item || price === null) return null;
 return { kind: 'trade', seller, buyer, item, price };
 }
 case 'boss': {
 const boss = str(e.boss, 120);
 const killedBy = strArr(e.killedBy, 25);
 const durationSeconds = num(e.durationSeconds);
 if (!boss || !killedBy || durationSeconds === null) return null;
 return { kind: 'boss', boss, killedBy, durationSeconds };
 }
 case 'lottery': {
 const winner = str(e.winner, 80);
 const amount = num(e.amount);
 if (!winner || amount === null) return null;
 return { kind: 'lottery', winner, amount };
 }
 case 'system': {
 const message = str(e.message, 1900);
 if (!message) return null;
 return { kind: 'system', message };
 }
 default:
 return null;
 }
}
export const bridgeApi = new Hono<ApiEnv>();
/** B-23: the same Bearer BRIDGE_SECRET check /send uses — /healthz used to be
 * unauthenticated, exposing failure counters + webhook posture next to a
 * gated send path. */
function bridgeAuthed(c: Parameters<MiddlewareHandler<ApiEnv>>[0]): boolean {
 const secret = env.bridgeSecret;
 const bearer = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
 // B-C22: timingSafeEqual throws RangeError when the buffers differ in length,
 // which crashed this route with a 500 on any wrong-length bearer. Compare
 // lengths first and fail CLOSED — a length mismatch is an auth failure (401),
 // never a success and never a crash. The length check itself leaks only the
 // secret's byte length, which is not sensitive.
 const secretBuf = Buffer.from(secret ?? '');
 const bearerBuf = Buffer.from(bearer);
 return Boolean(secret) && Boolean(bearer) && secretBuf.length === bearerBuf.length && timingSafeEqual(bearerBuf, secretBuf);
}
bridgeApi.post('/send', async (c) => {
 if (!bridgeAuthed(c)) {
 return c.json({ error: 'Unauthorized' }, 401);
 }
 if (!bridgeEnabled()) return c.json({ error: 'Bridge disabled' }, 503);
 let body: Record<string, unknown>;
 try {
 body = (await c.req.json()) as Record<string, unknown>;
 } catch {
 return c.json({ error: 'Invalid JSON' }, 400);
 }
 const event = parseBridgeBody(body);
 if (!event) return c.json({ error: 'Unrecognized bridge payload' }, 400);
 const ok = await sendEvent(event);
 return c.json({ accepted: ok, degraded: !ok });
});
bridgeApi.get('/healthz', async (c) => {
 if (!bridgeAuthed(c)) return c.json({ error: 'Unauthorized' }, 401);
 const h = health.chat;
 return c.json({
 enabled: bridgeEnabled(),
 eventsWebhook: Boolean(env.bridgeEventsWebhookUrl),
 disabled: Date.now() < h.disabledUntil,
 consecutiveFailures: h.consecutiveFailures,
 lastErrorAt: h.lastErrorAt || null,
 });
});
