# Cross-Repo Integration — Findings

The seams between the three services. These are the findings that no
single-repo review would surface, because each side is locally reasonable and
the defect only exists in the gap.

## The trust topology

```
  Browser
    │  cookie: auth_token  (HS256, JWT_SECRET, 400-day TTL)
    ▼
  imperium-frontend  ──────────────────────────────────────┐
    │  _guard.ts: resolves LuckPerms role per request       │
    │  headers: X-Bot-Token, X-Admin-Uuid                   │
    │           (never X-Staff-Token / X-Staff-Actor)       │
    ▼                                                       │
  imperium-backend                                          │
    │  verifies X-Bot-Token; resolves "staff actor"          │
    │  ALSO accepts imperium_session cookie                  │
    │  (HS256, same JWT_SECRET, 7-day TTL)  ◀────────────────┘
    │  Redis command bus, HMAC-SHA256
    ▼
  ImperiumMC-Plugin
       WebPanelCommandHandler → Bukkit.dispatchCommand()
```

Three trust hops, three different mechanisms, and the weakest link decides.

---

## X-01 · High · One `JWT_SECRET` shared across two independent JWT implementations

**Evidence:** `imperium-frontend/src/lib/jwt.ts` (hand-rolled Web Crypto
HS256) and `imperium-backend/src/auth/jwt.ts` (`jose`), both keyed on
`JWT_SECRET`, plus
`imperium-frontend/src/lib/session.ts:88-99`:

```ts
export function sessionForwardHeaders(request: Request): HeadersInit {
  const token = cookies[AUTH_COOKIE];       // the site's auth_token
  return {
    ...(token ? { Cookie: `imperium_session=${token}` } : {}),
    ...(BOT_TOKEN ? { 'X-Bot-Token': BOT_TOKEN } : {}),
  };
}
```

The frontend deliberately forwards its own cookie under the backend's cookie
name, justified in-comment as "same shared `JWT_SECRET`, same claims". That
works — and creates three problems:

1. **The frontend's 400-day TTL overrides the backend's 7-day policy.** The
   backend sets `JWT_EXPIRY_SECONDS = 7 days` (`auth/jwt.ts:9`) for tokens it
   issues, then accepts a forwarded frontend token whose `exp` is up to 400 days
   out. `verifyJwt` only checks that `exp` is in the future — it has no maximum.
   The backend's session policy is therefore unenforceable in practice.

2. **Two implementations, one key, no shared test.** The frontend hand-rolls
   base64url, HMAC and expiry checking; the backend uses `jose` with pinned
   algorithms. Any divergence in claim handling becomes a cross-service
   authorization difference. Neither repo has a test asserting that a token
   signed by one verifies identically in the other.

3. **Blast radius.** A `JWT_SECRET` disclosure from either service forges
   sessions for both. There is no key separation and no key ID, so rotation is
   an all-or-nothing simultaneous deploy.

**Fix direction:** decide which service is the identity provider and make the
other a pure consumer. Minimum viable: add a `kid` header and an issuer claim so
the two token families are distinguishable and separately rotatable; have the
backend reject a forwarded token whose `exp` exceeds its own maximum lifetime.

---

## X-02 · Medium · Principal precedence: a session cookie shadows a valid bot token

**Evidence:** `imperium-backend/src/middleware/gates.ts:56-90` resolves in the
order *bearer key → session cookie → bot token*, and returns on the first match.
`imperium-frontend/src/lib/session.ts:96-97` sends **both** a session cookie and
`X-Bot-Token` on the same request.

So for any route gated by `gates.requireBot`, a request from a logged-in user
resolves to `kind: 'session'`, never reaches the bot branch, and is refused —
even though it carries a perfectly valid bot token. Symmetrically, in
`requireSelfOrDelegated` (`:106-119`) the session branch is evaluated before the
delegated branch, so an asserted `X-Mc-Uuid` is silently ignored whenever a
session cookie is present.

This is currently **latent**: `gates.requireBot` has no route consumers yet, and
`requireSelfOrDelegated` has exactly one (`v2/storeOrders.ts:27`), where the
session path usually resolves the same UUID the header would have asserted. It
is filed because the trap is already built — the first route that adopts
`requireBot` will fail for exactly the users who are logged in, which is the
hardest failure mode to reproduce from a terminal.

