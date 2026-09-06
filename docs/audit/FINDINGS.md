# imperium-backend — Findings

**Commit:** `eba7716` (`master`) · **Scale:** 121 TypeScript files, 21,742 lines
· 16 test files, 143 tests, 0 failures · `tsc --noEmit` clean

---

## B-01 · Critical · Staff role gates do not restrict anything, and the privilege model is inverted

**Evidence:** `src/api/routes.ts:174-200`

```ts
function resolveStaffActor(c: Context): StaffActor {
  // ... match X-Staff-Token + X-Staff-Actor against staffActorTokenMap ...
  const fallback = resolveActorFromToken(c);              // :191
  const role = fallback === 'panel-service' ? 'admin' : 'helper';
  return { name: fallback, role, rank: STAFF_ROLE_RANK[role] };
}

function staffActorHasRole(actor: StaffActor, minimum): boolean {
  if (actor.name === 'panel-service') return true;        // :198
  return actor.rank >= (STAFF_ROLE_RANK[minimum] ?? 99);
}
```

And `resolveActorFromToken` (`:140-148`) returns the literal `'panel-service'`
for **any** bot token not present in `ACTOR_TOKEN_MAP` — which is the default
state for the plain shared `BOT_API_TOKEN`.

Chain it together. A caller presenting only `X-Bot-Token: <BOT_API_TOKEN>`:

1. passes `requireBotAuth`,
2. resolves to actor `'panel-service'`,
3. hits the unconditional `return true` at `:198`,
4. and therefore satisfies **every** role gate.

So the three role gates — `/admin/punish` requires mod (`:1016`),
`/admin/broadcast` requires helper (`:1069`), `/admin/reload` requires admin
(`:1084`) — are all no-ops on the default credential path. Anyone holding
`BOT_API_TOKEN` can ban players, broadcast to the server, and reload live
economy and anticheat configuration.

**The privilege model is also inverted.** Compare two callers:

| Caller | Resolves to | Can punish? | Can reload? |
|---|---|---|---|
| Bot token only, no staff headers | `panel-service`, exempt | **Yes** | **Yes** |
| Bot token in `ACTOR_TOKEN_MAP` as a named person | that name, role `helper` | No | No |
| Valid `X-Staff-Token` + `X-Staff-Actor`, role `helper` | that name, role `helper` | No | No |

Presenting *more* identity gets you *less* access. An attacker with the shared
token maximises privilege by sending nothing extra, and a legitimate helper who
correctly presents their staff credentials is refused. That is backwards, and
it means the RBAC cannot even be tested into correctness from the outside — the
insecure path is the one that works.

The exemption's stated justification (`:161-164`) is that the webpanel already
session-gates its users via LuckPerms, so the panel is trusted infrastructure.
That is a defensible argument about the *panel*. It is not an argument about
the *token*, which is what is actually being checked — and the token is shared
by the Discord bot and every service holding `BOT_API_TOKEN`. See X-04: the
frontend never sends staff headers, so 100% of real admin traffic takes the
exempt path.

**Fix direction:** the exemption must be bound to something the panel proves
and an attacker cannot assert by omission. The frontend already computes
LuckPerms-confirmed roles in `_guard.ts` and already sends `X-Admin-Uuid` —
have it forward the confirmed role in a signed header (or use
`INTERNAL_SERVICE_TOKEN` as a distinct panel credential, and exempt *that*
token rather than the absence of information). Then delete the
`'panel-service'` special case: absence of identity should resolve to the
lowest privilege, never the highest.

---

## B-02 · High · The delegated-principal token split is logically unreachable

**Evidence:** `src/middleware/gates.ts:75-90`

```ts
const botToken = c.req.header('x-bot-token') ?? '';
if (botToken && env.botApiToken && safeEqual(botToken, env.botApiToken)) {
  const asserted = c.req.header('x-mc-uuid');
  if (asserted && safeEqual(botToken, env.internalServiceToken)) {
    return { kind: 'delegated', mcUuid: asserted };
  }
  ...
}
```

To reach the `delegated` branch, `botToken` must equal `BOT_API_TOKEN` (outer
condition) **and** equal `INTERNAL_SERVICE_TOKEN` (inner condition). The two
secrets must therefore be identical for delegation to work at all.

The entire stated purpose of the split — documented at `src/env.ts:60-67` — is
that "a leak of either secret halves the blast radius". The implementation
guarantees the opposite:

- If `INTERNAL_SERVICE_TOKEN` is unset, it falls back to `BOT_API_TOKEN`
  (`env.ts:202`), the two are equal, delegation works, and there is no split.
