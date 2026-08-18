// 12a expansion: GET /api/legions/:id — public legion card (anonymous-OK,
// SWR-cached 60s). `:id` is the legion NAME (legions.name is the primary key).
//
// Data sources:
//  - legions / legion_members / legion_bank / legion_upgrade_levels: LIVE
//    plugin tables (SchemaInitializer creates them).
//  - legion_war_records: specced (wins/losses) — not created yet; warRecord
//    degrades to null rather than failing the card.
import { Hono } from 'hono';
import { readRateLimit } from '../../middleware/rateLimit.js';
import { query } from '../../db/pool.js';
import { logger } from '../../utils/logger.js';
import { swrJson } from './cache.js';
import type { AppContextVariables } from '../../types/index.js';

type ApiEnv = { Variables: AppContextVariables };

export const legionsApi = new Hono<ApiEnv>();

/** Legion name lookups: legions.name is VARCHAR(64); keep the key sane. */
const LEGION_NAME_PATTERN = /^[A-Za-z0-9_\- ]{3,64}$/;

legionsApi.get('/:id', readRateLimit, async (c) => {
  const name = c.req.param('id') ?? '';
  if (!LEGION_NAME_PATTERN.test(name)) {
    return c.json({ error: 'Invalid legion id' }, 400);
  }
  try {
    return await swrJson(c, `legion:card:${name.toLowerCase()}:v1`, async () => {
      const legion = await query<{
        name: string;
        display_name: string | null;
        level: number;
        max_members: number;
        owner_uuid: string;
        motd: string | null;
        created_at: string;
        xp: string;
        member_count: string;
        bank_balance: string | null;
        owner_name: string | null;
      }>(
        `SELECT l.name, l.display_name, l.level, l.max_members, l.owner_uuid, l.motd, l.created_at,
                l.xp::text,
                (SELECT COUNT(*) FROM legion_members m WHERE m.legion_name = l.name)::text AS member_count,
                b.balance::text AS bank_balance,
                po.username AS owner_name
           FROM legions l
           LEFT JOIN legion_bank b ON b.legion_name = l.name
           LEFT JOIN player_names po ON po.uuid = l.owner_uuid
          WHERE l.name = $1`,
        [name],
      );

      const row = legion.rows[0];
      if (!row) {
        // swrJson translates undefined into a 404 (uncached).
        return undefined;
      }

      // Roster (public — same shape /player/legion serves the member themself).
      const members = await query<{ player_uuid: string; role: string; username: string | null }>(
        `SELECT m.player_uuid, m.role, pn.username
           FROM legion_members m
           LEFT JOIN player_names pn ON pn.uuid = m.player_uuid
          WHERE m.legion_name = $1
          ORDER BY CASE m.role WHEN 'LEADER' THEN 0 WHEN 'OFFICER' THEN 1 WHEN 'ELITE' THEN 2 ELSE 3 END, pn.username
          LIMIT 200`,
        [name],
      );

      // Perk tiers: purchased upgrade levels (empty until the legion buys any).
      const upgrades = await query<{ upgrade_id: string; level: number }>(
        `SELECT upgrade_id, level FROM legion_upgrade_levels
          WHERE legion_name = $1 AND level > 0
          ORDER BY upgrade_id`,
        [name],
      );

      // War record: specced legion_war_records — null until the plugin tracks it.
      let warRecord: { wins: number; losses: number } | null = null;
      try {
        const war = await query<{ wins: number; losses: number }>(
          'SELECT wins, losses FROM legion_war_records WHERE legion_name = $1',
          [name],
        );
        if (war.rows[0]) {
          warRecord = { wins: Number(war.rows[0].wins ?? 0), losses: Number(war.rows[0].losses ?? 0) };
        }
      } catch {
        // Table not created yet.
      }

      return {
        name: row.name,
        displayName: row.display_name,
        level: Number(row.level ?? 1),
        xp: Number(row.xp ?? 0),
        motd: row.motd,
        createdAt: row.created_at,
        memberCount: Number(row.member_count ?? 0),
        maxMembers: Number(row.max_members ?? 10),
        ownerUuid: row.owner_uuid,
        ownerName: row.owner_name ?? row.owner_uuid,
        bankBalance: row.bank_balance === null ? null : Number(row.bank_balance),
        perks: upgrades.rows.map((u) => ({ upgradeId: u.upgrade_id, level: Number(u.level) })),
        warRecord,
        members: members.rows.map((m) => ({
          uuid: m.player_uuid,
          username: m.username ?? m.player_uuid,
          role: m.role,
        })),
      };
    });
  } catch (err) {
    logger.error({ err, name }, 'legions/:id failed');
    return c.json({ error: 'Database unavailable' }, 503);
  }
});
