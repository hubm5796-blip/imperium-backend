# imperium-backend — Audit, 2026-09-05

Part of a cross-repo strict audit of the three ImperiumMC codebases.

**Audited at:** `eba7716` (`master`)

## In this directory

| File | Contents |
|---|---|
| [`FINDINGS.md`](FINDINGS.md) | B-01 … B-08, this repo's findings |
| [`CROSS-REPO.md`](CROSS-REPO.md) | X-01 … X-04, the seams with the plugin and frontend |

The full audit — executive summary, plugin and frontend findings, methodology,
and the GLM handoff prompt — lives in the plugin repo at
`ImperiumMC-Plugin/docs/audit/`.

## The one that matters

**B-01 (Critical): the staff role gates do not restrict anything.**
`staffActorHasRole` returns `true` unconditionally for the actor
`'panel-service'` (`src/api/routes.ts:198`), and `resolveStaffActor` resolves
*any* unmapped bot token to exactly that name (`:191`). So a caller presenting
only `X-Bot-Token` satisfies every role gate — punish, broadcast, and live
config reload.

The privilege model is also inverted: presenting valid staff credentials grants
*less* access than presenting none. And per X-04, the frontend never sends the
staff headers at all, so this is not a dormant code path — it is the only path
in production.

Fix B-01 and X-04 together, X-04 first. See `FINDINGS.md` for why.

## State at time of audit

- `tsc --noEmit` — clean
- `vitest run` — 16 files, 143 tests, 143 passed
- No hardcoded secrets, no SQL injection found

The findings are about logic that compiles and passes its tests but does not do
what its own comments say it does.