- If `INTERNAL_SERVICE_TOKEN` is set to a distinct value — i.e. the split is
  actually activated, which is the documented goal — the outer condition fails
  for that token and the `delegated` branch becomes **unreachable**.
  `requireSelfOrDelegated` then 401s every proxied call.

So the feature is inert when off and breaks traffic when turned on. Because
`requireSelfOrDelegated` currently has exactly one consumer
(`src/api/v2/storeOrders.ts:27`), the breakage is presently narrow — but it is
a loaded gun aimed at whoever sets that variable believing the docs.

**Fix direction:** the outer condition should accept *either* secret and the
inner branch should require the service token specifically:

```ts
const isBot = safeEqual(botToken, env.botApiToken);
const isService = safeEqual(botToken, env.internalServiceToken);
if (!isBot && !isService) return { kind: 'anonymous' };
const asserted = c.req.header('x-mc-uuid');
if (asserted && isService) return { kind: 'delegated', mcUuid: asserted };
return { kind: 'bot' };
```

Add a test asserting that a distinct `INTERNAL_SERVICE_TOKEN` still yields a
`delegated` principal — the current test suite would not have caught this.

---

## B-03 · Medium · Non-timing-safe token comparison, and `:`-delimited token maps

**Evidence:** `src/api/routes.ts:140-148` and `:174-190`

```ts
for (const pair of map.split(',')) {
  const [tok, name] = pair.split(':').map((s) => s.trim());
  if (tok && name && tok === token) return name;          // :145
}
```

Two problems:

1. **`tok === token` is a plain string comparison.** Every other token check in
   this codebase is deliberately constant-time — `requireBotAuth` uses
   `timingSafeEqual` (`:115`), `gates.ts` has `safeEqual` (`:38`), and
   `WebPanelCommandHandler` in the plugin goes as far as digesting both sides
   to avoid leaking length. This one path, which maps tokens to *staff
   identities*, opts out. The same applies to `resolveStaffActor` at `:181`.

2. **`split(':')` corrupts tokens containing `:`.** `pair.split(':')` takes only
   the first two segments, so a token with a colon in it is silently truncated
   and will never match. For `STAFF_ACTOR_TOKEN_MAP` the format is
   `token:name:role`, so any colon in a token shifts the name and role fields —
   producing a wrong role rather than a failure. Note `env.ts`'s own
   `parseKeyMap` (`:110-125`) handles this correctly with
   `indexOf(':')` + `slice`, so the right pattern already exists in the repo
   and these two functions do not use it.

**Fix direction:** route both maps through `parseKeyMap`-style parsing (split
on the first delimiter only, or move to a JSON-encoded env var), and compare
with `safeEqual`. If matching against N entries in constant time is a concern,
hash the presented token once and compare hashes.

---

## B-04 · Medium · `gates.ts` was written to unify auth and then not adopted

**Evidence:** `src/middleware/gates.ts:1-13` states the intent —

> Every trust decision becomes a named middleware with ONE implementation. …
> Routes stop hand-rolling `requireBotAuth` copies; the gates below are the only
> sanctioned entry points.

The actual adoption:

| Consumer | Uses |
|---|---|
| `src/api/v2/storeOrders.ts:27` | `requireSelfOrDelegated` — the only real consumer |
| everything else | its own thing |

Meanwhile "is this the bot token?" exists three times over:

- `src/middleware/auth.ts:78-91` — `botTokenMatches`, using `timingSafeEqual`
- `src/api/routes.ts:105-119` — `requireBotAuth`, a near-identical duplicate
- `src/middleware/gates.ts:76` — inside `resolvePrincipal`, using `safeEqual`
  (which additionally rejects zero-length, unlike the other two)

plus three one-line wrappers that add nothing but a name:
`src/api/expansion/adminViews.ts:33`, `src/api/expansion/community.ts:40`,
`src/api/expansion/webhookAdmin.ts:31`.

The three implementations are currently behaviourally equivalent for realistic
inputs, so this is not a live vulnerability — it is the *conditions for one*.
Three copies of an auth predicate is three places a fix has to land, and B-01
is a live demonstration of what happens when the security-relevant logic in
`routes.ts` evolves separately from the model in `gates.ts`.

**Fix direction:** delete `requireBotAuth` from `routes.ts` and the three
wrappers; re-export `botTokenMatches` as the single implementation and have
`resolvePrincipal` call it. Then migrate `routes.ts`'s inline checks to the
named gates, which also gives B-01 one place to be fixed instead of three.

