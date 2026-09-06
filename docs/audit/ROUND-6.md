# Round 6 — Findings (backend)

Sixth strict pass over `imperium-backend`, at `a7f09ed` (`master`).
Code unchanged (all commits since Round 1 are docs-only). This round covered
the one-shot scripts, expansion remainder, cron legs, Discord-side commands,
v2 wiring, and a last-chance routes sweep.

Rounds 1–5: `FINDINGS.md` (B-01…B-08), `ROUND-2.md` (B-09, B-10),
`ROUND-3.md` (B-11…B-17), `ROUND-4.md` (B-18…B-25), `ROUND-5.md` (B-26…B-34).
This file: **B-35…B-42**.

| ID | Sev | Finding |
|---|---|---|
| B-35 | Critical | `rebuild-currency-balances.cjs` carries prod MySQL + Supabase passwords as fallbacks |
| B-36 | High | Rebuild wipes `currency_balances` with no dry-run, no guard, nondeterministic winner |
| B-37 | High | Legion board: game path ranks civitas/100 into `xp`, fallback ranks `xp` raw — comment describes a missing field |
| B-38 | Medium | `POST /errors/report` turns the shared bot token into an unaudited staff-ping cannon |
| B-39 | High | Cron legs past the ticket sweep: no overlap guard, duplicates on retry, silent skips |
| B-40 | Medium | `/ticket` staff gate trusts a Discord role; siblings trust backend LuckPerms |
| B-41 | Medium | `discordRest.ts`: no timeout, no 429/5xx split — stall eats windows, 429 reads as attrition |
| B-42 | Medium | v2 wiring: `openapi.json` advertises a contract the mounted residents don't implement |

---

## B-35 · Critical · Third password copy (+ a live MySQL password) in a one-shot script

**Evidence:** `rebuild-currency-balances.cjs:20-35` —
`process.env.MYSQL_PASSWORD ?? 'xnimJLk2mllZ9LmcYYFvrq.C'`,
`process.env.SUPABASE_PASSWORD ?? 'KCxtU9fjBMkZDRC&'`. C1 + rounds flagged
`wrangler.jsonc:24` and `migrate-tables.cjs:22-24`; this is a **third copy**
plus a MySQL password nowhere else flagged. Halves any C1 rotation; history
retains both forever.

**Fix:** require env (`?? process.exit(1)`), no literal fallback; rotate both;
purge history.

---

## B-36 · High · Rebuild wipes balances with no guard (P-14 shape, new table)

**Evidence:** `rebuild-currency-balances.cjs:15,59,66-70` — "Idempotent: wipes
and re-inserts in one transaction": `DELETE FROM currency_balances`, repopulated
from one unbounded MySQL `SELECT` with no lock/snapshot. Zero-row
(perms/outage/empty) or truncated read → COMMIT an empty/partial mirror — the
exact P-14 shape, no shadow backup, no `--dry-run`/`--confirm`, no
`rows.length==0` abort, no delta sanity. `ON CONFLICT (uuid,currency) DO NOTHING`
on the dupes this script exists to fix picks an arbitrary survivor by chunk
order. `new Date(null).toISOString()` throws → `ROLLBACK`, safe but no
partial-retry plan.

**Fix:** abort on empty or `|new−old| > N%`; pre-image table
`currency_balances_pre_rebuild_<ts>`; deterministic dedupe (canonical keys);
`--dry-run` + explicit confirm flag.

---

## B-37 · High · Legion board ranks differently per DB + 100× magnitude split (standing-rule)

**Evidence:** `src/api/expansion/leaderboards.ts:111-113,133-141,150-164` —
game path `xp: civitas/100`, fallback `ORDER BY l.xp DESC` on raw `xp`; comment
"OWNER DIRECTIVE: `value` carries the civitas total" but
`LegionBoardEntry` has no `value` field. Vs `publicProfiles.ts:396-398`
("WHOLE-UNIT STORAGE … no ÷100"). Same board, different order **and** 100×
magnitude depending on which DB answers (B-11 split-brain, new instance); one
path wrong by the repo's own whole-unit rule.

**Fix:** one ranking key + one unit path; add `value` or fix the comment;
cross-path fixture test (same order both paths).

---

## B-38 · Medium · `/errors/report` unaudited staff-ping cannon on the shared token

**Evidence:** `src/api/routes.ts:2590-2634` — no rateLimit middleware;
`kind` (60) + `detail` (1500) free-form → `alertError` (staff webhook + owner DM,
`utils/errorAlerts.ts`). Auth: `X-Bot-Token` (B-13 shared secret) **or** the
B-10/P-01 HMAC — no per-sender cap, no dedupe, no `kind` allowlist. Any holder
spams staff/owner with arbitrary text; free-form `kind` poisons alert routing.

