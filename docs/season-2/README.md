# Season 2 — `imperium-backend`

This repo is **Lane D** in the ImperiumMC Season 2 program.

The program hub — charter, business plan, economy design, launch plan, the full
65-packet work queue and the execution protocol — lives in the plugin repo at
`ImperiumMC-Plugin/docs/season-2/`. Read these before working here:

| Read | For |
|---|---|
| `ImperiumMC-Plugin/docs/season-2/09-GLM-EXECUTION-PROTOCOL.md` | The binding rules: lanes, territory, cross-lane requests, wave barriers |
| `ImperiumMC-Plugin/docs/season-2/08-WORK-QUEUE.md` | All packets and their status |
| `ImperiumMC-Plugin/docs/season-2/prompts/LANE-D-BACKEND.md` | Your paste-ready agent prompt |
| `ImperiumMC-Plugin/docs/season-2/00-PROGRAM-CHARTER.md` | Why any of this |

## In this directory

| File | Contents |
|---|---|
| [`BACKEND-WORK-QUEUE.md`](BACKEND-WORK-QUEUE.md) | The nine Lane D packets with backend-specific detail |
| [`API-CONTRACTS-S2.md`](API-CONTRACTS-S2.md) | The endpoints Season 2 adds, and who consumes each |

## Context in one paragraph

Cloudflare Workers + Hono + TypeScript, fronting Supabase Postgres and the game
MySQL, integrated with PayNow. The plugin talks to this service over Redis
(commandBus / eventBridge / violationStore) and shares the database. The
frontend (Lane E) consumes its APIs. Season 2 adds three things this service has
never had: **a delivery ledger** (proof that a purchase actually delivered), **an
economy snapshot series** (the numbers that were missing while the live economy
reached a 0.971 gini), and **retention cohorts** (D1/D7/D30, without which the
launch cohort is unmeasurable).

## The two traps already paid for

1. **Per-request isolation.** `src/db/pool.ts` once held a module-global `pg`
   Pool; Workers forbids reusing a socket across requests, so `/health`
   alternated 200/503 and decayed to all-503. It was misdiagnosed as a
   Hyperdrive problem and "fixed" by an unrelated rebuild that never helped. The
   real fix (`dd9b47e`) is a per-query Client, the pattern `gameMysql.ts`
   already used. **Flaky on Workers means suspect isolation before infrastructure.**
2. **Double delivery.** Live purchase delivery runs through PayNow *commands*
   executed by the PayNow plugin, not through a backend webhook. The store has
   only subscription webhooks. Subscribing `order_completed` without stripping
   the commands in the same change would double-deliver every product.
