# Evidence Index

| Evidence | Exact identity | What it establishes | What it does not establish |
|---|---|---|---|
| Approved Foundational Audit II | SHA-256 `0092098ce085a63006bfcd6d63f5fca7f5dc2d25b4f7b112daa1dd0d8bdeb8cc` | Owner-approved architectural/research direction | Runtime implementation |
| Prior Magnum Opus Master Plan | SHA-256 `34f027207fa4ee6478d0fbbb217e2b6c0cbf5e9bd98673242f11844b223967f6` | Earlier execution program retained except where Audit II supersedes | That all tasks are still semantically valid |
| High-assurance starting candidate | Git SHA `31577d5b112653e5aa4dff5a0bdaae9fd58a982c` | Exact source baseline for reconstruction | Green CI |
| GitHub Actions CI run | Run `33222840344` | Package smoke/root 3-OS/team Windows+Ubuntu green; team macOS failed one OIDC nbf test | That candidate is merge-ready |
| macOS failing job | Job `99020364863` | Failure occurs in `verifyIdToken: a token with nbf beyond the clock-skew allowance is rejected` | Broader OIDC failure |
| OIDC test source | `team-server/test/oidc.test.ts` at `31577d5...` | Test constructs `nbf = now + 61` before async verification | Stable >60-second separation at verifier check |
| OIDC verifier source | `team-server/src/oidc.ts` at `31577d5...` | Verifier recomputes `now` after discovery/JWKS/signature work and rejects only `nbf > now + 60` | Deterministic test clock |
