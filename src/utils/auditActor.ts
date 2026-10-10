/**
 * Per-actor audit attribution (2026-10-06).
 *
 * Staff/bot actions used to share one identity in audit records: the v1 admin
 * dispatches already carried a resolved actor name, but the v2 surfaces
 * (ticket staff notes, ticket status changes, changelog posts, gallery
 * moderation) recorded either nothing or just "the bot did this". This module
 * is the ONE attribution shape every audit-worthy write threads through:
 *
 *   { id, name }  —  id is a STABLE machine identity from a closed vocabulary:
 *                     discord:<snowflake>  a Discord human (interaction member
 *                                          or a session's linked Discord)
 *                     mc:<dashed uuid>     a linked Minecraft account (session)
 *                     named:<name>         a token-bound identity (per-staff
 *                                          STAFF_ACTOR_TOKEN_MAP token or a
 *                                          named ACTOR_TOKEN_MAP service)
 *                     service:bot          the shared bot/service token — the
 *                                          legacy fallback when no human is
 *                                          attributable (internal cron sweeps)
 *                     system               no credential at all (scheduled()
 *                                          drains and other machine origins)
 *                   name is the human-readable display string for audit rows.
 *
 * Trust model: this module only LABELS, it never authorizes. The gates in
 * middleware/gates.ts remain the one authorization implementation; where a
 * route threads an actor ref in a request BODY (the v2 bot surface), the
 * caller must already be bot-token authenticated — the same internal-trust
 * doctrine as the delegated X-Mc-Uuid principal.
 */
import type { Context } from 'hono';
import { botOrServiceTokenValid, resolveStaffActor } from '../middleware/gates.js';

/** Who performed an audit-worthy action — see the module header. */
export interface AuditActor {
  /** Stable machine identity from the closed id vocabulary. */
  id: string;
  /** Human-readable display name for audit rows. */
  name: string;
}

/** No credential, no caller — scheduled() drains and other machine origins. */
export const SYSTEM_ACTOR: AuditActor = { id: 'system', name: 'system' };

/** Valid bot/service token but no attributable human — the legacy attribution. */
export const SHARED_BOT_ACTOR: AuditActor = { id: 'service:bot', name: 'bot' };

/** Dashed-lowercase Minecraft uuid (the canonical store form, B-06). */
const MC_UUID_DASHED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Closed id vocabulary — parseActorRef rejects anything else. */
const ACTOR_ID_RE =
  /^(discord:\d{5,25}|mc:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|named:[A-Za-z0-9_. -]{1,64}|service:bot|system)$/;

/**
 * Display-name shape: printable identifier charset (covers Discord
 * usernames, Minecraft names and service names), bounded. REJECT rather
 * than sanitize — a ref that fails this returns null and the caller falls
 * back to the shared-bot attribution, so no caller-supplied string ever
 * reaches an audit row in a mangled form.
 */
const ACTOR_NAME_RE = /^[A-Za-z0-9_.\- ]{1,80}$/;

function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return ACTOR_NAME_RE.test(trimmed) ? trimmed : null;
}

/**
 * The actor for a Discord interaction member — the invoking human. The id is
 * the platform snowflake (stable, linkable); the name is the username at
 * invoke time (display-only). Returns null on a non-snowflake id.
 */
export function discordActor(userId: string, username: string | undefined): AuditActor | null {
  if (!/^\d{5,25}$/.test(userId)) return null;
  const name = cleanName(username) ?? userId;
  return { id: `discord:${userId}`, name };
}

/**
 * Validate an actor ref threaded through a request BODY (the bot forwarding
 * the invoking member on internal calls). Null on garbage — the caller then
 * falls back to the shared-bot attribution, never to the raw value.
 */
export function parseActorRef(id: unknown, name: unknown): AuditActor | null {
  if (typeof id !== 'string' || !ACTOR_ID_RE.test(id)) return null;
  const cleaned = cleanName(name);
  if (!cleaned) return null;
  if (id === 'system') return SYSTEM_ACTOR;
  return { id, name: cleaned };
}

/**
 * The acting human for an HTTP request, from the established trust sources
 * (one implementation — gates.resolveStaffActor — does the resolving; this
 * only maps its verdict into the AuditActor shape):
 *
 *   per-staff token / named service token  →  named:<name>
 *   session or verified staff header claim →  discord:<id> | mc:<uuid> | named:<name>
 *   bare shared bot/service token          →  service:bot   (the legacy fallback)
 *   no credential                          →  system
 */
export async function resolveAuditActor(c: Context): Promise<AuditActor> {
  const staff = await resolveStaffActor(c);
  if (staff.source === 'staff-token' && staff.name !== 'anonymous') {
    // A token-BOUND identity — either a per-staff personal token or a named
    // ACTOR_TOKEN_MAP service. Both are named actors, which is the point.
    return parseActorRef(`named:${staff.name}`, staff.name) ?? SHARED_BOT_ACTOR;
  }
  if (staff.source === 'header-claim' || staff.source === 'session-claim') {
    if (staff.name.startsWith('discord:')) {
      const id = staff.name.slice('discord:'.length);
      return parseActorRef(staff.name, id) ?? { id: staff.name, name: staff.name };
    }
    if (MC_UUID_DASHED.test(staff.name)) {
      return parseActorRef(`mc:${staff.name}`, staff.name) ?? SHARED_BOT_ACTOR;
    }
    return parseActorRef(`named:${staff.name}`, staff.name) ?? SHARED_BOT_ACTOR;
  }
  if (botOrServiceTokenValid(c)) return SHARED_BOT_ACTOR;
  return SYSTEM_ACTOR;
}