---

## B-05 · Medium · `resolvePrincipal` re-runs on every gate in a chain

**Evidence:** `src/middleware/gates.ts:94, 106, 124`

`requireBot`, `requireSelfOrDelegated` and `requireScope` each call
`await resolvePrincipal(c)` independently. Chaining two gates on one route
therefore resolves the principal twice — and for a Bearer `imp_` key, each
resolution calls `authenticateApiKey`, which hits D1 (`:50`).

Latency aside, the deeper issue is that principal resolution is not idempotent
in an observable sense: two resolutions of the same request could disagree if
D1 is flaky mid-request, and any auditing or rate-limiting keyed off key usage
would double-count.

**Fix direction:** resolve once in a middleware that runs before the gates,
store it with `c.set('principal', p)`, and have each gate read the stored value.
This mirrors what `attachUser` already does for the session.

---

## B-06 · Medium · Delegated UUID is accepted without format validation

**Evidence:** `src/middleware/gates.ts:79` and `:113`

```ts
const asserted = c.req.header('x-mc-uuid');
if (asserted && safeEqual(...)) return { kind: 'delegated', mcUuid: asserted };
```

`asserted` is an arbitrary header string. It becomes `c.var.mcUuid` and flows
into database queries as an identity key with no shape check. The same applies
to `?uuid=` on `GET /api/player/profile` (`routes.ts:453`), which is passed
straight through.

Queries are parameterised, so this is not injection. The risks are subtler and
real: an empty or whitespace UUID may match rows unexpectedly depending on
schema; a differently-cased or unhyphenated UUID silently misses and reads as
"no data" rather than "bad request"; and the trusted-caller assumption means a
bug in the *frontend proxy* becomes a data-access bug here with no guard rail.

**Fix direction:** validate against
`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i` at the
boundary and 400 on failure. One shared `parseUuid` helper, applied to both the
delegated header and the `?uuid=` query parameters.

---

## B-07 · Low · 7-day JWT with no `jti` and no revocation

**Evidence:** `src/auth/jwt.ts:9, 27-33`

`JWT_EXPIRY_SECONDS = 7 * 24 * 60 * 60`, tokens carry no `jti`, and there is no
deny-list. `POST /auth/logout` (`routes.ts:422`) can only clear the cookie —
the token itself stays valid for the remainder of its 7 days.

The JWT implementation is otherwise good: `algorithms: ['HS256']` is pinned
against alg-confusion (`:47`), and a token missing `authMethod` is rejected
rather than defaulted (`:51-54`). This is the one gap.

Consequence: logging out does not end a session, and a captured token cannot be
invalidated short of rotating `JWT_SECRET` and signing everyone out. See F-03
and X-01 — the frontend's 400-day token makes this materially worse.

**Fix direction:** add a `jti` and check it against a short-TTL revocation set
in Redis (the infrastructure is already there — `src/db/redis.ts`) on logout and
on password/link changes. Redis being unavailable should fail closed for
revocation checks on privileged routes.

---

## B-08 · Low · Identical ternary branches in `guides.ts`

**Evidence:** `src/api/v2/guides.ts:76-77`

```ts
const stmt = category && CATEGORIES.has(category)
  ? getD1().prepare(`SELECT ... FROM guides ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(category, PAGE_SIZE, ...)
  : getD1().prepare(`SELECT ... FROM guides ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(PAGE_SIZE, ...);
```

Both branches build a byte-identical SQL string; only the `.bind()` arity
differs, and `where` already encodes the branch. Two copies of a 120-character
query template that must be kept in sync for no benefit.

**Fix direction:** build the SQL once, then branch only on the bind arguments.

---

## Not findings — verified good

Recorded so a re-audit does not re-litigate them:

- **No SQL injection.** Every dynamic fragment
  (`routes.ts:2253`, `:2418`; `adminPanel.ts:60, 135, 178`; `guides.ts:76`;
  `tickets.ts:135`) is assembled from a closed allowlist with parameterised
  values. `tickets.ts` in particular builds its `SET` clause from a hardcoded
  `allowed` table, which is the right pattern.
- **No hardcoded secrets.** Only `.env.example` is tracked.
- **JWT algorithm pinning** is correct (`auth/jwt.ts:47`).
- **`requireBotAuth` length-checks before `timingSafeEqual`**, with an accurate
  comment about why that is safe (`routes.ts:111-114`).
- **Audit attribution refuses body-supplied actors** (`routes.ts:1004-1010`) —
  the right instinct, though X-03 shows it is defeated downstream.