**Fix:** `writeRateLimit` + hourly caps; allowlist `kind`; service-token (not
shared) for the HMAC path or sign `kind+detail`; log sender hash.

---

## B-39 · High · Cron legs: overlaps duplicate, retries duplicate, windows skip silently

**Evidence:** `src/webhooks/store.ts:184-197` + `deliver.ts:162-196` (no claim —
overlapping ticks POST same rows twice; up to 20×10 s sequential fetches exceed
the 60 s tick); `deliver.ts:43` (`crypto.randomUUID` per emit) +
`tailer.ts:88-109` (cursor-write fail → rescan as **new** IDs); single-minute
windows (`rollup.ts:71` `00:05`, `roles/audit.ts:46` `03:00` capped ~1500/night,
`scheduler.ts:290` vote `claim` before fanout + crash = remainder never retried).
`cron.ts:47-108` isolates legs from each other, nothing isolates a leg from itself.

**Fix:** atomic claim (`UPDATE … WHERE status … RETURNING` / `SKIP LOCKED`);
idempotency on `(type, web_events.id)`; rollup catch-up (`WHERE day < today AND
NOT done LIMIT 1`); day-roll-proof audit cursor; per-user vote-fanout claims.

---

## B-40 · Medium · `/ticket` gates on a cosmetic Discord role; siblings use LuckPerms

**Evidence:** `src/bot/commands/ticket.ts:160-165`
(`interaction.memberRoles.includes(staff)`) vs `moderation.ts:28-40`
(`getPermissions` backend lookup). `TICKET_STAFF_ROLE_ID` grantable by any
Discord admin — ticket PII + reply/close over **any** free-form `id` hinge on
roles the moderation path rejects as authority. `id`/`resolution`/`text`
presence+length only; `close` hardcodes `status:'closed'` into B-16's
unvalidated surface.

**Fix:** `requireStaff(shim,'helper')` for reply/close/info (Discord role as
UX pre-check only); validate `id` server-side; scope `info` to thread-member
or staff.

---

## B-41 · Medium · Discord REST: no timeout, 429 reads as attrition

**Evidence:** `src/bot/discordRest.ts:8-21,29-70` — no `AbortSignal.timeout`
anywhere (B-21/C4 covered PayNow + Redis/MySQL; this is the remaining unguarded
family — scheduler awaits sends sequentially inside 6-/5-min war windows, one
stall eats the window); all statuses collapse (`return res.ok`), so
`sync.ts:96-106` counts 429-exhaustion as "member left" (`failed++`).

**Fix:** 8 s timeouts; `{ok, status}` + retry-after-aware 429 backoff; count 429
separately in reports.

---

## B-42 · Medium · OpenAPI advertises a contract the mounted residents don't keep

**Evidence:** `src/api/v2/openapi.ts:38-47` (enveloped responses, unknown-params
rejected, scopes enforced) + `app.ts:99-101` vs `expansion/index.ts:38-41`
(`/v2/public|member|webhooks|events/stream` via `routes.ts:2701`): residents
return bare shapes (`memberRoles.ts:109`, `webhookAdmin.ts:60-90`,
`publicProfiles.ts:167`, `community.ts:252`), no unknown-param checks, no
`requireScope` (B-20, still zero consumers). Spec documents
`/leaderboards/{board}` as 4 boards while the `rank|legion|colosseum` family
shares the prefix undocumented; SSE `?last_event_id` omitted (header-only per spec).

**Fix:** envelope the residents (or version-exclude with real shapes); document
both leaderboard families; document-or-remove the query resume variant.

---

## Coverage notes

**Swept (§6, 60 sites):** `errors/report` (→B-38), `refcode/custom` (sound),
`refcode/redeem` (CTE atomic, sound), `vote/:site` + `vote/status` (sound),
`marketplace/*`, `player/crates`, `tickets/mine`, `action/sellall`, `link/*`,
`store/*` (prior dispositions stand), `webhooks/paynow` + `guides` rest (stand).
No other unreviewed mutating route found.
**Verified good:** `migrate-bot-tables.cjs` re-runnable (`IF NOT EXISTS`);
`memberRoles` donor-expiry + targeted-read correct; `communityApi` auth split
correct; `webshop` vote-key length guard correct.
**NOT covered:** live Worker posture; plugin-side `legion create/invite` parsing
+ `web_queue` verification (B-27 hardening unverified); full `players/dungeons/
shopCatalog` pricing economics beyond vote/order enqueue.
