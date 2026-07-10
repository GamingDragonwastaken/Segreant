# AegisFlow team server

A separate, optional, BYO-Postgres server for AegisFlow's team tier. **AegisFlow
hosts nothing** — you run this on infrastructure you already own and trust: your
server, your Postgres, eventually your SSO. See
[`docs/TEAM-TIER-DESIGN.md`](../docs/TEAM-TIER-DESIGN.md) in the main repo for
the full design reasoning.

This is a genuinely separate package (its own `package.json`) so the main
`aegisflow` CLI/proxy stays at zero runtime dependencies. `pg` (the standard
Postgres driver) lives only here.

## What this does today

Developers run `aegisflow team push --url <this-server-url>` to sign and push a
numeric-only, per-project value/RoI snapshot (no prompt/response content, no raw
request log). This server verifies each push's ed25519 signature against a
registered developer key and stores it in Postgres.

Human-facing requests are authenticated too: `GET /me` verifies an OIDC
ID token (RS256/ES256 — any standard-compliant issuer: Okta, Entra ID, Google
Workspace, Auth0, ...) against your configured issuer and returns the verified
identity.

That same OIDC gate now protects two real aggregate routes: `GET
/dashboard/projects` (team-wide spend/realization/RoI, summed across every
developer, grouped by project) and `GET /dashboard/developers` (an opt-in,
k-anonymized distribution of per-developer spend and realization — never a
named list). See "Privacy model for the dashboard routes" below — this is the
part that needed the most care, not the SQL.

**Not yet built:** a UI. These are JSON APIs; a rendered dashboard that calls
them is out of scope for this release (`docs/TEAM-TIER-DESIGN.md` §1). Linking
an OIDC identity to a specific developer keyId (for a genuine "my own numbers"
self-view) is also not built — registration only records a `label` an admin
chooses, with no claim/verification step tying it to whoever logs in.

## Running it

```sh
cd team-server
npm install
DATABASE_URL="postgres://user:pass@host:5432/aegisflow_team" \
TEAM_SERVER_ADMIN_TOKEN="<a long random secret>" \
PORT=8092 \
npm start
```

Environment variables:

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Postgres connection string. The schema (`schema.sql`) is applied automatically and idempotently on every boot. |
| `TEAM_SERVER_ADMIN_TOKEN` | no, but registration is disabled without it | Bearer token gating `POST /developers`. Without it, no new developer keys can be registered — fails closed, not open. |
| `OIDC_ISSUER_URL` | no, but `/me` (and future authenticated routes) is disabled without it | Your SSO provider's issuer URL, e.g. `https://your-org.okta.com` or your Entra tenant URL. |
| `OIDC_CLIENT_ID` | required alongside `OIDC_ISSUER_URL` | The `aud` claim your ID tokens carry — register this server (or a "team dashboard" app) with your provider to get one. |
| `OIDC_JWKS_URL` | no | Pins the JWKS endpoint directly, skipping OIDC discovery. Usually unnecessary — discovery via `<issuer>/.well-known/openid-configuration` finds it automatically. |
| `TEAM_SERVER_EXPOSE_DEVELOPER_BREAKDOWN` | no (default off) | Set to exactly `true` to turn on `GET /dashboard/developers`. Off by default — opt-in, same fail-closed posture as `TEAM_SERVER_ADMIN_TOKEN`. |
| `TEAM_SERVER_MIN_COHORT` | no (default `5`) | The k-anonymity floor: `/dashboard/projects` withholds any single project's numbers if fewer than this many distinct developers contributed to it, and `/dashboard/developers` withholds its whole distribution below this many total developers. Same default `cohort.ts` already uses for the single-machine per-user value feature. |
| `PORT` | no (default `8092`) | Listen port. |
| `HOST` | no (default `0.0.0.0`) | Listen address. Unlike AegisFlow's own local dashboard, this server is *meant* to be reached across your network. |

This process speaks plain HTTP. Put a reverse proxy (nginx, Caddy, your cloud
load balancer) in front of it for TLS — that's your infrastructure's job, not
this process's; see `docs/TEAM-TIER-DESIGN.md` §1's "AegisFlow provides the
software, never the operation" framing.

## Registering a developer

Each developer publishes their rollup-signing identity once:

```sh
aegisflow team push --pubkey
```

An admin then registers it with the team server:

```sh
curl -X POST https://your-team-server/developers \
  -H "authorization: Bearer $TEAM_SERVER_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"keyId": "<from --pubkey>", "publicKey": "<from --pubkey>", "label": "alice-laptop"}'
```

Registration is deliberately not automatic on first push — a rollup's
signature proves internal self-consistency, not who a `keyId` actually belongs
to. Without an explicit registration step, anyone could self-sign a fabricated
rollup with a freshly generated keypair and have it accepted. See
`src/server.ts`'s header comment and `src/store.ts`'s schema comments for the
full reasoning.

