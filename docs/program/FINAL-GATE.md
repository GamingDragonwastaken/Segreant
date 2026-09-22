# Final Gate

The program is not complete merely because repository work stops. Every
Foundational Audit II finding and Execution Dossier III packet must be terminal,
and the final reconciliation candidate must satisfy the repository-internal gate
below at one exact head. External field evidence remains separately named in
`docs/program/EXTERNAL-GATES.md`.

## Repository-internal completion conditions

- [x] No unresolved repository-internal P0/P1 defect. `AUDIT-REGISTER.md` contains exactly 36 terminal findings and is mechanically guarded by `test/program-terminal-state.test.ts`.
- [x] Exact-head CI is a distinct job from the synthetic PR merge ref. The final acceptance event is the successful candidate-head run for the final reconciliation SHA; a later code change invalidates that evidence and requires another run.
- [x] Typecheck/build/package smoke are mandatory CI jobs at the candidate head and merge candidate; package smoke installs the packed artifact in a clean directory and exercises the real binary/dashboard.
- [x] Trusted Epistemic Kernel invariants are property/adversarial tested: state lattice, Evidence/Claim/Witness/Derivation legality, completeness, grain/scope, revocation, canonical serialization, DAG/replay and issuance-map gates.
- [x] Exact Money/Rate and economic-basis semantics are migrated across consequential accounting, budget, model attribution, allocation, receipt, reconciliation and export/control paths; monetary consumer sweeps fail on unclassified read sites.
- [x] Required-gate unknowns cannot become confirmed realization; the strict gate ladder requires every declared predicate and preserves conflict.
- [x] Conflict remains distinguishable from unknown through canonical state, realization, persistence, CLI/API/GUI and issuance.
- [x] Negative claims require relevant completeness coverage; missing incident/source coverage withholds `clean` rather than treating silence as evidence.
- [x] Granularity/construct/evidence/trust escalation requires explicit witness/bridge/derivation obligations and direct-append floors.
- [x] Raw evidence and authoritative records are append-only or explicitly versioned/superseded/revoked; recovery/migration tests exercise interruption and tamper paths.
- [x] Causal and observational lanes are semantically separate. Observational frontier/model comparisons cannot mint causal or DAL-3 spend authority; OPE requires action-level propensity/policy provenance.
- [x] Decision recommendations expose assumptions, utility/interval basis, preference robustness, alternatives and assurance/fitness. The bounded online controller requires a canonical decision Claim plus delegated policy; a bare certificate never authorizes action.
- [x] Canonical API/GUI/CLI contracts are conformance-tested through generated/shared route/payload/interface/capability contracts and package/runtime smoke.
- [x] Documentation/runtime drift is mechanically checked for commands, flags, ports, public claims, capability/evidence boundaries and program terminal state.
- [x] Recovery/migration/security/supply-chain gates are verified: build publication/recovery, database recovery, pinned actions, lock/integrity/install policy, runtime SBOM, production source credential/dynamic-code scan and runtime dependency audit.
- [x] External gates have executable protocols and explicit blockers in `EXTERNAL-GATES.md`; no repository-internal work is hidden behind them.
- [x] Final adversarial audit attempted to falsify completion and repaired surviving internal defects: WP-J02's false external block, decision-certificate issuance bypass, stale program-state records, security-gate omissions, a wall-clock test flake, the new controller's monetary-consumer classification, and crash consistency across config/state/audit writes.

## Final integration evidence rule

These checkmarks describe the acceptance contract implemented by the final
reconciliation tree. They become merge evidence only when the CI run for the exact
final head concludes successfully across all configured jobs, including
`candidate-head`, the synthetic merge candidate matrix, `security`, package smoke,
browser accessibility, and team-server jobs. If any file changes after that run,
the exact-head condition is invalidated until a new run succeeds.

## External evidence deliberately not claimed

Repository completion does not establish provider-authoritative billing truth, a
real causal financial effect, production deployment fitness, independent security
approval, scholarly novelty, real assistive-technology behavior, or longitudinal
design-partner value. Those require X-01 through X-07 in `EXTERNAL-GATES.md`.

## Completion language

Do not claim perfection, historic significance, field leadership, scientific
novelty, or production field validation from internal implementation evidence.
