const fs = require('fs');
const p = 'src/db/redis.ts';
let s = fs.readFileSync(p, 'utf8');
const NL = '\n';

// 1. stable stringify + signCommand with body coverage
const OLD_SIGN = [
  '/**',
  ' * HMAC-SHA256 signature of `"$type|$ts|$nonce|$requestId"` using the shared',
  ' * WEBPANEL_HMAC_SECRET, where `ts` is unix SECONDS (matching the plugin\'s',
  ' * `WebPanelCommandHandler.verifyCommandSignature`, which signs',
  ' * `"$type|$ts|$nonce|$requestId"` with `ts = currentTimeMillis()/1000` and a',
  ' * 30s freshness window). The plugin computes the same signature on receipt and',
  ' * rejects mismatches.',
  ' */',
  'export function signCommand(',
  '  type: string,',
  '  timestamp: number,',
  '  nonce: string,',
  '  requestId: string,',
  '): string {',
  '  const message = `${type}|${timestamp}|${nonce}|${requestId}`;',
  '  return crypto',
  '    .createHmac(\'sha256\', env.webpanelHmacSecret)',
  '    .update(message)',
  '    .digest(\'hex\');',
  '}',
].join(NL);
const NEW_SIGN = [
  '/**',
  ' * Canonical JSON for signing: recursively key-sorted, compact. Both sides',
  ' * (Node here, Gson in the plugin) must produce byte-identical output.',
  ' */',
  'export function stableStringify(v: unknown): string {',
  '  if (v === null || typeof v !== \'object\') return JSON.stringify(v);',
  '  if (Array.isArray(v)) return \'[\' + v.map(stableStringify).join(\',\') + \']\';',
  '  const obj = v as Record<string, unknown>;',
  '  return \'{\' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + \':\' + stableStringify(obj[k])).join(\',\') + \'}\';',
  '}',
  '',
  '/**',
  ' * HMAC-SHA256 command signature. v2 (2026-08-22 security review): the message',
  ' * is `"$type|$ts|$nonce|$requestId|" + sha256Hex(canonicalJson(envelopeMinusSig))`',
  ' * — the WHOLE body is authenticated. The old v1 envelope-only signature meant',
  ' * one valid DISPATCH_COMMAND signature was valid for EVERY DISPATCH_COMMAND',
  ' * (arbitrary console execution), same for GIVE_ITEM / SET_RAW_CONFIG /',
  ' * WIPE_VAULT / COMPENSATE_PLAYER. The plugin accepts v2 first and v1 only as',
  ' * a one-deploy transition fallback.',
  ' */',
  'export function signCommand(',
  '  type: string,',
  '  timestamp: number,',
  '  nonce: string,',
  '  requestId: string,',
  '  body?: Record<string, unknown>,',
  '): string {',
  '  let message = `${type}|${timestamp}|${nonce}|${requestId}`;',
  '  if (body !== undefined) {',
  '    const bodyHash = crypto.createHash(\'sha256\').update(stableStringify(body)).digest(\'hex\');',
  '    message += `|${bodyHash}`;',
  '  }',
  '  return crypto',
  '    .createHmac(\'sha256\', env.webpanelHmacSecret)',
  '    .update(message)',
  '    .digest(\'hex\');',
  '}',
].join(NL);
if (!s.includes(OLD_SIGN)) { console.error('signCommand block missing'); process.exit(1); }
s = s.replace(OLD_SIGN, NEW_SIGN);

// 2. verifyCommand accepts v2 then v1
const OLD_VERIFY = [
  '/** Verify an incoming signature (used by the bot when relaying commands). */',
  'export function verifyCommand(',
  '  type: string,',
  '  timestamp: number,',
  '  nonce: string,',
  '  requestId: string,',
  '  signature: string,',
  '): boolean {',
  '  const expected = signCommand(type, timestamp, nonce, requestId);',
].join(NL);
const NEW_VERIFY = [
  '/** Verify an incoming signature (v2 body-bound first, v1 envelope fallback). */',
  'export function verifyCommand(',
  '  type: string,',
  '  timestamp: number,',
  '  nonce: string,',
  '  requestId: string,',
  '  signature: string,',
  '  body?: Record<string, unknown>,',
  '): boolean {',
  '  const expected = signCommand(type, timestamp, nonce, requestId, body);',
  '  if (safeEqualHex(expected, signature)) return true;',
  '  const v1 = signCommand(type, timestamp, nonce, requestId);',
  '  return safeEqualHex(v1, signature);',
].join(NL);
if (!s.includes(OLD_VERIFY)) { console.error('verifyCommand block missing'); process.exit(1); }
s = s.replace(OLD_VERIFY, NEW_VERIFY);

// 3. safeEqualHex helper
s = s.replace('export const COMMANDS_CHANNEL', `function safeEqualHex(a: string, b: string): boolean {
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

export const COMMANDS_CHANNEL`);

// 4. sendCommand signs the whole envelope (minus sig)
const OLD_SEND = '  const signature = signCommand(type, timestamp, nonce, requestId);';
const NEW_SEND = ['  // v2: the envelope minus `sig` IS the body — sign it whole.',
  '  const bodyForSig: Record<string, unknown> = { type, request_id: requestId, ts: timestamp, nonce, payload };',
  '  const signature = signCommand(type, timestamp, nonce, requestId, bodyForSig);',
].join(NL);
if (!s.includes(OLD_SEND)) { console.error('sendCommand sign line missing'); process.exit(1); }
s = s.replace(OLD_SEND, NEW_SEND);

fs.writeFileSync(p, s);
console.log('backend HMAC v2 applied');