## Endpoints

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/health` | GET | none | Liveness check. |
| `/developers` | POST | admin bearer token | Register a developer's rollup-signing public key. |
| `/rollups` | POST | the rollup's own signature, pinned to the registered key | What `aegisflow team push` calls. |
| `/me` | GET | OIDC bearer ID token | Verifies your SSO login and echoes back the verified identity. |
| `/dashboard/projects` | GET | OIDC bearer ID token | Team-wide totals per project (units, cost, realized value, RoI Index), optionally windowed with `?periodFrom=`/`?periodTo=` (ISO 8601). Any project with fewer than `TEAM_SERVER_MIN_COHORT` contributing developers reports `suppressed: true` with no numbers. |
| `/dashboard/developers` | GET | OIDC bearer ID token | A k-anonymized distribution (median/p25/p75) of per-developer spend and realization. `enabled: false` unless `TEAM_SERVER_EXPOSE_DEVELOPER_BREAKDOWN=true`; `suppressed: true` below the cohort floor either way. Never a named list. |

## Privacy model for the dashboard routes (`src/aggregate.ts`)

OIDC answers "is this a real, authenticated team member?" — it does not by
itself answer "is this specific number safe to hand back even to a real team
member?" `src/aggregate.ts` is the second gate, applied after OIDC succeeds,
and it mirrors a discipline this codebase already established for the
single-machine case: per-user *value* (not raw spend) is the sensitive axis
(see the main repo's `src/value/cohort.ts`), and it only ever surfaces as an
opt-in, k-anonymized distribution — never a name attached to a number.

- **`/dashboard/projects` needs no separate opt-in** — team-wide spend by
  project is the core, expected FinOps view this feature exists for. But each
  project is suppressed *individually* if it has too few contributors: if only
  one developer has ever pushed a rollup touching "Project X", that project's
  team-wide total just **is** that one developer's personal total under
  another name — the same re-identification risk `cohort.ts` guards against,
  one level down. `TEAM_SERVER_MIN_COHORT` (default 5) is the floor.
- **`/dashboard/developers` is opt-in AND k-anonymized** — a genuine
  per-developer number (even anonymized into a distribution) is a closer
  analogue to `cohort.ts`'s "value by user," so it gets both of that
  feature's gates, not just one: disabled by default
  (`TEAM_SERVER_EXPOSE_DEVELOPER_BREAKDOWN`), and even when enabled, the
  response is a **distribution only** (median/p25/p75 of cost and realized-
  value-rate) — no `keyId`, no `label`, no ranked list, ever.
- **The math is weighted, not naively averaged.** A project's realization
  rate is `SUM(realizedUnits)/SUM(units)` across every contributing rollup —
  the same unit-count metric `ProjectValue.realizationRate` means everywhere
  else in this codebase, not a differently-defined dollar ratio that happens
  to share a name. RoI Index is averaged cost-weighted, and a rollup with no
  RoI Index (untested project) is excluded from both the numerator and
  denominator, not treated as a zero. `test/server.test.ts`'s weighting test
  uses hand-computed numbers precisely to catch a naive-average regression —
  see its comments for the arithmetic.

## Security notes on the OIDC verification (`src/oidc.ts`)

Hand-rolled against `node:crypto` — no `jsonwebtoken`/`jose` dependency, so
`pg` stays this package's only one. Two easy-to-get-wrong details it handles
explicitly:

- **Algorithm whitelist.** Only `RS256`/`ES256` are accepted. A token with
  `alg: "none"` (a real historical JWT vulnerability class) is rejected
  outright, as is `HS256` — accepting HMAC here would allow an "algorithm
  confusion" attack where an attacker signs a forged token using the issuer's
  *public* RSA key as an HMAC secret.
- **ES256 signature encoding.** JWT ES256 signatures are raw `r‖s` (IEEE
  P1363), not the DER/ASN.1 encoding `node:crypto` uses by default for ECDSA —
  handled via the `dsaEncoding: 'ieee-p1363'` option. Getting this wrong
  silently rejects every genuine ES256 token.

## Testing

```sh
npm test        # HTTP + crypto tests against fakes — no Postgres or real IdP needed
npm run typecheck
```

`npm test` proves the auth, signature-verification, aggregation, and routing
logic without a live database (`test/fakeStore.ts` stands in for Postgres,
implementing the exact same weighting semantics as the real SQL — see its
header comment) and without a real SSO provider (`test/fakeIdp.ts` runs a real
local OIDC-shaped server, signing tokens with genuine RS256/ES256 keypairs, so
`oidc.ts` is proven against real signatures, not just assumed to work). 39
tests total: `test/aggregate.test.ts` covers the privacy-gating logic in
isolation (k-anonymity boundaries, the opt-in gate, the $0-cost rate-exclusion
edge case), and `test/server.test.ts`'s dashboard tests push hand-computed
rollups through the real HTTP layer and assert exact expected numbers — chosen
specifically so a naive (unweighted) average would produce a *different*,
wrong answer, not just an untested one.

It does not exercise `schema.sql` or the real SQL in `src/store.ts`'s
`PgRollupStore` (including the two new aggregate queries) against an actual
database — Docker wasn't available to verify this against a live Postgres
instance either time this package was built. Verify against your own Postgres
instance (or a local `docker run -e POSTGRES_PASSWORD=x -p 5432:5432
postgres`) before relying on this in production; the SQL was hand-reviewed
line-by-line against the same weighting the fake store's tests prove (see
`src/store.ts`'s `aggregateProjects`/`aggregateDevelopers` comments), but
"reviewed" is not "executed."
