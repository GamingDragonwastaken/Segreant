# Local Execution Inventory

This is a local-only execution overlay. It is intentionally distinct from
`PACKET-INVENTORY.md`, which describes the durable canonical branch and is the
register used for GitHub-facing integration decisions.

## State model

| State | Meaning |
| --- | --- |
| `CANONICAL_COMPLETED` | Verified on the canonical checkout and eligible for the normal durable register. |
| `CANONICAL_PARTIAL` | Present on the canonical checkout but residual obligations remain. |
| `LOCAL_COMPLETE_PENDING_INTEGRATION` | A local isolated worker produced a scoped commit and evidence claiming the packet boundary is complete; not yet cherry-picked, reconciled, or represented as canonical. |
| `LOCAL_PARTIAL_PENDING_INTEGRATION` | A local worker produced useful scoped work, but the packet or product integration remains incomplete. |
| `LOCAL_IN_PROGRESS` | A local worker has uncommitted work or is actively executing. |
| `BLOCKED` | Progress requires a real external dependency or owner decision. |

## Canonical baseline

At the time of this checkpoint:

- Canonical branch: `gpt56/magnum-opus-reconstruction`
- Canonical SHA: `cccff98d04ac75d1a80d34e50fa333f7c578372a` (runtime Chromium/axe accessibility gate, CI topology contract, supply-chain test-only allowlist, and macOS plugin-host EPIPE lifecycle hardening; all pushed to `origin/gpt56/magnum-opus-reconstruction`)
- Durable packet register: 76 total, 60 completed, 10 partial, 1 not started, 1 blocked external, 4 superseded with reason.
- Exact-head CI: run `35630657686` concluded **success** across all nine configured jobs, including the new `browser-accessibility` job on `cccff98`.
- Canonical worktree: clean and synchronized with `origin/gpt56/magnum-opus-reconstruction`.
- Local baseline: root suite `2,137 total / 2,133 pass / 0 fail / 4 skipped` after the CI-hardening contract update; plugin-host 9/9; dashboard/program contract tranche 6/6; runtime browser/axe 1/1; root/browser/team-server typechecks, build, and supply-chain audit pass.

These counts are not the full local execution state.

## Local worker overlay

| Packet | Local state | Evidence | Worktree / branch | Canonical integration |
| --- | --- | --- | --- | --- |
| `WP-D04` | `CANONICAL_COMPLETED` | `9519aaa` (integrated from verified `c3b8f191`); 42-case synthetic corpus, deterministic evaluator, focused benchmark 7/7, canonical docs/registers updated | canonical checkout | Exact-head CI pending for the integration head |
| `WP-E01` | `LOCAL_COMPLETE_PENDING_INTEGRATION` | `c424d0a`; canonical registry now carries all dossier-required estimand dimensions and valid v1/v2 estimates/issuance resolve it; causal focused 60/60, root serial 2097 total / 2093 pass / 0 fail / 4 skips, typechecks/build green | current canonical local head | Exact-head CI pending; not yet reflected as canonical completed |
| `WP-E02` | `CANONICAL_COMPLETED` | `bb5cfb2`; one design/estimator registry routes retained ITT and explicitly classifies deferred/archived/noncausal lanes; registry/issuance/snapshot tests 4/4 | canonical checkout | Exact-head CI pending |
| `WP-E03` | `CANONICAL_COMPLETED` | `f310682`; block-aware ITT, explicit observed noncompliance, incomplete/conflicting block refusal; causal core/ledger/issuance tranche green | canonical checkout | Exact-head CI pending |
| `WP-E04` | `CANONICAL_PARTIAL` | `a44007a`; per-arm missingness/attrition/interference disclosure and no-imputation policy; focused RED-first tests green | canonical checkout | Residual design obligations remain |
| `WP-E05` | `CANONICAL_PARTIAL` | `bb5cfb2`; witnessed causal transport with target evidence and revocation propagation; focused transport/epistemic tests green | canonical checkout | Cross-study pooling/bridge workflow remains |
| `WP-E06` | `CANONICAL_PARTIAL` | `4cf26c7`; durable pre-registration boundary and restart recovery; focused causal inference tests green | canonical checkout | Operator-facing setup, cross-study families, correlation adjustment and precision probability remain |
| `WP-J01` | `CANONICAL_PARTIAL` | Current checkpoint `src/causal/ope.ts` + Store `ope_action_observations`; focused OPE/store coverage 11/11; root typecheck/build pass | canonical checkout | Append-only action log and digest replay are present; real decision-boundary provenance, evaluation-record replay/idempotence and a bounded consumer remain |
| `WP-H03` | `CANONICAL_COMPLETED` | The canonical register and remote branch already include H03's bounded mutation/fuzz/fault-injection closure; local commits are historical duplicate evidence | `luna-next/wp-h03` | Already represented canonically; do not cherry-pick stale duplicate commits |
| `WP-F06` | `SUPERSEDED_WITH_REASON` | The canonical branch supersedes F06 with the later decision-assurance/action-boundary implementation; local `d08df8fc` is historical and must not override the canonical decision | `luna-next/wp-f06` | Do not integrate as a separate competing lifecycle |
| `WP-B02` | `STALE_LOCAL_BASE` | Old isolated lane was based on `f8f0361` and has no committed work; reselect only from canonical `55b3e38` if the dossier still requires it | `luna-next/wp-b02` | Not active |
| `WP-C01` | `STALE_LOCAL_BASE` | Old isolated lane was based on `f8f0361` and has no committed work; reselect only from canonical `55b3e38` if the dossier still requires it | `luna-next/wp-c01` | Not active |
| `WP-I06` | `STALE_LOCAL_BASE` | Old isolated lane was based on `f8f0361` and has no committed work; reselect only from canonical `55b3e38` if the dossier still requires it | `luna-next/wp-i06` | Not active |

## Interpretation

The local overlay currently shows two packets with a worker-level complete
implementation boundary and one packet with a valuable but explicitly partial
bounded implementation. None of these claims are canonical until the
coordinator verifies the diffs against the current canonical head, integrates
compatible commits, reruns the required gates, and updates the durable program
registers.

## Reconciliation rule

Do not overwrite canonical packet states merely because a worker committed.
Instead:

1. verify the isolated commit and evidence;
2. check for overlap and compatibility with the canonical head;
3. integrate only compatible commits;
4. rerun the canonical focused and broader gates;
5. update `PACKET-INVENTORY.md`, `AUDIT-REGISTER.md`, `DECISION-LOG.md`,
   `EVIDENCE-INDEX.md`, and `ACTIVE-EXECUTION.md`;
6. retain the local overlay as historical execution evidence.

Last updated: 2026-09-21
