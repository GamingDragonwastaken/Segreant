# Hosted team tier — design scope, now built end to end

**Status: BUILT, 2026-07-10.** All four planned slices are implemented and
tested. The client side of §2's recommended design — signed rollup pushes,
reusing `value/receipt.ts`'s primitives — is `src/team/rollup.ts`
(`buildRollupBody`/`signRollup`/`verifyRollup`) and the `aegisflow team push`
CLI command. **§1's server** exists as a genuinely separate deployable:
`team-server/` (its own `package.json`, `pg` as its only dependency, never
touching the main CLI's zero-dependency footprint). It ingests and verifies
pushed rollups against Postgres. **§3's OIDC verification** —
`team-server/src/oidc.ts` verifies ID tokens against a configured
issuer/JWKS, tested against genuine RS256/ES256 signatures via an in-process
fake IdP. **The aggregate dashboard API** — `GET /dashboard/projects` and
`GET /dashboard/developers`, both OIDC-gated, both additionally passed
through `team-server/src/aggregate.ts`'s privacy layer before anything is
returned. See the "What actually shipped" callouts in §1–§4.
**What remains out of scope:** a rendered dashboard UI that calls these APIs,
and any link between an OIDC identity and a specific developer's `keyId` (so
there's still no "see my own numbers" self-view — see §1's callout). This was
originally scoped work only, written because the user asked to scope the
shape of a cross-machine team tier *without* building it: "not scoped for
this release... revisit only if real usage and requests justify the
operational commitment." A later session reversed that instruction and
directed the whole team tier to be built in sequenced, verified slices —
client push, then server ingest, then OIDC verification, then aggregate
reads — and all four are now done. This doc exists so the design work
doesn't start from zero, and so the shape decided here doesn't get
contradicted by unrelated changes in the meantime.

## The problem this actually has to solve

"Team tier" sounds like one feature. It's two, and they're different sizes:

1. **Where does it run, and who logs in?** This is a deployment/hosting/auth
   question. Bounded, well-trodden, mostly a matter of picking the right off-the-shelf
   pattern.
2. **How do N developers' independent local SQLite files become one team view?**
   This is a data-model question specific to how AegisFlow is actually built today —
   every install has its own local, unsynced SQLite store, with no concept of
   identity or a shared server anywhere in the current design. This is the harder,
   AegisFlow-specific half, and it's the half that determines whether "team tier" is
   a thin wrapper or a real new subsystem.

Both need answering before this is buildable. §1 below answers the first. §2 answers
the second — it's the one that actually decides how big this feature is.

## 1. Deployment model: bring-your-own-everything

The user's framing (2026-07-10): don't host anything ourselves. Build AegisFlow so an
enterprise that wants a team tier can stand it up entirely on infrastructure *they*
already trust — their server, their hosting, their SSO provider — with AegisFlow
providing the software, never the operation.

This is a better answer than the two alternatives:

- **AegisFlow-hosted SaaS** — was already ruled out by the existing roadmap language
  ("requires an operator: ongoing hosting, and a support commitment"). Directly
  violates the zero-dollar-cost ceiling and turns AegisFlow into a company with an
  uptime obligation, not a tool.
