# Evidence Index

This index records verification evidence by exact revision. Evidence from one SHA never automatically applies to a later SHA.

## E-BASE-001 — High-assurance candidate identity

- Commit: `31577d5b112653e5aa4dff5a0bdaae9fd58a982c`
- Tree: `e8c704b163ef753fc7f41b584d507934cc51fc2b`
- Branch: `codex/high-assurance-foundation`
- PR: #8
- Base main: `cf4179f4571a81a2c2e12b45c4205baaf06a3eb7`
- Status at program start: open, unmerged.

## E-CI-001 — Exact candidate CI run

- Workflow run: `33222840344`
- Conclusion: failure
- `package-smoke`: success
- root `test (windows-latest)`: success
- root `test (macos-latest)`: success
- root `test (ubuntu-latest)`: success
- `team-server-test (ubuntu-latest)`: success
- `team-server-test (windows-latest)`: success
- `team-server-test (macos-latest)`: failure
- Failed assertion: `verifyIdToken: a token with nbf beyond the clock-skew allowance is rejected`
- macOS job: `99020364863`
- Observed result: 59 tests / 58 pass / 1 fail.

## E-ROOTCAUSE-001 — OIDC time-boundary race

Source evidence at `31577d5...`:

- `team-server/test/oidc.test.ts` captures `now = floor(Date.now()/1000)`, signs `nbf: now + 61`, then awaits `verifyIdToken`.
- `verifyIdToken` performs OIDC/JWKS work before capturing a fresh `now = floor(Date.now()/1000)` and rejects only when `payload.nbf > now + 60`.
- If at least one wall-clock second elapses between the two samples, `testNow + 61 == verifierNow + 60`, so the token is accepted exactly at the permitted boundary.
- CI log shows this is the only failing team-server test on macOS; RS256/ES256 signature verification and the other OIDC security checks pass in that job.

Conclusion: the test did not deterministically place the token one second beyond the verifier's tolerance. The correct repair is a shared/injected fixed clock for the boundary assertion, not merely widening the test value.

## E-TDD-001 — Deterministic OIDC test-first commit

- Commit: `85d63e4ad17616b6d04c70e048979d06ff6a369f`
- Parent: `34d8590a74b5c9bd847dbb86e023ea21120a66cd`
- Change: tests call `verifyIdToken(..., { nowEpochSeconds: () => verifierNow })` and assert inside/exact/outside `nbf` behavior.
- Production support for the third argument was not added until the next commit.

What this establishes: test-first history exists for the deterministic-clock behavior.

What it does not establish: that the final implementation compiles or passes CI.

## E-IMPL-001 — OIDC verification context implementation

- Commit: `0411dc672b69be20989795203aad83bff4c41020`
- Parent: `85d63e4ad17616b6d04c70e048979d06ff6a369f`
- Branch relation to reviewed candidate: 3 commits ahead, 0 behind.
- Production interface: `OidcVerificationContext { nowEpochSeconds?: () => number }` as a separate verification dependency rather than deployment configuration.
- Temporal evaluation uses one safe-integer verifier time; invalid injected time fails closed.
- JWT clock dependency does not replace cache TTL or network timeout wall clocks.

What this establishes: the source contains the intended structural repair and avoids coupling test time to deploy-time OIDC configuration.

What it does not establish: exact-head CI success. Security-relevant comments removed incidentally in this commit should be restored or their substance preserved before polish is considered complete. `iat` and `exp` exact-boundary cases also remain to be added to the deterministic regression suite.

## E-AUDIT-001 — Approved Foundational Audit II

Canonical source artifact verified locally before execution:

- filename: `FISCUS_FOUNDATIONAL_AUDIT_II_COMPLETE.md`
- SHA-256: `0092098ce085a63006bfcd6d63f5fca7f5dc2d25b4f7b112daa1dd0d8bdeb8cc`
- bytes: 118,674
- lines: 3,911
- words: 15,950

The repository archive stores `gzip(original bytes)` as Base64 text split into five lexical chunks. Reconstruction must reproduce the SHA above exactly.

## E-PLAN-001 — Prior master execution plan

- filename: `FISCUS_MAGNUM_OPUS_MASTER_PLAN.md`
- SHA-256: `34f027207fa4ee6478d0fbbb217e2b6c0cbf5e9bd98673242f11844b223967f6`
- bytes: 94,717
- lines: 3,082
- words: 12,688
- Authority: remains valid except where Foundational Audit II explicitly supersedes it.

## E-GIT-001 — Concurrent branch preservation event

A program-state commit was first constructed against the stale starting tree `31577d5...`. GitHub rejected moving `gpt56/magnum-opus-reconstruction` to that commit as non-fast-forward. Branch inspection then showed authorized work had already advanced the branch to `0411dc6...` through the three commits above. No force update was performed. The program rebuilt the checkpoint on the real tip.

This event is retained because it demonstrates the preservation rule in practice: concurrent/recent work is inspected and incorporated, not overwritten for convenience.

## Evidence quality rule

Every future entry must state:

1. exact SHA or external artifact identity;
2. command/run/protocol that generated the evidence;
3. observed result;
4. what the evidence establishes;
5. what it explicitly does **not** establish.
