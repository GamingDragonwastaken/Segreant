# Fiscus Magnum Opus Program State

## Authority

This file is the durable execution checkpoint for the reconstruction authorized on 2026-08-29.

Controlling architecture:

- `FISCUS_FOUNDATIONAL_AUDIT_II_COMPLETE.md`, SHA-256 `0092098ce085a63006bfcd6d63f5fca7f5dc2d25b4f7b112daa1dd0d8bdeb8cc`.
- `docs/program/FISCUS-REMAINING-WORK-AUDIT.md` for the reconciled post-first-tranche remaining-work state.
- `docs/program/LUNA-RESUME-PROTOCOL.md` for mandatory local-repository resynchronization before Luna/Codex resumes implementation.
- The earlier Magnum Opus Master Plan remains binding where not superseded by Audit II.

## Current baseline

- Repository: `GamingDragonwastaken/Fiscus`
- Reconstruction branch: `gpt56/magnum-opus-reconstruction`
- Original reconstruction starting SHA: `31577d5b112653e5aa4dff5a0bdaae9fd58a982c`
- Code baseline reconciled by the remaining-work audit: `abbcddc6ff5783e9d8da1b57dcc566da1e3256c5`
- M0 implementation checkpoint: `685b14c57cccf078679a37a929f6234f00522abd`
- Exact remote verification run for that checkpoint: GitHub Actions `33253835881` (success; root Ubuntu/macOS/Windows, package-smoke, and team-server Ubuntu/macOS/Windows)
- Evidence kernel checkpoint: `c89d95d341a0ad34f04562f0bad068e0ea60177c`
- Claim kernel checkpoint: `fa36cc380e6883cc868e2e5b46517ae118a038ae`
- Exact remote verification run for the Claim checkpoint: GitHub Actions `33255107581` (success across all seven configured jobs)
- Derivation/Witness checkpoint: `c457b95496481bc3c4d1eb89100e38ce7862ab32`
- Immutable DAG checkpoint: `8928bb474ecb93477caa7605c6710b432653a631`
- Exact remote verification run for the DAG checkpoint: GitHub Actions `33256214683` (success across all seven configured jobs)
- SQLite epistemic-ledger checkpoint: `9d8d364013d22f37fc4c3548f57110a26a274b6a`
- Exact remote verification run for the ledger checkpoint: GitHub Actions `33257825704` (success across all seven configured jobs)
- Assumption/event-time checkpoint: `820bad0fe7c636f31bc1fdd99aebfbe47fee5826`
- Canonical serialization checkpoint: `5ab1440e7495a58dcf08083696591e7cf1747d07`
- Exact remote verification run for serialization: GitHub Actions `33258932047` (success across all seven configured jobs)
- Canonical witness-registry checkpoint: `774658431739673183066f3c45dd9d01e84346a2`
- Exact remote verification run for the witness registry: GitHub Actions `33260005454` (success across all seven configured jobs)
- Hindsight-safe replay/conformance checkpoint: `a7ef58946d941e0e035a38641f59f234b180a0b8`
- Exact remote verification run for replay/conformance: GitHub Actions `33260565547` (success across all seven configured jobs)
- Billing kernel vertical checkpoint: `9a0254ab0766057b53569b396f81c1d7c8dd96e2`
- Exact remote verification run for the billing vertical: GitHub Actions `33261466500` (success across all seven configured jobs)
- Persisted reconciliation-kernel checkpoint: `ec8e67ad79211389ba0b8caa5cf40ceb3ccb2872`
- Exact remote verification run for persisted reconciliation Claims: GitHub Actions `33262733403` (success across all seven configured jobs)
- Local candidate economic-event foundation (not yet published): `5ef8b58d5af5824b439fcf5c41abb3b424fcb4e`
- Local candidate economic canonicalization/replay hardening (not yet published): `5c8d9c6343ac5bd95abcd23faef30df38df3c075`
- Local candidate exact decimal pricing boundary (not yet published): `ad0b6a4781d26afad8df10cfe9d0dd27ec12b155`
- Local candidate atomic exact request-charge bridge (not yet published): `ac0efa7555b4b87f7f24319c602f2b77f2ab2b85`
- Local candidate bundled exact-rate integration and live proxy/import issuance (not yet published): `3763c9e86a81c365c7fe08e1ddf4bb9a5f7edb76`
- Local candidate economic role-aware projections and reversal constraints (not yet published): `6285bccd0f223075bc97c30f34a76db9f9377b98`
- Local candidate verification: 1,041 root tests total (1,037 pass, 0 fail, 4 platform-conditional skips), root/browser typecheck, build, and isolated-cache package dry-run pass. No GitHub Actions run exists for these local-only commits because the push was refused by the Codex usage/approval limit.
- Remaining-work audit commit: `5e5a82843154a6fd04e0017538919108c5ff06f1`
- Luna resume-protocol commit: `5c4de94cf7af0a218ecd10946ac91577fdd9eae7`
- Base high-assurance PR: #8 (`codex/high-assurance-foundation` -> `main`)
- Reconstruction review PR: #9 against `codex/high-assurance-foundation`
- Verification-only PR: #10 against `main`; do not merge it merely because it exists.