- **A pure design doc with no code** (the original "scope it, don't build it"
  framing before this session's refinement) — leaves "ready for a team tier" as an
  unverified claim. A reader has no way to tell if the local store and schema
  actually support this or if that's aspirational.
- **BYO-server / BYO-hosting / BYO-SSO** (this proposal) — AegisFlow ships as
  software an enterprise deploys on infrastructure they already have and already
  trust. No hosting bill on either side. No new secret-handling surface for
  AegisFlow — an enterprise's SSO credentials and server never touch anything
  AegisFlow operates, because AegisFlow operates nothing. Consistent with the
  existing "connect, don't intercept" and local-first positioning; it just moves
  "local" from one laptop to one server the *team* controls, not us.

**Concretely, this means the team-tier component is a separate,
optional, standalone deployable** — not a feature flag inside the existing
single-user `aegisflow` CLI/proxy. A small server binary the
enterprise runs (bare process, Docker image, whatever — deployment mechanics are
the enterprise's choice, not ours), configured entirely through environment
variables: a database connection string they provide, and (in a later slice)
an SSO issuer config (§3). AegisFlow's job is to make that binary correct and
easy to stand up; the enterprise's job is everything downstream of `docker run`.

> **What actually shipped (this session):** exactly this shape. `team-server/`
> is a real, separate npm package — its own `package.json`, `pg` as its only
> dependency, never pulled into the main `aegisflow` CLI's install. It reads
> `DATABASE_URL` (required), `TEAM_SERVER_ADMIN_TOKEN` (optional but
> registration is disabled — fails closed, not open — without it), `PORT`, and
> `HOST` from the environment, applies `schema.sql` idempotently on every boot,
> and listens for pushed rollups. Unlike AegisFlow's own dashboard (loopback-
> only), this server defaults to `0.0.0.0`: it exists specifically to be
> reached from developer machines across a network. TLS termination is left to
> whatever the enterprise puts in front of it (reverse proxy, load balancer) —
> this process speaks plain HTTP by design, matching "AegisFlow provides the
> software, never the operation." Full detail in `team-server/README.md`.
>
> **The aggregate dashboard API also now exists** — `GET /dashboard/projects`
> and `GET /dashboard/developers`, both gated by the same OIDC bearer-token
> check as `GET /me`. Getting the SQL right took more care than expected:
> `ProjectValue.realizationRate` (the metric shown everywhere else in this
> codebase) is a *unit-count* ratio (`realizedUnits/units`), not a dollar
> ratio — a naive `SUM(realizedValueUsd)/SUM(costUsd)` at the team level would
> have silently redefined what "realization rate" means between the
> single-machine dashboard and the team view, exactly the class of bug
> `docs/`'s earlier "value-math consistency" work existed to catch. The fix:
> `SUM(realizationRate_i * units_i)/SUM(units_i)` — algebraically exact,
> because `realizationRate_i * units_i = realizedUnits_i` by definition, and
> it needed no schema change or new stored column. RoI Index is averaged
> cost-weighted, with untested projects (`roiIndex: null`) excluded from both
> the numerator and denominator rather than treated as zero. Separately, and
> more importantly for a *multi-developer* view: a project's team-wide total
> is only ever shown if at least `TEAM_SERVER_MIN_COHORT` (default 5) distinct
> developers contributed to it — otherwise a lone contributor's project total
> just *is* their personal total under another name, the same
> re-identification risk `src/value/cohort.ts` already exists to prevent for
> the single-machine case, one level down. `GET /dashboard/developers` gets
> `cohort.ts`'s full treatment: opt-in (`TEAM_SERVER_EXPOSE_DEVELOPER_BREAKDOWN`,
> default off) *and* k-anonymized, returning a distribution (median/p25/p75)
> and never a named list. One honest limit on that gate: **k-anonymity is a
> minimum bar, not a complete leakage defense.** Under REPEATED releases it is
> vulnerable to differencing — two snapshots straddling one developer's
> join/leave can expose that developer's contribution as the delta between two
> individually-suppressed-compliant aggregates. Mitigations (release-interval
> floors, suppressing deltas below the cohort floor, or noise à la differential
> privacy) are deliberately left to the team-server operator, who controls
> release cadence; the design's contribution is naming the risk instead of
> letting "k-anonymous" imply more than it guarantees. `team-server/src/aggregate.ts` holds this privacy
> logic as pure, HTTP- and DB-free functions; `team-server/test/aggregate.test.ts`
> tests it in isolation (9 tests: exact-floor boundaries, the opt-in gate, a
> $0-cost developer correctly excluded from the rate distribution without being
> folded in as a zero), and `team-server/test/server.test.ts` proves the real
> weighted math end to end with hand-computed numbers chosen so a naive,
> unweighted average would land on a visibly different (wrong) answer. Honest
> gap, same as §2's: the real SQL (`store.ts`'s `aggregateProjects`/
> `aggregateDevelopers`) was hand-reviewed against the exact same weighting the
> fake-store tests prove, but — Docker again unavailable — not executed
> against a live Postgres this session either. See `team-server/README.md`'s
> "Privacy model for the dashboard routes" section for the full reasoning.

## 2. The hard part: from N local stores to one team view

This is the question the BYO-server idea doesn't answer by itself, and it's the one
that actually determines feature size. Today, `aegisflow`'s entire data model is one
local SQLite file per machine (`src/store/db.ts`), written only by that machine's own
proxy/import/scan commands, read only by that machine's own CLI/dashboard. There is no
identity concept anywhere in the schema — no user table, no auth, nothing to key a
"team" on. Three ways to close that gap, in the order they were considered:

**Rejected — shared remote Postgres, every machine writes directly.** Replace local
SQLite with a network write on every metered request. Rejected because it puts a
network call and a live server dependency in the *hot path* of every single AI
request — the one place this project has been deliberately, repeatedly careful to
keep local-only and network-free (see ARCHITECTURE.md's own design-choices list:
"transparent fail-open on upstream errors," zero-external-requests-by-default
throughout). A hung or unreachable team server would mean a hung or unreachable
coding session. Not an acceptable trade for a feature that's explicitly opt-in and
non-core.

**Rejected — sync/merge the raw SQLite files.** Upload each machine's database (or a
CRDT-merged view of it) to the team server. Rejected because it's a strictly bigger
data-exposure surface than the feature needs: a team dashboard needs aggregate
numbers (spend by project, by developer, RoI trends), not the full per-request
ledger. Shipping raw or merged databases also contradicts the existing, already-
shipped privacy posture for the *single-user* multi-developer case — the current
"opt-in, k-anonymous per-user value" feature (README Status section) already chose
aggregate-and-consented over raw-and-complete once; a team-sync feature that
regressed to raw file transfer would be inconsistent with that precedent.

**Recommended — periodic signed rollup pushes, reusing the existing receipt
primitive.** Each local install already computes aggregate rollups for its own
dashboard (`store.summary`, `store.byUser`, `store.bySource`, the RoI Index). Extend
this with a command (`aegisflow team push`, or an opt-in background interval) that
takes a rollup for a period — numeric-only: total spend, per-project spend, RoI
components, no prompt/response content, no raw request log — and signs it with the
**same ed25519 primitive `src/value/receipt.ts` already implements** (`KeyPair`,
`canonical()`, `signReceipt`, `verifyReceipt`, already tested: signature tampering
detection, key-pinning against forged keys). This isn't a new crypto subsystem; it's
the existing "verifiable claim without trusting the source" pattern — built for
per-commit value receipts — pointed at a new payload shape (a period rollup instead
of a per-commit body). The team server's job becomes: accept a signed rollup, verify
it against a known key (each developer's public key registered once, e.g. at
onboarding), store it, and serve an aggregate dashboard over the accumulated
rollups. The proxy hot path never changes — pushing a rollup is a periodic,
async, out-of-band operation, exactly as disconnected from request-serving as
`aegisflow pricing --refresh` already is today.

> **What actually shipped (this session):** exactly this, on the client side.
> `src/team/rollup.ts` defines `RollupBody`/`SignedRollup` and
> `buildRollupBody`/`signRollup`/`verifyRollup`, importing `canonical` and
> `keyIdForPem` from `value/receipt.ts` directly rather than reimplementing
> them — canonicalization must be byte-identical between signer and verifier,
> so that one piece is genuinely shared; `verifyRollup` itself is a parallel
> implementation of `verifyReceipt`'s two-tier integrity/authenticity contract
> (kept separate so a change for one payload shape can't silently regress the
> other). One deviation from this doc's own sketch in §4: the rollup uses a
> **separate keypair** (`team-key.json`, distinct from `receipt-key.json`) —
> a commit receipt's key may be shared per-commit with any reviewer, while a
> team-rollup key is a longer-lived "this is developer X's machine" identity
> registered once with a team server; conflating them would leak one trust
> domain into the other. `aegisflow team push` is the CLI surface: `--url`
> to push, `--dry-run` to preview the signed payload without sending,
> `--pubkey` to print this machine's rollup identity for registration,
> `--window`/`--project` to scope the period and filter. 5 adversarial tests
> in `test/team-rollup.test.ts` (tamper detection via body-hash mismatch, key
> pinning against a self-consistent forgery, a forged keyId claim, a garbled
> public key).
>
> **A receiving server now exists too** (`team-server/`, its own `package.json`,
> `pg` as its sole dependency). `POST /rollups` looks up the claimed `keyId`
> against an explicit `developers` allowlist (registration is admin-gated, not
> automatic-on-first-push — see `team-server/schema.sql`'s comments for why:
> a signature only proves internal self-consistency, not who a keyId actually
> belongs to), then verifies with `trustedPublicKeyPem` pinned to the
> *registered* key, never the one embedded in the payload. 9 HTTP-level tests
> in `team-server/test/server.test.ts`, run against a real `http.Server` with
> an in-memory `FakeRollupStore` standing in for Postgres — the same
> test-through-a-real-interface-boundary approach used for judge/upstream
> endpoints elsewhere in this project. **Honestly unverified:** the real SQL
> in `PgRollupStore` (`team-server/src/store.ts`) and `schema.sql` were code-
> reviewed but not exercised against a live Postgres instance this session —
> Docker wasn't running locally when this was built. Verify against a real
> database before production use; see `team-server/README.md`.

