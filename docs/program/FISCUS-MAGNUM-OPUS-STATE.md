# Fiscus Magnum Opus Program State

## Authority

This file is the durable execution checkpoint for the reconstruction authorized on 2026-08-29. The controlling architecture is the owner-approved `FISCUS_FOUNDATIONAL_AUDIT_II_COMPLETE.md` with SHA-256 `0092098ce085a63006bfcd6d63f5fca7f5dc2d25b4f7b112daa1dd0d8bdeb8cc`. The earlier master plan remains binding except where Audit II supersedes it.

## Current baseline

- Repository: `GamingDragonwastaken/Fiscus`
- Reconstruction branch: `gpt56/magnum-opus-reconstruction`
- Starting SHA: `31577d5b112653e5aa4dff5a0bdaae9fd58a982c`
- Starting tree: `e8c704b163ef753fc7f41b584d507934cc51fc2b`
- Base PR: #8 (`codex/high-assurance-foundation` -> `main`)
- Main at authorization: `cf4179f4571a81a2c2e12b45c4205baaf06a3eb7`
- Exact-head CI at starting SHA: red because `team-server-test (macos-latest)` failed only the OIDC `nbf` clock-skew boundary test; package smoke, all root OS jobs, and team-server Windows/Ubuntu were green.

## Program phase

`M0 / constitutional reconstruction bootstrap`

Current work order:

1. Preserve controlling audit and plan in-repository.
2. Establish durable program registers.
3. Repair the red exact-head baseline using deterministic time semantics, not a widened magic threshold.
4. Establish a green exact-SHA reconstruction baseline.
5. Begin Trusted Epistemic Kernel in dependency order: evidence state -> scope/grain/time -> exact money/rates -> claim/derivation/revocation -> measurement/completeness -> decision certificate.
6. Migrate legacy value semantics behind the kernel without discarding useful capabilities.

## Completed

- [x] Foundational Audit II completed and owner-approved.
- [x] Starting candidate verified at exact SHA `31577d5...`.
- [x] Root cause of current CI failure isolated to wall-clock drift between test token construction and verifier time acquisition.
- [x] Reconstruction branch exists and is exactly at the reviewed candidate starting SHA.

## In progress

- [ ] Durable program checkpoint commit.
- [ ] Deterministic OIDC clock test and clock injection.

## Next exact action

Commit the durable program artifacts, then create a failing deterministic-clock regression test in `team-server/test/oidc.test.ts` before modifying `team-server/src/oidc.ts`.

## Non-negotiable execution invariants

- Never modify `main` directly.
- Every final verification claim binds to an exact remote SHA.
- Unknown is not pass; conflict is not unknown.
- Raw evidence is immutable; corrections and supersession are additive.
- No evidence, granularity, construct, trust, or uncertainty laundering.
- No capability is abandoned merely because a competitor or standard already implements it.
- Research maturity and production truth remain separate.
- External evidence is never fabricated.
- Owner-reserved actions remain unperformed without explicit authorization.
