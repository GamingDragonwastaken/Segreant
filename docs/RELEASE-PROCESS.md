# Release process

This states how a row in [`RELEASE-GATE.md`](RELEASE-GATE.md) gets produced,
and which steps only the repository/package owner may perform. It does not
introduce new authority — `RELEASE-GATE.md` remains the release record; this
page explains the procedure behind it.

## How a local-candidate row is produced

Each row in `RELEASE-GATE.md`'s "Local CLI and dashboard candidate" table is
evidence bound to one exact commit, produced in this order:

1. Record the candidate identity: `git rev-parse HEAD` and
   `git status --short`, before and after validation.
2. Review `docs/CAPABILITY-EVIDENCE-CONTRACT.md` against that exact candidate
   and run `test/public-claims-contract.test.ts`.
3. Run `npm ci`, `npm run typecheck`, `npm test`, `npm run build` and record
   the exact totals.
4. Exercise the budget fail-closed checklist (malformed config, invalid
   settings, ledger-read failure, request-persistence failure).
5. `npm pack`, record the tarball digest, and inspect that `bin`, compiled
   `dist`, pricing, baselines, and dashboard HTML are present in it.
6. Write the CI row as **PENDING** — do not predict a run's outcome — then
   read the actual GitHub Actions run for that exact commit SHA and fill in
   its `conclusion` once it completes. A prior run on an earlier commit is not
   evidence for this one.

A superseded row is never rewritten; a new candidate gets a new row. This
mirrors `CLAUDE.md`'s release-discipline rule: "Write the CI row PENDING and
fill it after observing the run — never predict it."

## Owner-reserved steps before a public npm/GitHub release

`RELEASE-GATE.md`'s "Required before public npm/GitHub release" section lists
six steps that only an authorized repository/package owner performs, and they
are intentionally not automated from a local coding task:

1. Confirm the public package name/scope is available and that the publisher
   account is authorized to use it — see
   [`NAME-COLLISION-REVIEW.md`](NAME-COLLISION-REVIEW.md) for what a check of
   `npm view fiscus` found; it is a finding, not a rename decision.
2. Choose the release version, changelog/release notes, and support/security
   contact; verify LICENSE ownership/attribution before changing historical
   copyright text.
3. Re-run the local checklist from a clean checkout and inspect the intended
   commit's GitHub CI jobs, including the packed-dashboard smoke.
4. Confirm public README/landing-page copy and all outbound data boundaries
   against the provider/optional-service configuration actually shipped.
5. Inspect the generated tarball one final time, publish intentionally, then
   install the registry package into a clean directory and smoke its CLI and
   dashboard.
6. Create a release/tag only after the registry install succeeds — availability
   is never claimed before that check passes.

## Separate gate: the team server

`team-server/` has its own gate in `RELEASE-GATE.md` ("Separate gate: optional
team server") covering real PostgreSQL validation, OIDC/authorization testing,
TLS/secrets/backup infrastructure, and k-anonymity review. A green team-server
typecheck/test run validates source only and moves none of those five
infrastructure requirements — it is not a step toward a hosted release without
completing that separate gate in a disposable environment.

## What this document is not

It does not grant anyone but the owner the ability to publish, tag, or deploy,
and it does not shortcut `RELEASE-GATE.md`'s requirement that every claim be
bound to an exact, observed commit and CI run.
