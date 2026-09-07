# Round 11 — First real suite execution + count fabrication (backend)

Eleventh pass over `imperium-backend`, at `c72c05c` (`master`).
Headline: the suite was EXECUTED here for the first time
(`npm ci`, `npx vitest run`, `npx tsc --noEmit`, node v24.16.0).
**21 files, 229 tests, 229 passed, 0 failed. `tsc --noEmit` clean.**
This file: **B-65** + the executed record.

Rounds 1–10: `FINDINGS.md` (B-01…B-08), `ROUND-2.md` (B-09, B-10),
`ROUND-3.md` (B-11…B-17), `ROUND-4.md` (B-18…B-25), `ROUND-5.md` (B-26…B-34),
`ROUND-6.md` (B-35…B-42), `ROUND-7.md` (B-43…B-50), `ROUND-8.md` (B-51…B-54),
`ROUND-9.md` (B-55, B-56), `ROUND-10.md` (B-57…B-59). This file: **B-65**.

| ID | Sev | Finding |
|---|---|---|
| B-65 | High (process) | Suite-count claims in fix messages are fabricated — 229 actual vs up to 365 claimed |

---

## B-65 · High (process) · "Suite N/N green" numbers do not match the suite

**Evidence:**
- Executed `npx vitest run` at `c72c05c` (after `npm ci`, 130 packages):
  **Test Files 21 passed (21); Tests 229 passed (229)** — all 21 files under
  `src/test/` ran, zero skipped, zero failed. `npx tsc --noEmit`: clean
  (the 69 pre-install `TS2307` errors were purely missing `node_modules`).
- Static `it(`/`test(` counts per file at the same HEAD sum to ≈219
  (+parameterized cases = 229 executed — consistent): paynow-fulfillment 35,
  api-expansion 32, expansion-community 34, checkout 19, mysql-wire 14,
  public-profile 11, webhooks 8, bridge/member-roles/api-v2 7 each, etc.
- Fix messages claim a chain 324→329→353→356→365, each step exactly +N for N
  "new tests" (d5d9913, 3aa875f, 00e75bd, aace0fb, b5a0016). Per-file reality:
  paynow-fulfillment actually holds **35** (claimed "27 = 20+7"),
  mysql-wire holds **14** (claimed 24), refcode 3=3 ✓, guest 9=9 ✓.
  `git log --diff-filter=D -- src/test/`: **no test file ever deleted**.
  21 files ran = all 21 present. 229 ≠ 365 under every counting consistent
  with the tree — the message arithmetic cannot be produced from these files.

**Why it matters:** "suite green" unblocks merges and closes audit findings
(B-09 was closed on a claimed 324/324). Counts wrong in BOTH directions per
file prove the numbers were never counted from the tree. Every prior
"verified: suite N/N" line in this audit's fix messages is now suspect —
including the ones this audit accepted.

**Fix:** CI executes `vitest run` + `tsc --noEmit` per PR and posts machine
output (no hand counts); amend the four fix messages' claims or strike them;
re-verify B-09/d5d9913-class closures against executed runs (this 229-green
run covers current HEAD, which includes those fixes — so they stand on THIS
run, not on their messages).

## Executed record (reproducible)

- `npm ci --no-audit --no-fund` (130 pkgs; EBADENGINE warning only — engines
  want node 26.x, ran 24.16.0; esbuild/workerd postinstalls skipped via
  allow-scripts policy — suite does not need them).
- `npx vitest run`: 21 files / 229 tests green in ~9 s (per-file lines in tool
  output: api-expansion 32, expansion-community 34, public-profile 11, …).
  Notable honest tests observed passing: vote 401/429 paths, shop order
  400/404/429 paths, rate-limit 429s, lookup 404→429 enumeration cap,
  degrade-on-missing-tables paths, SWR hit behavior.
- `npx tsc --noEmit`: clean.
- PATH note: `node`/`npm` live at `C:\Program Files\nodejs`, NOT on system
  PATH — every command above needed `set PATH=…`. Future runners: fix PATH
  or the documented commands fail with `'node' is not recognized`.

## Coverage notes

NOT re-verified this round: B-60…B-64 code fixes (filed Round-11 from diff
review); live PayNow/Mojang shapes; plugin/frontend seams. Deps now installed
(`node_modules/`, gitignored) — future runs are cheap.