**Fix direction:** make precedence explicit rather than incidental. Either have
the frontend stop sending both credentials on one request, or make the gates
select the principal *appropriate to the gate* — `requireBot` should look for
the bot token regardless of what else is attached.

---

## X-03 · Medium · Audit attribution is defeated end-to-end; every legitimate action logs a spoof warning

**Evidence:** `imperium-frontend/src/app/api/admin/punish/route.ts:68-70` sends

```ts
'X-Admin-Uuid': guard.session.uuid,
body: { ..., actor: guard.session.discordUsername ?? guard.session.uuid }
```

and `imperium-backend/src/api/routes.ts:1004-1010` receives it:

```ts
const resolvedActor = resolveActorFromToken(c);
if (body.actor && body.actor !== resolvedActor) {
  logger.warn({ claimed: body.actor, resolved: resolvedActor },
    'AUDIT SPOOF ATTEMPT: body actor differs from token-derived identity — body value discarded');
}
```

The backend is right to distrust a body-supplied actor. But the frontend still
sends one, and `X-Admin-Uuid` — the header that actually carries the
LuckPerms-verified human identity the frontend went to the trouble of resolving
— **is not read anywhere in the backend**.

Net effect on every real moderation action:

- The audit log records the actor as `panel-service`, not the human.
- A `WARN`-level "AUDIT SPOOF ATTEMPT" line is emitted for each legitimate ban,
  because the frontend's honest actor never matches the token-derived one.
- The one signal designed to detect actual spoofing fires 100% of the time on
  legitimate traffic, so it is unusable — a real attack would be indistinguishable
  from Tuesday.

The feature was built correctly on both sides of a boundary neither side
crosses.

**Fix direction:** have the backend read `X-Admin-Uuid` as the attributed actor
*when the request is authenticated as the panel service*, and have the frontend
stop sending `actor` in the body. Then the spoof warning becomes meaningful
again, because it will only fire when someone actually spoofs.

---

## X-04 · Medium · The frontend never sends staff headers, so all admin traffic takes the B-01 exempt path

**Evidence:** `grep -rn "X-Staff-Token|X-Staff-Actor" imperium-frontend/src`
returns nothing. The backend's role gates read exclusively from those headers
(`routes.ts:176-177`).

The backend built a three-tier RBAC — helper / mod / admin — with per-staff
tokens, name-binding to prevent header reuse, and role gates on the three
sensitive routes. The frontend, which is the only thing that actually calls
those routes, sends none of it. Every request therefore falls through to
`resolveActorFromToken` → `'panel-service'` → the unconditional exemption at
`routes.ts:198`.

So B-01 is not a theoretical bypass sitting behind an unused code path. It is
**the only path in production**. The RBAC has never restricted a single request.

This also explains why B-01 has gone unnoticed: from the panel, everything
works, because everything is exempt.

**Fix direction:** X-04 and B-01 must be fixed together, and in this order —
first give the panel a way to assert a verified role that an attacker cannot
assert by omission (the frontend already has the LuckPerms-confirmed role in
`guard.session.perms`), then remove the `panel-service` exemption. Doing B-01
alone locks staff out of the panel; doing X-04 alone changes nothing, because
the exemption still short-circuits.

---

## Cross-cutting observation: audits that stopped at the boundary

Four of these findings share a shape. In each case, one repo implemented a
security control carefully — with good comments, correct local logic, and
clearly a real review behind it — and the control does nothing because the other
side of the boundary was never updated:

| Control | Built in | Defeated by |
|---|---|---|
| Staff RBAC (helper/mod/admin) | backend | frontend never sends the headers (X-04) |
| Body-actor spoof detection | backend | frontend still sends a body actor (X-03) |
| Split bot/service tokens | backend | unreachable branch (B-02) |
| 7-day session policy | backend | frontend's 400-day forwarded token (X-01) |

The pattern is worth naming for whoever works on this next: **a change to a
trust boundary is not done when one side compiles.** Each of these would have
been caught by a single integration test exercising the real header set the
frontend actually sends. There is currently no such test in any of the three
repos.
