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

## Steps before a public npm/GitHub release

`RELEASE-GATE.md`'s "Required before public npm/GitHub release" section lists
six steps. The owner decides them; since 0.2.1 releases are delegated to the
maintainer, who does steps 1 to 4 before pushing the version tag, and the
publishing workflow described below performs steps 5 and 6:

1. Confirm the public package name/scope is available and that the publisher
   account is authorized to use it — see
   check the current registry and repository names at release time. A prior
   availability check is not authority for a later publication.
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
6. Create the GitHub release, the public statement that a version is
   available, only after the registry install succeeds — availability is never
   claimed before that check passes. Since 0.2.1 the version tag is what starts
   a release (see below), so the tag exists before publication; the GitHub
   release is created last.

## How a release is published

Since 0.2.1, releases are published by `.github/workflows/publish.yml` through
npm trusted publishing: GitHub Actions authenticates to npm with a short-lived
OIDC token, so no npm token is stored anywhere, and every published version
carries a provenance attestation naming this repository, the workflow and the
exact commit. The owner configured the trusted publisher on npmjs.com and has
delegated releases to the maintainer: after the release gate in
`RELEASE-GATE.md` passes on a commit, pushing the tag `vX.Y.Z` on that commit
publishes it. The workflow refuses, before publishing anything, when:

- the tag does not name the `package.json` version;
- the commit is not on `main`;
- CI did not pass on that exact commit;
- `CHANGELOG.md` has no section for the version.

It then runs the `prepublishOnly` checks, packs the tarball once, publishes
that file, confirms the registry serves the same bytes (the `dist.integrity`
of the published version equals the packed file's sha512), installs the
registry copy into a clean directory and starts its dashboard. Only then does
it create the GitHub release, with the tarball and its `.sha256` attached:
availability is claimed after the registry install succeeds (step 6). The
release notes are extracted from `CHANGELOG.md` before anything is published,
so a missing or empty section stops the release first. A re-run of the same
tag never publishes twice: when that version is already on npm with the
packed file's exact bytes it finishes the remaining steps, and when the bytes
differ it stops. It never replaces a file already attached to a published GitHub release: a missing file is added, and one that differs stops the run. Tags pushed while a release is running wait their turn in order. A prerelease version (`1.2.3-rc.1`) is published under the `next`
dist-tag and never becomes the default install.

To check the npm side without releasing anything, run the workflow by hand
(Actions, Publish, Run workflow): its `trust-check` job exchanges the run's
identity token with npm exactly as a release would and reports whether npm
accepts this workflow as the package's trusted publisher. Nothing is built or
published, and the token npm issues is discarded.

## Separate gate: the team server

`team-server/` has its own gate in `RELEASE-GATE.md` ("Separate gate: optional
team server") covering real PostgreSQL validation, OIDC/authorization testing,
TLS/secrets/backup infrastructure, and k-anonymity review. A green team-server
typecheck/test run validates source only and moves none of those five
infrastructure requirements — it is not a step toward a hosted release without
completing that separate gate in a disposable environment.

## What this document is not

It does not grant anyone the ability to publish, tag, or deploy beyond the
delegation recorded above, and it does not shortcut `RELEASE-GATE.md`'s requirement that every claim be
bound to an exact, observed commit and CI run.
