/**
 * V6 05-04 AUTH V2 — API key management.
 *
 *   POST   /api/v2/keys          create (session + linked owner only)
 *   GET    /api/v2/keys          list own keys (no hashes, no plaintext)
 *   DELETE /api/v2/keys/:id      revoke own key
 *
 * The plaintext key appears exactly ONCE, in the create response. Doctrine:
 * keys are read/webhook-manage only (no write scopes exist in the enum).
 */
import { Hono } from 'hono';
import { requireLinked } from '../../middleware/auth.js';
import { writeRateLimit, readRateLimit } from '../../middleware/rateLimit.js';
import { logger } from '../../utils/logger.js';
import { SCOPES, createKey, listKeys, revokeKey, type Scope } from '../../auth/apiKeys.js';
import type { AppContextVariables } from '../../types/index.js';

type ApiEnv = { Variables: AppContextVariables };

export const keysApi = new Hono<ApiEnv>();

keysApi.use('/keys*', requireLinked);

function parseScopeList(raw: unknown): Scope[] {
  if (!Array.isArray(raw)) return [];
  const wanted = raw.filter((s): s is string => typeof s === 'string');
  const valid = wanted.filter((s): s is Scope => (SCOPES as readonly string[]).includes(s));
  // Dedupe, preserve request order.
  return [...new Set(valid)];
}

keysApi.post('/keys', writeRateLimit, async (c) => {
  const ownerUuid = c.get('mcUuid');
  if (!ownerUuid) return c.json({ error: 'Unauthorized' }, 401);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const rec = (body ?? {}) as Record<string, unknown>;
  const name = typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : 'unnamed key';
  const scopes = parseScopeList(rec.scopes);
  if (scopes.length === 0) {
    return c.json({ error: 'At least one valid scope is required', validScopes: SCOPES }, 400);
  }
  try {
    const created = await createKey(name, ownerUuid, scopes);
    logger.info({ keyId: created.id, ownerUuid, scopes }, 'api key created');
    return c.json({
      id: created.id,
      name,
      scopes,
      // Shown exactly once — the client must store it now.
      key: created.plaintext,
      note: 'Store this key now — it is never shown again.',
    });
  } catch (err) {
    logger.error({ err: String(err) }, 'api key create failed');
    return c.json({ error: 'Key creation failed' }, 500);
  }
});

keysApi.get('/keys', readRateLimit, async (c) => {
  const ownerUuid = c.get('mcUuid');
  if (!ownerUuid) return c.json({ error: 'Unauthorized' }, 401);
  const keys = await listKeys(ownerUuid);
  return c.json({
    keys: keys.map((k) => ({
      id: k.id,
      prefix: k.prefix,
      name: k.name,
      scopes: (() => {
        try {
          return JSON.parse(k.scopes) as string[];
        } catch {
          return [];
        }
      })(),
      status: k.status,
      lastUsedAt: k.last_used_at,
      createdAt: k.created_at,
    })),
  });
});

keysApi.delete('/keys/:id', writeRateLimit, async (c) => {
  const ownerUuid = c.get('mcUuid');
  if (!ownerUuid) return c.json({ error: 'Unauthorized' }, 401);
  const id = c.req.param('id');
  const revoked = await revokeKey(id, ownerUuid);
  if (!revoked) return c.json({ error: 'Key not found or already revoked' }, 404);
  logger.info({ keyId: id, ownerUuid }, 'api key revoked');
  return c.json({ revoked: true });
});