The exact remote reconstruction SHA must always be re-read after `git fetch`; documentation/checkpoint commits can move the branch beyond the code baseline above.

## Program phase

`M0 stabilization complete; M1/M2 kernel-to-billing integration active; local M2 economic migration candidate under verification`

## M0 stabilization checkpoint (2026-08-29)

- [x] Re-synchronized a fresh writable execution checkout to the live remote reconstruction tip after preserving the already-pushed canonical snapshot and high-assurance branches.
- [x] Verified local/remote identity before implementation: `4994582ad7fd389e29820cf3f3a2902a0a967ec7`.
- [x] Implemented `src/decision/engine.ts`: strict interval-dominance certificates, explicit minimax-regret selection, decision-theoretic perfect-information VOI, validation, assumptions, and deterministic ties.
- [x] Implemented `src/epistemic/revocation.ts`: additive transitive closure, sibling preservation, cycle-safe traversal, duplicate-edge rejection, and idempotent repeated revocation.
- [x] Migrated strict realization/demo fixtures to provide explicit `merged`/`shipped` evidence; no unknown gate was converted into pass in production semantics.
- [x] Restored local root verification: Node typecheck, browser typecheck, 968/968 root tests, and package smoke.
- [x] Observed exact-SHA GitHub CI success in run `33253835881`.

This checkpoint closes the immediate RED recovery tranche only. It does not close the remaining Trusted Epistemic Kernel, economic, causal, security, UX, research, or external-validation program.

## M1 kernel checkpoint (2026-08-29)

- [x] Canonical immutable Evidence envelope (`c89d95d`) with typed source/coordinates, explicit trust and completeness axes, acquisition times, measurement/monetary references, assumptions, supersession/revocation links, sensitivity/redaction, schema version, and hash/reference-safe payload handling.
- [x] Canonical immutable Claim envelope (`fa36cc3`) with typed propositions, explicit evidence dependencies, derivation identity, uncertainty, matching profile/causal axes, profile-derived monetary/finality aliases, and additive lifecycle metadata.
- [x] Evidence/Claim focused tests and full root/browser/build verification remain green; GitHub run `33255107581` validates the exact Claim checkpoint across the configured matrix.

This is a kernel issuance foundation, not universal product migration. Persisted Evidence/Claim DAG storage, Derivation legality, assumptions, as-of reconstruction, serialization/conformance, and downstream vertical adoption remain open.

## M1 dependency-graph checkpoint (2026-08-29)

- [x] Canonical Derivation/Witness legality (`c457b95`) refuses unsupported coordinate, epistemic, coverage, measurement, causal, monetary-finality, trust and decision-fitness strengthening, and binds output propositions/coordinates to immutable Claim IDs.
- [x] Immutable Evidence/Claim DAG snapshot (`8928bb4`) provides append-only functional snapshots, cycle prevention, ancestor/descendant and assumption/measurement views, conflict paths, as-of filtering, supersession lookup, minimal support/cut projections, and traceable transitive revocation.
- [x] Focused DAG/Derivation tests and the full root/browser/build gates remain green; GitHub run `33256214683` validates the exact DAG checkpoint across all configured jobs.

Persistence-backed event storage, canonical witness registries, minimal-cut semantics for richer conjunction graphs, and unavoidable integration at every claim-issuance boundary remain the next M1 work.

## M1 persistence checkpoint (2026-08-29)

- [x] SQLite-backed canonical Evidence/Claim/Derivation storage (`9d8d364`) now shares the Store connection, retains canonical JSON plus SHA-256 digests, writes dependencies atomically, supports exact replay idempotence, and protects every kernel table against update/delete/replace bypasses with schema-owned triggers.
- [x] Store integration and old-database regression tests pass; the graph reload validates payload identity and derivation references before exposing a projection.
- [x] GitHub run `33257825704` validates the exact persistence checkpoint across root Ubuntu/macOS/Windows, package-smoke, and team-server Ubuntu/macOS/Windows.

The ledger is a persistence foundation, not complete product migration: first-class assumptions, event-time-aware revocation, canonical witness storage, downstream claim issuance, and economic/billing integration remain open.

## M1 assumption, replay, and serialization checkpoint (2026-08-29)

