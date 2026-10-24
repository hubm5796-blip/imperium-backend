# Working agreement for agents (and humans)

**The standing question: "Does this actually do what it says?"** Before calling anything done, prove it works in the real thing. Compiling, type-checking or a green unit run is not proof.

## Evidence, not claims

Every PR that fixes a bug or adds behaviour includes **evidence from a real run** in its description. "Tests pass" alone doesn't count. Evidence means one of:

- a link to a **CI run** that exercised the change, with the relevant log lines or artifacts: the launcher smoke workflow, the client gametest workflow, or a test job
- a screenshot of the changed UI from a CI artifact (gametest screenshots) or a website preview
- a `curl` against the deployed or preview endpoint with its status and body

**Never launch Minecraft, or the launcher's game, on the agent machine.** Only Claude, running on the owner's PC, launches Minecraft. In-game evidence comes from the GitHub Actions workflows (start them with `workflow_dispatch` when they don't run on push). If something can only be checked on a real PC, such as performance numbers, Microsoft sign-in, the installer or a GPU-specific bug, list it under "Not verified" with exact steps. Claude on the owner's PC runs those checks and reports back on the PR.

If you couldn't verify something, write **"Not verified: <what and why>"** in the PR. Never write "fixed" for something you haven't seen fixed. A wrong "fixed" costs the owner more than an honest "not verified".

## Tests must be able to fail

- A test that would pass with the fix reverted proves nothing. For a bug fix, write the test first and see it fail on the old code. Say so in the PR.
- A CI step that runs zero tests must fail, not go green. Check the reported count.
- Smoke and integration checks read only output from *this* run, never files left over from a previous one.
- Tests never touch real user data (configs, saves, `%APPDATA%`). Use temp directories.
- **Mocks prove your code, not the outside world.** Anything that talks to a third party (Microsoft, Xbox, Mojang, Discord, PayNow, GitHub) also needs one check against the real service before you call it working, for example a `curl` of the real URL showing the expected page or status. Mocked tests passed on a Microsoft URL that returned 404 in production.
- **A fallback or "no errors seen" verdict is not a pass.** If a check can pass without the thing ever happening (no game log, no response, zero tests), it must fail instead.

## Where the work is

- Current priorities, in order: **RomanicaClient#12** (latest comment). Read it before starting anything new.
- Deploy and release only from the default branch (`main`/`master`). Branches that drift from it ship without its fixes.

## Finish the job

- Search for every occurrence before saying a rename or migration is complete. Paste the grep that comes back empty.
- When a spec issue lists N items, the PR states which of the N it covers. Leftovers go in a comment on the issue, not silently dropped.
- Don't release, tag or update the distribution index until the evidence above exists for that build.

## Owner rules

- Never rotate, print or commit secrets.
- Kill processes by exact PID only, never by matching a command line.
- Don't commit Mojang assets. Don't copy files or assets from other clients.
- Don't name other clients in commit messages, README or PRODUCT.md (`docs/` is fine).
- The brand is **Romanica**, the domain is **romanica.net**, and the API is **api.romanica.net**. `imperiummc.net` is retired and being transferred. Never reference it in new code.
- Commits use minimal conventional format (`fix:`, `feat:`, `chore:`), one logical change each.

## How to verify in this repo (romanica-backend)

- `npx vitest run` and `npx tsc --noEmit -p .` must both pass. Paste the counts.
- **Deployed proof:** after `npx wrangler deploy` (the deploy path; Workers Builds for this Worker is not set up correctly), `curl` every endpoint you changed on `https://api.romanica.net`, plus `/health`, and paste the status and body. If you can't deploy, write "not verified on prod".
- Values in `wrangler.jsonc` `vars` are authoritative. A var set only in the dashboard gets wiped on deploy. Secrets go through `wrangler secret put` and are never committed or printed.
- Anything that verifies signatures or keys (Discord interactions, PayNow webhooks, JWT) gets a test that loads the **real configured value** and checks its length and format. The Discord public key sat truncated from Aug 28 to Oct 22 because nothing checked it.

## Lessons from past misses

- Microsoft sign-in shipped with `oauth2/v2_0/...` (Microsoft's path is `v2.0`) and with AxolotlClient upstream's Azure client ID, so the live button led to a 404. Nine mocked tests passed. For any third-party URL, test the exact URL string, and `curl` the real endpoint before deploying. Our Azure app is `8b0c9e33-b6ce-40ec-ac30-c85a35dd8163`.
- Don't put a feature behind a visible button until it works end to end. Use a flag that is off by default.
- A truncated `DISCORD_PUBLIC_KEY` silently broke interactions for two months.
- CORS and CSRF origin lists must match the live site domains. Keep `src/middleware/gates.ts` the single source.