This is the one open design question with more than one reasonable answer, so it's
flagged as a recommendation, not a decision: the alternative worth naming is a
**pull model** (team server periodically fetches each machine's rollup over a
port it exposes) instead of the **push model** described above. Push was preferred
here because it doesn't require any machine to run a listening server or be
network-reachable — a laptop that's asleep or behind a firewall just pushes
whenever it's next online, no inbound connectivity needed anywhere. This mirrors
how `git push` works and avoids reintroducing exactly the kind of "always-on local
listener" surface the base-URL-proxy design already avoided once (see the MITM-proxy
rejection in [docs/RESEARCH-REVIEW.md](RESEARCH-REVIEW.md)).

## 3. SSO extension point: one generic protocol, not N integrations

"Bring your own SSO provider" only stays zero-maintenance if AegisFlow implements
**one** thing — a standard protocol — rather than N provider-specific integrations
(Okta SDK, Azure AD SDK, Google Workspace SDK, ...), each with its own quirks and
ongoing support burden. The standard that fits: **OIDC (OpenID Connect)**. Every
major enterprise SSO provider already speaks it natively — Okta, Microsoft Entra ID
(Azure AD), Google Workspace, Auth0, OneLogin, and effectively everything else in
this space either is an OIDC provider or fronts one.

Concretely, the team-server component would be a generic OIDC **relying party**:
verify an incoming JWT against a configured issuer URL and JWKS endpoint, extract an
identity claim, done. No enterprise-specific code, ever — the enterprise points their
existing OIDC-compliant SSO at a config block (issuer URL, client ID, maybe a JWKS
cache TTL) and it works, because OIDC compliance was already the provider's job, not
ours. This is the same "reuse the standard instead of the vendor" instinct already
used elsewhere in this project (the METR citation instead of an invented number, the
LiteLLM community pricing feed instead of a bespoke one) — apply it to auth too.

> **What actually shipped (this session):** exactly this, as `team-server/src/
> oidc.ts`'s `verifyIdToken`, using `node:crypto` only (no `jsonwebtoken`/`jose`
> dependency — resolves the technical concern raised when this build was
> scoped). Config is `{issuerUrl, clientId, jwksUrl?}`, matching this doc's own
> §4 sketch exactly; `jwksUrl` is optional — when omitted, discovery hits
> `<issuer>/.well-known/openid-configuration` to find it, with the JWKS itself
> cached (default 10 min TTL) so steady-state verification doesn't refetch per
> request. Wired into a real route (`GET /me`) rather than left as an untested
> library function, so the auth middleware is proven to compose with the HTTP
> layer, not just verified in isolation.
>
> Two easy-to-get-wrong security details, handled explicitly and tested against
> **genuine** RS256/ES256 signatures (a real in-process fake IdP,
> `team-server/test/fakeIdp.ts`, signs test tokens with real keypairs — this
> isn't just "the code compiles," both sides were proven to interoperate):
> the algorithm is whitelisted to RS256/ES256 only, rejecting both `alg:
> "none"` (a real historical JWT vulnerability) and HS256 (which would open an
> algorithm-confusion attack using the issuer's own public RSA key as a forged
> HMAC secret); and ES256 signatures are verified with `dsaEncoding:
> 'ieee-p1363'`, since JWT's raw-`r‖s` ECDSA encoding differs from
> `node:crypto`'s DER default — getting this wrong silently rejects every
> genuine ES256 token, which is exactly the kind of bug real signature-fixture
> tests catch and a compile-only check would miss. 12 tests in
> `team-server/test/oidc.test.ts` plus 3 HTTP-level tests for `GET /me` in
> `server.test.ts`. **Not built:** anything a dashboard would actually call
> this for — `/me` proves the auth layer works, but there's no aggregate data
> behind it yet (that's this doc's remaining, separately-tracked scope).

## 4. What "ready for this" would look like in code

**The `RollupPush` half of this sketch is now superseded by what actually
shipped** — `src/team/rollup.ts`'s real `RollupBody`/`SignedRollup`, which turned
out slightly more capable than sketched here: one rollup carries the *array* of
every project's full `ProjectValue` breakdown for the period (reusing
`value/realization.ts`'s already-computed shape directly) rather than one
flattened `costUsd`/`roiIndex` pair per project per push:

```ts
// src/team/rollup.ts — as built, not as sketched.
interface RollupBody {
  v: 1;
  keyId: string;                    // the pushing developer's team-rollup key fingerprint
  generatedAt: string;
  period: { from: string; to: string };
  projects: ProjectValue[];         // numeric-only; the full per-project breakdown, one push
  strata?: ProjectTaskStratum[];    // optional, additive: project × task-type counts/dollars,
                                    // so the server can standardize on a FIXED task basket
                                    // (src/team/standardize.ts) — without this grain, any
                                    // cross-developer or over-time ranking is at the mercy of
                                    // task-mix differences (Simpson's paradox). Absent from
                                    // rollups pushed by older clients; same disclosure class
                                    // as `projects` (no content, counts and dollars only).
}
interface SignedRollup {
  body: RollupBody;
  bodyHash: string;                 // sha256 of canonical(body), hex — tamper detection
  keyId: string;
  publicKey: string;                // PEM (spki)
  signature: string;                // base64 ed25519
}
```

**`TeamServerConfig` (the receiving side) is still exactly a sketch — not
written.** This is §1/§3's remaining scope (tasks tracked separately: server
scaffold + Postgres schema, then OIDC/JWT verification, then aggregate dashboard
queries):

