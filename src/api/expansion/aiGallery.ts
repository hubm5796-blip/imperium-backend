// AIDEV artifact gallery (2026-08-27) — staff-facing window into the /aidev
// vision tools' output directory on the live game server:
//   GET /api/admin/ai-artifacts                (list plugins/ImperiumMC/ai/)
//   GET /api/admin/ai-artifacts/content?name=  (one artifact: png bytes or text)
//
// Auth: bot token only — consumed by the frontend's server-side edge proxy
// (src/app/api/admin/ai-artifacts), same trust model as adminViews.ts.
//
// Panel access (PANEL_URL / PANEL_API_KEY / PANEL_SERVER_ID env) is OPTIONAL:
// unset → configured:false with a setup hint, never a crash. Artifact names
// are whitelisted to a flat [A-Za-z0-9._-]+ basename + known extensions, so
// the ?name= parameter can never traverse out of the ai/ directory.
import { Hono, type Context } from 'hono';
import { botTokenMatches } from '../../middleware/auth.js';
import { readRateLimit } from '../../middleware/rateLimit.js';
import { env } from '../../env.js';
import type { AppContextVariables } from '../../types/index.js';

type ApiEnv = { Variables: AppContextVariables };

export const aiGalleryApi = new Hono<ApiEnv>();

/** The one directory this API is allowed to see. */
const AI_DIR = '/plugins/ImperiumMC/ai';

/** Flat whitelisted artifact name — no separators, no traversal, known ext. */
export function isSafeArtifactName(name: string | undefined): boolean {
  if (!name || name.length > 100) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return false;
  return /\.(png|txt|json|log|yml|yaml)$/i.test(name);
}

function panelConfigured(): boolean {
  return Boolean(env.panelUrl && env.panelApiKey && env.panelServerId);
}

function notConfigured(c: Context) {
  return c.json(
    {
      configured: false,
      hint: 'Set PANEL_URL, PANEL_API_KEY and PANEL_SERVER_ID (Pterodactyl client API key + server id) as backend secrets to enable the artifact gallery.',
      artifacts: [],
    },
    200,
  );
}

/** Panel request with the client API key; never throws. */
async function panelFetch(path: string): Promise<Response | null> {
  try {
    return await fetch(`${env.panelUrl}${path}`, {
      headers: { Authorization: `Bearer ${env.panelApiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return null;
  }
}

interface PanelListEntry {
  attributes?: { name?: string; size?: number; modified_at?: string; is_file?: boolean };
}

/** GET /api/admin/ai-artifacts — newest-first listing of the ai/ directory. */
aiGalleryApi.get('/admin/ai-artifacts', readRateLimit, async (c) => {
  if (!botTokenMatches(c)) return c.json({ error: 'Unauthorized' }, 401);
  if (!panelConfigured()) return notConfigured(c);

  const res = await panelFetch(
    `/api/client/servers/${env.panelServerId}/files/list?directory=${encodeURIComponent(AI_DIR)}`,
  );
  if (!res || !res.ok) {
    return c.json({ configured: true, available: false, artifacts: [] }, 200);
  }
  const body = (await res.json().catch(() => null)) as { data?: PanelListEntry[] } | null;
  const entries = Array.isArray(body?.data) ? body!.data! : [];
  const artifacts = entries
    .filter((e) => e.attributes?.is_file !== false && isSafeArtifactName(e.attributes?.name ?? ''))
    .map((e) => ({
      name: e.attributes!.name!,
      size: Number(e.attributes?.size ?? 0),
      modified: e.attributes?.modified_at ?? null,
    }))
    .sort((a, b) => (b.modified ?? '').localeCompare(a.modified ?? ''));
  return c.json({ configured: true, available: true, artifacts }, 200);
});

/** GET /api/admin/ai-artifacts/content?name=face.png — bytes for images, text otherwise. */
aiGalleryApi.get('/admin/ai-artifacts/content', readRateLimit, async (c) => {
  if (!botTokenMatches(c)) return c.json({ error: 'Unauthorized' }, 401);
  if (!panelConfigured()) return notConfigured(c);
  const name = c.req.query('name') ?? '';
  if (!isSafeArtifactName(name)) return c.json({ error: 'Invalid artifact name' }, 400);

  const dl = await panelFetch(
    `/api/client/servers/${env.panelServerId}/files/download?file=${encodeURIComponent(`${AI_DIR}/${name}`)}`,
  );
  if (!dl || !dl.ok) return c.json({ error: 'Artifact not found' }, 404);
  const dlBody = (await dl.json().catch(() => null)) as { attributes?: { url?: string } } | null;
  const signed = dlBody?.attributes?.url;
  if (!signed) return c.json({ error: 'Panel returned no signed URL' }, 502);

  let bytes: ArrayBuffer | null = null;
  try {
    const file = await fetch(signed, { signal: AbortSignal.timeout(15_000) });
    if (!file.ok) return c.json({ error: `Signed URL fetch failed (${file.status})` }, 502);
    bytes = await file.arrayBuffer();
  } catch {
    return c.json({ error: 'Signed URL fetch timed out' }, 502);
  }
  if (bytes.byteLength > 4_000_000) return c.json({ error: 'Artifact too large' }, 413);

  if (/\.png$/i.test(name)) {
    return c.body(bytes, 200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'private, max-age=30',
    });
  }
  return c.body(bytes, 200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'private, max-age=30',
  });
});