- [x] First-class immutable Assumption envelope and `Claim.assumptionIds` (`ddf17f7`) keep named assumptions distinct from display text and link them through the DAG for dependency/revocation analysis.
- [x] Revocation replay honors event time (`820bad0`) so historical projections exclude revocations recorded after the as-of boundary.
- [x] Canonical JSON/digest envelopes (`5ab1440`) sort object keys, reject cycles/unsupported values, verify canonical bytes before rehydration, and back the SQLite ledger's persisted payloads.
- [x] GitHub run `33258932047` validates the serialization checkpoint across all seven configured jobs.

M1 now has a persistence-ready canonical Evidence/Assumption/Claim/Derivation/DAG/Witness path. The next work is integration: complete event replay, one real billing/reconciliation vertical, and conformance at every consequential issuance boundary.

## M1 witness-registry checkpoint (2026-08-29)

- [x] Canonical immutable, evidence-grounded Witness envelopes (`7746584`) are versioned, time-qualified, coordinate-checked and serialized through the same digest envelope as the other kernel records.
- [x] SQLite witness persistence is schema-owned and append-only; evidence-to-witness and witness-to-claim edges make witness revocation transitively visible.
- [x] Stored Derivations now require every inline witness reference to match a persisted registry record and retain the corresponding witness edge; graph reload revalidates the binding.
- [x] Focused witness, ledger, serialization, full root, browser, build and package gates pass locally; GitHub run `33260005454` validates the exact checkpoint across all seven configured jobs.

The witness registry closes the first persistence gap but not universal product issuance. Complete event-time replay/conformance vectors, product adapters and exact-money billing integration remain open.

## M1 replay/conformance checkpoint (2026-08-29)

- [x] `EpistemicLedger.replayAsOf()` (`a7ef589`) now returns one immutable graph-plus-revocation projection, filtering node availability and revocation recording time independently.
- [x] Table-driven vectors prove no later evidence, witness, claim or revocation leaks into an earlier projection; repeated reads and reopened handles are deterministic.
- [x] Exact-head GitHub run `33260565547` validates the replay checkpoint across all seven configured jobs.

Replay is now a stable kernel contract; product adapters must still supply all consequential evidence and claims through it.

## M2 billing-kernel vertical checkpoint (2026-08-29)

- [x] Validated operator OpenAI billing exports cross the explicit adapter (`9a0254a`) into exact `Money`-backed provider Evidence and billed Claims, with conservation-checked mixed-basis reconciliation Claims available when supporting Evidence IDs are supplied.
- [x] CLI apply/replay issues canonical claims and emits string-coefficient Money JSON; `/api/billing` exposes bounded ClaimProfile summaries without raw payloads; legacy billing tables remain a compatibility read model.
- [x] Focused billing, CLI, Store and dashboard tests plus the full local suite (1018 total; 1014 pass/0 fail/4 skips), Node/browser typechecks, build and package smoke pass; GitHub run `33261466500` validates the exact checkpoint across all seven configured jobs.

This is the first real product vertical crossing the kernel, not completion of the full financial migration. Direct provider-observation evidence, authoritative local Money migration, economic-event subledger, FX, projections, and universal API/CLI/UI issuance remain open.

## M2 persisted reconciliation checkpoint (2026-08-29)

- [x] Provider-observed, local-capture and mixed-basis reconciliation Claims are persisted through `ec8e67a` with immutable reconciliation-run identities; repeated issuance is idempotent and later corrections cannot collide with an earlier run.
- [x] `billing reconcile --apply` now records the legacy reconciliation run and issues the kernel Claim when provider-day Evidence exists; the API exposes bounded reconciliation Claim summaries alongside provider/billed Claims.
- [x] The adapter enforces provider-total equality with retained observations and exact `provider − local = residual` conservation; provider-observed and billed bases are never conflated.
- [x] Focused and full local verification plus GitHub run `33262733403` pass across all seven configured jobs.

The reconciliation kernel path is now end-to-end for this vertical. Legacy request, budget, allocation, export and economic-event paths still require exact Money migration and a typed subledger.

## M2 economic migration candidate checkpoint (local-only, 2026-08-30)