```ts
// A team-server config — all of it points at infrastructure the enterprise
// already owns; none of it names a specific vendor. NOT YET BUILT.
interface TeamServerConfig {
  databaseUrl: string;       // Postgres connection string the enterprise provides
  oidc: {
    issuerUrl: string;       // e.g. https://your-org.okta.com, or Entra tenant URL
    clientId: string;
    jwksUrl?: string;        // derived from issuerUrl if omitted (OIDC discovery)
  };
}
```

The local store and schema were already noted in ARCHITECTURE.md as designed so
this "could be added later without touching the hot path" — the shipped half is
the first real check of that claim, and it holds: nothing in `src/team/rollup.ts`
or the `aegisflow team push` command touches `src/proxy/server.ts` or any
per-request code path. It's additive: one new command, and (still to come) one
new, separate, optional server binary.

## What this doc does NOT decide

- **Whether to build it at all.** Originally gated on the same signal the
  roadmap item named: real usage and requests, not speculative enterprise
  appeal. A later session overrode that gate by explicit user direction, and
  all four slices — client, server ingest, OIDC, aggregate reads — are now
  built (see status banner above) on that same explicit-direction basis, not
  a change in the original usage-signal policy itself.
- **The team dashboard's UI/UX.** The data (`GET /dashboard/projects`, `GET
  /dashboard/developers`) is now real and readable; a rendered frontend that
  calls these APIs is still out of scope for this release.
- **Linking an OIDC identity to a specific developer's `keyId`.** Registration
  (`POST /developers`) records an admin-chosen `label`, not a claim tied to
  whoever logs in via OIDC — so there's no "these are MY numbers" self-view,
  only the team-wide aggregate and (opt-in) anonymized distribution. Would
  need its own claim/verification flow; not scoped here.
- **Multi-team / multi-org isolation within one server instance**, RBAC beyond "is
  this an authenticated team member," or billing/seat-count logic — all of that is
  downstream of the two questions this doc actually answers (deployment model,
  aggregation model) and shouldn't be designed before those are validated.
- **The exact rollup period/cadence.** Resolved narrowly, not fully: `aegisflow
  team push` is on-demand only (a `--window <days>` flag picks the lookback, run
  whenever the developer or a cron job invokes it). No opt-in background
  interval exists yet — that remains an open, deferred question.

## Revisit condition

Originally: same as ARCHITECTURE.md §7 item 1, revisit only when real usage and
requests justify taking this on. Superseded for the build-vs-don't-build question
by explicit user direction (see status banner) — what remains gated on further
signal is scope *beyond* what's already built: a rendered dashboard UI,
OIDC-to-keyId identity linking (a self-view), multi-team isolation, billing.
This document made that future work smaller and less ambiguous when it was
written; it continues to do the same job for the work that's still ahead.