- [x] Immutable typed economic events and exact Money projections (`5ef8b58`) provide an append-only SQLite subledger with canonical JSON/SHA-256 records, recorded-time replay, and currency/basis-separated balances.
- [x] Economic canonicalization and replay hardening (`5c8d9c6`) reject non-canonical Money/event bodies, missing envelope fields, coercible currencies, hostile exact-value sizes, persisted dangling references, invalid reversal links, and unbounded full-ledger replay filtering.
- [x] Exact decimal pricing boundary (`ad0b6a4`) accepts canonical decimal rate strings and safe integer token counts, derives cache multipliers as exact rationals, and refuses binary numeric rates.
- [x] Atomic request charge bridge (`ac0efa7`) lets an opted-in request write one deterministic exact charge event in the same SQLite transaction; duplicate replays are idempotent, conflicts roll back the request, and legacy rows remain without invented exact evidence.
- [x] Bundled exact-rate integration (`3763c9e`) carries canonical decimal companions in the shipped card and threads exact charge totals through the live proxy, Claude Code, Codex, OpenCode, and synthetic-demo request writers; numeric-only refreshed cards remain explicitly non-exact.
- [x] Role-aware economic projections and relation checks (`6285bcc`) separate usage/charge/price/adjustment/translation/allocation/control flows, enforce kind/basis compatibility, and reject incompatible or over-sized allocation reversals without changing the immutable envelope version.
- [x] Local verification at this candidate: 1,041 total root tests, 1,037 pass, 0 fail, 4 platform-conditional skips; root/browser typechecks, build, focused economic/request tests, and isolated-cache package dry-run pass.

This is a local candidate, not a remote or release checkpoint. Legacy `REAL` request/budget/allocation/value/export consumers remain compatibility projections for now, and event-role/conservation, correction, FX, allocation, and close semantics remain open. GitHub publication and exact-SHA CI are external gates currently blocked by the Codex usage/approval limit.

## Completed in first GPT-5.6 Sol tranche

- [x] Durable program-control directory established.
- [x] Deterministic OIDC clock injection and exact skew-boundary tests; original macOS nondeterminism repaired.
- [x] Four-valued epistemic state primitive with conflict-preserving algebra.
- [x] Grain, scope and bitemporal coordinate primitives.
- [x] Exact arbitrary-precision Money primitive.
- [x] Exact rational Rate primitive.
- [x] Generic open-world OutcomeContract.
- [x] CompletenessWitness primitive.
- [x] Scope/grain derivation-witness foundation.
- [x] Multi-axis ClaimProfile seed.
- [x] MeasurementModel construct-validity foundation.
- [x] Legacy realization lower bound no longer counts unknown required gates as confirmed.
- [x] Non-coding outcomes removed from the fake coding lifecycle funnel and moved onto a domain-neutral OutcomeContract.
- [x] Reconciled remaining-work audit created.
- [x] Mandatory Luna/Codex local-resynchronization protocol created so future local work builds on the remote reconstruction history.

## Current verification state

The latest reconstruction checkpoint is green at exact persisted-reconciliation code SHA `ec8e67ad79211389ba0b8caa5cf40ceb3ccb2872`:

- local Node typecheck: pass;
- local browser typecheck: pass;
- local root suite: 1023 total, 1019 pass, 0 fail, 4 platform-conditional skips;
- local packed/installable artifact smoke: pass;
- GitHub Actions run `33262733403`: success across all seven configured jobs.

The branch is still not a final product-completion baseline. M1 and later audit findings remain open or partial, and external gates remain unperformed. Do not weaken the new invariants merely to preserve superficial green status.

## Exact next actions

1. Migrate authoritative request/budget/allocation/reconciliation/export paths to exact Money/Rate; the local candidate now has a bundled canonical exact rate source and live proxy/import issuance, but refreshed-card provenance, legacy read-model migration, and enforcement consumers remain.
2. Make kernel issuance unavoidable at every consequential product boundary, then introduce WorkUnit/OutcomeAdapter migration.
3. Keep every new claim and decision on the kernel path; add regression/property/adversarial tests before widening capability.
4. After each coherent slice, update this state and the audit/evidence registers with the exact local SHA; add a remote SHA and CI run only after publication is actually verified.
5. Keep external provider, production-service, independent-security, scholarly, accessibility, and design-partner gates explicit; never fabricate their closure.

## Non-negotiable execution invariants

- Never modify `main` directly.
- Every final verification claim binds to an exact remote SHA.
- Unknown is not pass; conflict is not unknown.
- Absence is not evidence of a negative fact without completeness.
- Coarse evidence cannot become finer factual evidence without a witness.
- Statistical precision cannot substitute for construct validity.
- Integrity/authenticity cannot substitute for truth/correctness/completeness.
- Observation cannot silently become causality or action authority.
- Raw evidence and issued claims are immutable/versioned; corrections are additive.
- No capability is abandoned merely because another project or standard already implements it.
- Mathematical sophistication is welcome when it materially improves correctness, identification, calibration, robustness, decision quality or genuine new capability.
- Research maturity and production truth remain separate.
- External evidence is never fabricated.
- Owner-reserved irreversible/public actions remain unperformed without explicit authorization.
