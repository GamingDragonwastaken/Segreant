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
- Local candidate normalized source-link migration (not yet published): `8fcd2624df2a2041fc2709c0827907e17216be34`
- Local candidate exact budget projection migration (not yet published): `05f26e6110b45a03e34d27d42890ca2535ece6fd`
- Local candidate exact economic CLI inspection surface (not yet published): `e3a280fb1d1ab3874b946259e251ab8b5ffbf3c0`
- Local candidate additive price-correction lineage (not yet published): `2b811730a1a7a56a5a2acfe6840e5af205ddf162`
- Local candidate historical exact FX lineage (not yet published): `11a92129733c19bdad31d90e3315304c51996db3`
- Local candidate effective correction projection and legacy-reprice convergence (not yet published): `60592584621d530c4a07d6ddd7dd806082aed4e7`
- Local candidate exact-money allocation projection (not yet published): `d8d260f`
- Local candidate schema-owned exact allocation persistence (not yet published): `3fa9a20e2b58284f0cd9ad4730a6de5e92bde51f`
- Local candidate exact-allocation replay/parity hardening (not yet published): `baee5c659aba906b2959df7f8322a1092dad1018`
- Local candidate exact economic export surface (not yet published): `c1f7ec482f0d676c1301b3d3876551f391e2256d`
- Local candidate exact economic dashboard/API projection (not yet published): `ccda34d`
- Local candidate coding value-attribution/effective snapshot lineage (not yet published): `3871b6fe54b008c22cdc9e12cbe6e549181e7d6c`
- Local candidate grouped usage/cohort/model/series/budget migration (not yet published): `5e54250083ab0c3ba7db44e4b350a1f2ab150a28`
- Local candidate exact frontier/time-reclaimed projections (not yet published): `3c71c51`
- Local candidate modern Value-view exact coverage disclosure (not yet published): `ebbc571`
- Local candidate exact receipt v2 protocol (not yet published): `443c74d`
- Local candidate exact team-rollup v2 protocol/storage migration (not yet published): `2d567c28027a264fdba1bb302bafbdc4f9e944e3`
- Local candidate bounded classic Value/API exact-coverage parity (`16c5a15f24604b9bdff06282beeb6fb3e7111557`, not yet published): the legacy dashboard and browser contract now disclose mature, usage, budget, project and team exact/partial/legacy coverage.
- Local candidate immutable refreshed-card provenance (`47ed621c988b8f3df700e606c216645f52525a12`, not yet published): accepted cards retain hash-bound provenance sidecars; historical pricing cohorts expose them or explicit unavailable status.
- Local candidate bounded dashboard runtime contract conformance (`e244115e340b8aab49b791e1ce2d699fa755c35e`, not yet published): seeded read endpoints are checked against browser-declared primitive, array, record, interface and null-union types.
- Local candidate exact period-close lifecycle (`28905c54436680561354b1c939e50194d7cf48fa`, not yet published): canonical half-open periods, digest-bound basis-separated snapshots, as-of status replay, explicit append-only reopen controls, conflict-preserving transitions, late-event blocking, JSON-safe CLI finalize/status/reopen operations, and typed `/api/economic` close state.
- Local candidate canonical/generated dashboard route contract (`d6243c76a41839e594c378adab8a8129d9d2566c`, not yet published): every API path, method set, Allow header, CSRF gate, response binding, and declared browser-surface binding is sourced from one no-node descriptor; the browser copy is regenerated under the publication lock and route-contract conformance fails on drift. Payload-field schema generation and CapabilitySpec remain open.
- Local candidate immutable CapabilitySpec contract (`0467830dff8ba8635e4bd429de3534fa59986dd8`, not yet published): every GUI capability carries schema classes, authority, egress, credential, reversibility, assurance, and CLI/API/GUI/docs bindings; the System/parity view consumes the immutable specs and conservative conformance tests guard planned/destructive/read boundaries.
- Local candidate shared dashboard payload envelopes (`92ecbbdaae5fa72ef313e866c90ff967ec97f8be`, not yet published): top-level JSON/text contracts cover every API method, are copied with the browser route contract, seeded runtime conformance validates all JSON envelopes, and the modern API fails closed with a typed 502 on contract violations.
- Local candidate generated nested dashboard-interface metadata (`aad39bc2931a96768321f2c8eb292e0c9bc6b01f`, not yet published): a deterministic generator flattens exported interface inheritance, records the exact `api.ts` source SHA-256, regenerates browser-safe field metadata under the publication lock, and the seeded checker consumes the generated artifact.
- Local candidate period-close kernel issuance (`e2ea654d3bc04dec4b50f835cdc51a162eba8438`, not yet published): active finalized close snapshots issue one idempotent exact Evidence/Claim pair with source-event IDs, basis-separated balances, projection digest, provisional local finality, and explicit provider-completeness caveats; the CLI finalize path performs the issuance.
- Local candidate exact allocation kernel issuance (`1428a776185ee6bef3d8cb09a18253072573ef96`, not yet published): persisted exact allocation runs issue one idempotent Evidence/Claim pair with digest-derived identity, allocated-showback semantics, exact source-event lineage, currency/basis groups and explicit partial coverage; the legacy numeric run remains separate.
- Local candidate coding-realization kernel issuance (`ad74ea3`, not yet published): the canonical realization save path automatically and atomically issues one digest-bound `value.realization_recorded` Evidence/Claim for each mature, current, fully realized unit with complete exact USD effective request attribution re-derived from the Store; partial, maturing, stale, synthetic and legacy snapshots remain compatibility-only.
- Local candidate canonical dashboard shared types (`e00f7f9`, not yet published): named browser payload interfaces now have one no-runtime source at `src/dashboard/shared-types.ts`; the locked generator emits the browser declaration copy, nested runtime metadata and source hash, and the server Overview builder consumes the same response map. The follow-on named-response checkpoint below removes the remaining inline JSON response descriptions; full docs/claim/egress generation remains open.
- Local candidate named dashboard response contracts (`cfb1fc7`, not yet published): the remaining JSON route descriptions are named (`ImportersPayload`, `DiscoverPayload`, `ScanSetupPayload`, `PricingPayload`, `RealizationPayload`, `GuidePayload`, `JudgePayload`, `ClearProposalsPayload`) and browser write methods consume those types; text/CSV remains explicit and the realization report is completed by the nested contract checkpoint below.
- Local candidate typed realization dashboard detail (`2f1e509`, not yet published): the read-only realization response now names gate outcomes, maturity/currentness, waste buckets, serial bounds, unit lineage and exact-economic coverage instead of using an opaque report record; generation remains hash-bound and lock-protected.
- Historical local verification at `2f1e509` (before publication): 1,113 root tests total (1,109 pass, 0 fail, 4 platform-conditional skips), including the shared-type/named-response/nested-realization, dashboard-contract, value-kernel and strict repricing suites; team-server 61/61 and root/team typechecks are passing. The full Node/browser build and npm pack dry-run pass at this checkpoint. At the time it was recorded, no GitHub Actions run existed because publication was blocked by the Codex usage/approval limit.
- Publication checkpoint (2026-08-31): the complete reconstruction implementation history through the typed realization dashboard detail is published on `origin/gpt56/magnum-opus-reconstruction` at implementation SHA `200b9a40fba6dd0cbe2ab2bf314e39eb214bbe32`; local/remote identity and zero divergence were verified for that implementation checkpoint. GitHub Actions CI run `33400471876` completed successfully for this exact SHA across all seven configured jobs (root Ubuntu/macOS/Windows, package smoke, and team-server Ubuntu/macOS/Windows). The follow-up register synchronization is also pushed on the same branch.
- Remaining-work audit commit: `5e5a82843154a6fd04e0017538919108c5ff06f1`
- Luna resume-protocol commit: `5c4de94cf7af0a218ecd10946ac91577fdd9eae7`
- Base high-assurance PR: #8 (`codex/high-assurance-foundation` -> `main`)
- Reconstruction review PR: #9 against `codex/high-assurance-foundation`
- Verification-only PR: #10 against `main`; do not merge it merely because it exists.

The exact remote reconstruction SHA must always be re-read after `git fetch`; documentation/checkpoint commits can move the branch beyond the code baseline above.

## Program phase

`M0 stabilization complete; M1/M2 kernel-to-billing integration active; local M2 exact economic/period-close/allocation/value kernel bridges, team-transport, CapabilitySpec, canonical/generated dashboard type source, named JSON response contracts, and typed realization detail under verification`

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
- [x] GitHub run `33258932047` concluded success and validates the serialization checkpoint across all seven configured jobs.

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
- [x] Exact-head GitHub run `33260565547` concluded success and validates the replay checkpoint across all seven configured jobs.

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
- [x] Normalized economic source links (`8fcd262`) are foreign-key and append-only protected, backfilled deterministically for pre-link rows, and cross-checked against canonical event JSON on every reload so direct SQLite writes cannot create an unlinked economic graph.
- [x] Exact budget projection migration (`05f26e6`) uses complete charge-event coverage for daily, session, and runaway enforcement, preserves live-only/imported scope, rebases only within the explicit `effective` budget-policy comparison basis, and falls back to numeric compatibility totals when legacy rows remain unresolved.
- [x] Exact economic CLI inspection (`e3a280f`) exposes JSON-safe role-aware balances, canonical Money strings, source bases, event IDs and unresolved legacy coverage through `fiscus economic --json` (`--days N`/`--all`).
- [x] Additive price-correction lineage (`2b81173`) emits exact signed deltas with typed previous/replacement amounts, restricts local repricing to one estimated/list-price source, rejects provider/billed relabelling and repeated corrections, and prevents dependent records from predating their sources.
- [x] Historical exact FX lineage (`11a9212`) emits a source-bound translation with exact positive rational rate, rate provenance, effective time, source-to-target convention and explicit no-rounding policy; same-currency, cross-basis, non-terminating and ungrounded translations fail closed.
- [x] Effective correction projection and legacy-reprice convergence (`6059258`) applies validated local corrections to the explicit `effective` charge projection, emits canonical corrections from `reprice --apply` for exact rows, refuses numeric-only exact reprices atomically, and keeps legacy numeric rows as compatibility projections.
- [x] Exact-money allocation projection (`d8d260f`) preserves arbitrary-precision amounts, partitions currency/basis identities, carries source event IDs, refuses non-terminating proportional shares without a policy, and discloses unresolved legacy request coverage without writing the legacy numeric run schema.
- [x] Exact allocation persistence (`3fa9a20`) stores canonical JSON/digest runs, derives immutable IDs, persists per-line/unallocated source links with foreign keys and append-only triggers, and verifies idempotent replay and physical lineage.
- [x] Exact-allocation replay/parity hardening (`baee5c6`) ignores archived proportional placeholders, makes result ordering permutation-invariant, rejects unknown/missing envelope fields, recomputes identity/source-lineage/conservation invariants, and validates persisted timestamps.
- [x] Exact economic export surface (`c1f7ec4`) exposes original/effective Money, source bases, correction IDs and explicit legacy coverage through `Store.economicRequestsInRange()` and `fiscus export --economic`, while retaining the old numeric export as a labelled compatibility mode.
- [x] Exact economic dashboard/API projection (`ccda34d`) exposes the shared JSON-safe report at read-only `GET/HEAD /api/economic`, rejects invalid windows, and binds the browser client to the exact Money/coverage schema.
- [x] Coding value attribution and snapshot lineage (`3871b6f`) join request rows to effective exact events with alias/live scope and strict dimension checks, disclose unresolved legacy rows, expose exact rollups on realization reports, and synchronize exact snapshot lineage during repricing.
- [x] Grouped usage/cohort/model/series/budget migration (`5e54250`) exposes exact session/user/provider-model/time-bucket coverage, derives safely representable numeric projections from complete exact groups, and keeps unresolved legacy rows explicit in usage, cohort and budget advice.
- [x] Frontier/time-reclaimed exact projections (`3c71c51`) carry effective coverage into model/task cells and manual-minute strata, deriving finite numeric compatibility values only when exact coverage is complete.
- [x] Modern Value-view disclosure (`ebbc571`) renders exact/partial/legacy coverage and unresolved counts beside the spend figure without conflating it with manual-equivalent value.
- [x] Exact receipt v2 (`443c74d`) emits canonical effective Money/source/correction lineage for complete covered WorkUnits, verifies semantic consistency after signatures, and falls back to v1 for incomplete/legacy/oversized values.
- [x] Exact team-rollup v2 (`2d567c2`) carries per-project exact economic lineage in a signed versioned body; v1 remains the compatibility fallback, the team server validates v2 before storage, and `rollup_projects.economic_json` is an additive JSONB read model while the signed raw body remains authoritative.
- [x] Bounded classic Value/API exact-coverage parity (`16c5a15`) adds a defensive escaped renderer helper, discloses mature/usage/budget/project/team coverage, and types project economic lineage in the browser contract; missing coverage is rendered as `legacy_unknown`, never silently treated as exact.
- [x] Immutable refreshed-card provenance (`47ed621`) writes first-acceptance metadata beside each hash-addressed card, validates card/sidecar identity and model count on read, exposes cohort and active-card metadata, and refuses archived-card integrity mismatches.
- [x] Bounded dashboard runtime contract conformance (`e244115`) validates runtime primitive, array, record, named-interface and null-union shapes across every browser read endpoint.
- [x] Exact economic period-close lifecycle (`28905c5`) defines canonical half-open periods, exact digest-bound finalization snapshots, as-of status replay, explicit append-only reopen controls, conflict-preserving transitions, late-event blocking, JSON-safe CLI operations, and typed dashboard close state; close controls never carry a monetary amount or rewrite history.
- [x] Canonical/generated dashboard route contract (`a9ed216` + `d6243c7`) drives every API route path, methods, Allow header, CSRF gate, response binding and explicit browser-surface binding; the build regenerates the browser copy under the publication lock and a three-surface conformance test fails on drift. Payload-field schema generation and CapabilitySpec remain open.
- [x] Immutable CapabilitySpec (`0467830`) now gives every parity capability explicit schema classes, authority, egress, credential, reversibility, assurance, and CLI/API/GUI/docs bindings; the System view and parity summaries consume specs, while conservative read/destructive/planned invariants are tested.
- [x] Shared top-level dashboard payload contracts (`92ecbbd`) cover every API method (including method-specific scan and CSV envelopes), regenerate into the browser app, feed seeded runtime conformance, and make the modern API reject wrong/missing envelopes as typed boundary errors.
- [x] Generated nested dashboard-interface metadata (`aad39bc`) flattens browser interface inheritance, records the `api.ts` source hash, regenerates under the publication lock, and feeds seeded runtime conformance; the hand-written browser declarations remain reviewable and a single generated type source is still a future boundary.
- [x] Period-close kernel issuance (`e2ea654`) revalidates the active finalized snapshot and issues one exact Evidence/Claim pair with source-event, balance and digest lineage; retries are idempotent, forged/reopened/conflicted results are refused, and CLI finalize reports the kernel identities.
- [x] Exact allocation kernel issuance (`1428a77`) revalidates the digest-bound persisted exact run and issues one idempotent Evidence/Claim pair with allocated-showback semantics, exact source-event lineage, currency/basis groups and explicit partial coverage; legacy numeric allocation remains a compatibility surface.
- [x] Coding-realization kernel issuance (`ad74ea3`) automatically and atomically persists a digest-bound local lifecycle Evidence/Claim for mature, current, fully realized units whose effective request attribution is complete and matches the Store ledger; non-exact and non-terminal snapshots remain outside the kernel.
- [x] Canonical dashboard shared type source (`e00f7f9`) moves the named payload declarations into one no-runtime source, generates the browser declaration copy and nested runtime metadata under the publication lock, records the source hash, and binds the server Overview builder to the shared response map.
- [x] Named dashboard response contracts (`cfb1fc7`) replace the remaining inline JSON route descriptions with named shared interfaces and method-specific scan types; text/CSV and opaque nested realization details remain explicit.
- [x] Typed realization dashboard detail (`2f1e509`) replaces the opaque realization report with named gate, maturity, waste, serial-bound and exact-economic lineage fields in the shared generated contract.
- [x] Verification at the published implementation checkpoint `200b9a40`: 1,113 total root tests, 1,109 pass, 0 fail, 4 platform-conditional skips; shared-type/named-response/nested-realization/dashboard-contract, value-kernel, strict repricing, exact economic kernel and causal/epistemic groups pass. Team-server 61/61 and root/team typechecks pass; full build and package smoke are refreshed. Local/remote identity was verified for the implementation checkpoint; GitHub Actions run `33400471876` completed successfully across all seven configured jobs for this SHA.

This is a published reconstruction checkpoint, not a final product or release checkpoint. Coding realization, usage, cohort, budget advice, frontier cells, time-reclaimed strata, the modern and classic Value views, complete-covered receipts, signed team rollups, refreshed-card provenance, period-close controls, bounded kernel bridges for close/allocation/coding realization, the canonical/generated named dashboard type source, named JSON response contracts and typed realization detail now carry exact/evidence-bound coverage; v1 team artifacts and legacy numeric allocation runs remain compatibility projections and the live Postgres schema still needs external execution. Event-role/conservation beyond the current role-aware projection, FX consumer integration beyond source-bound translation, full docs/claim/egress generation, supersession for revised value claims, allocation-specific close binding, and unavoidable kernel issuance across the remaining billing, decision and control boundaries remain open. The economic ledger has CLI inspection/export, explicit finalize/status/reopen operations, a read-only `/api/economic` projection, and kernel Evidence/Claim paths for active closes, persisted exact allocation showback and eligible coding realization units. Remote publication is verified at `200b9a40`, and exact-SHA CI run `33400471876` is green across all seven configured jobs.

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

The latest *published* reconstruction checkpoint is green at exact persisted-reconciliation code SHA `ec8e67ad79211389ba0b8caa5cf40ceb3ccb2872`:

- local Node typecheck: pass;
- local browser typecheck: pass;
- local root suite: 1023 total, 1019 pass, 0 fail, 4 platform-conditional skips;
- local packed/installable artifact smoke: pass;
- GitHub Actions run `33262733403`: success across all seven configured jobs.

The earlier candidate through `28905c5` and the subsequent local-only rows are
historical checkpoints recorded above; their changes are included in the
published implementation checkpoint `200b9a40`. The exact-SHA remote CI result
for that implementation checkpoint is green in run `33400471876`.

The branch is still not a final product-completion baseline. M1 and later audit findings remain open or partial, and external gates remain unperformed. Do not weaken the new invariants merely to preserve superficial green status.

## Exact next actions

Current checkpoint override: team-rollup v2 is implemented at 2d567c2, bounded classic Value/API exact-coverage parity at 16c5a15, refreshed-card provenance at 47ed621, bounded runtime dashboard type conformance at e244115, exact period-close lifecycle integration at 28905c5, canonical/generated route contract enforcement at d6243c7, immutable CapabilitySpec at 0467830, shared top-level payload envelopes/client validation at 92ecbbd, generated nested interface metadata at aad39bc, period-close-to-kernel at e2ea654, exact-allocation-to-kernel at 1428a77, coding-realization-to-kernel at ad74ea3, canonical dashboard shared types at e00f7f9, named dashboard response contracts at cfb1fc7, and typed realization dashboard detail at 2f1e509; the next implementation slice is generated docs/claim/egress bindings, then unavoidable kernel issuance across the remaining billing, decision and control boundaries. The full reconstruction is published at remote SHA `200b9a40` and CI run `33400471876` is green across all seven configured jobs; live Postgres execution, allocation-specific close binding, value-claim supersession and trust-anchor governance remain explicit gates.

1. Complete the remaining universal generated dashboard/API contract work by generating documentation, claim and egress bindings from the canonical shared source. Bounded route/method/guard generation, top-level payload envelopes, generated nested interface metadata, named JSON response contracts, typed realization detail, CapabilitySpec, classic Value exact-coverage parity, refreshed-card provenance, runtime contract conformance, period-close semantics, exact allocation persistence/issuance, strict coding-realization kernel issuance and the canonical named payload source are complete in the published reconstruction; live Postgres execution, allocation-specific close binding, value-claim supersession and trust-anchor governance remain explicit gates. The exact-SHA CI run `33400471876` is green for the published tip.
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

## Dossier III execution checkpoint — WP-A01 through WP-A04 (2026-08-31)

- [x] WP-A01 (`17baca9`) makes perfect-information VoI probabilistically
  coherent: the posterior scenario mixture is the sole prior authority;
  separately supplied priors are compatibility assertions checked within
  tolerance; finite/non-negative EVPI and safe utility bounds are enforced.
- [x] WP-A02 (`651122e`) adds an exact pull-request candidate-head CI job and
  runtime checkout-SHA assertions to the integration jobs, separating merge-ref
  integration coverage from the code-under-review head. Exact run
  `33423985725` passed across eight configured jobs.
- [x] WP-A03 (`bd405d1`) makes mature coding `clean` open-world and
  completeness-gated: direct revert/incident evidence fails, maturing or
  missing completeness remains unknown, and JSON-safe witness provenance is
  revalidated at the realization kernel boundary.
- [x] WP-A04 (`66320e4`) centralizes bounded resource policy and explicit
  truncation coverage across provider ingress/response/SSE/proposal capture,
  intrinsic extraction and storage, judge/cost readers, native imports and
  transcripts, team-server bodies, canonical receipt/kernel serialization and
  publication concurrency. Partial proposal captures retain no file fragments
  and cannot satisfy acceptance. The launcher no longer holds the build gate
  during long synchronous CLI dispatch.
- [x] Exact local verification at `66320e4`: root `npm.cmd test` 1,142 total,
  1,138 pass, 0 fail, 4 Windows platform skips; team-server 62/62; root and
  browser typechecks; build; package dry-run (213 files, ~940 KB); focused A04
  adversarial suites; local/remote SHA equality and zero divergence.
- [x] Published to `origin/gpt56/magnum-opus-reconstruction`; GitHub Actions
  run `33432485480` was queued for this exact head at checkpoint creation, and
  the checkpoint left its conclusion unread.
- [!] **Read on 2026-09-01 (WP-A09): run `33432485480` concluded FAILURE.**
  `test` passed on all three operating systems and `package-smoke` passed;
  `team-server-test` failed on Ubuntu, macOS and Windows, and `candidate-head`
  failed with it. The cause was TS1294 from a team-server parameter property —
  the root typecheck cannot see `team-server/`, so the local gates this
  checkpoint records were all green while the code did not compile. The
  successor run for `f937ac2` (`33432641338`) failed the same way. Repaired at
  `31911cb`, whose exact-head run `33433920022` concluded success.

  The local evidence in this section is accurate as written. What it did not
  establish — and what the sentence above implied by omission — is that the
  published head compiled everywhere it has to.

This checkpoint does not claim the full program is complete. AII-031 is
`PARTIAL`: the future versioned streaming `.fiscuspack` format/verifier, broad
kernel issuance, exact model authority, causal correction, remaining value and
control semantics, supply-chain/UX/standards work, and all external gates remain
explicit. The next dependency-ordered packet is WP-A05 exact model attribution.

## Dossier III WP-A05 checkpoint — exact model authority (2026-08-31)

- [x] `canonicalModelAttribution()` (`7678b7b`) now ranks provider/model groups
  from one effective request-row snapshot. Exact effective `Money` is compared
  before numeric projection; exact purity uses integer-coefficient ratios;
  deterministic provider/model tie-breaking and safe numeric-edge disclosure
  are explicit.
- [x] Partial exact/legacy windows have no dominant winner, while wholly legacy
  windows retain only display labels with null cost/share. This keeps compatibility
  data visible but prevents it from entering high-assurance frontier/model-trial
  comparisons.
- [x] Live realization and transactional reprice-sync consume the same authority;
  provider identity is carried through WorkUnits/frontier cells and same-named
  models from different providers remain separate comparison identities.
- [x] Adversarial tests cover correction-changing winner semantics, partial
  coverage, equal exact ties, huge exact amounts, provider collisions and legacy
  repricing. Local root suite at this packet: 1,146 total, 1,142 pass, 0 fail,
  4 Windows platform skips; team-server 26 focused tests pass; root/browser/team
  typechecks and build pass.
- [x] Published code tip `31911cb` includes the CI portability repair for the
  typed team-server resource-limit error; local/remote identity was verified.

- [!] **Read on 2026-09-01 (WP-A09).** Run `33433809771` for the code tip
  `7678b7b` concluded FAILURE — the same team-server TS1294 as WP-A04, since
  `7678b7b` predates the repair. The exact-head run for the published tip
  `31911cb`, run `33433920022`, concluded success across all eight configured
  jobs, so this packet is remotely green at `31911cb` and was never green at
  `7678b7b`.

A01–A05 remain preserved in the history and can be independently reviewed on
GitHub.

## Dossier III WP-A06 checkpoint — causal joint decisions and publication reads (2026-08-31)

- [x] `359e4b9` makes joint cost/quality decisions and publication reads
  explicit. Local gates green at the time of publication.
- [!] **Exact-head run `33439468753` concluded FAILURE** on `package-smoke`
  only; the seven other jobs passed. The cause was not in the A06 work. See the
  launcher packet below.

## Launcher runtime-snapshot repair (2026-09-01)

The defect this packet fixed had shipped through six checkpoints because no
local gate exercises a long-lived process.

- [x] `bin/fiscus.mjs` deleted the private runtime snapshot as soon as
  `cliCompletion` resolved. `cmdStart` resolves that promise the moment its
  sockets are listening and then serves indefinitely, so a live server lost its
  own module tree and its copied `pricing`/`baselines`: `/api/overview` answered
  ENOENT on its own pricing card and `/app/main.js` 404'd. Reproduced locally
  before any fix.
- [x] Cleanup moved to `process.on('exit')`, which is the only point at which no
  copied module or resource can still be needed. Orphaned snapshots are reaped
  by owner PID liveness, never by pathname or age alone — new
  `bin/runtime-snapshot.mjs`.
- [x] The structural hole that let it ship is closed: `test/package-surface.ts`
  now derives the required tarball contents from the launcher's own local
  imports rather than naming one file.
- [x] Commit `404a590`; exact-head run `33473535818` concluded success across
  all eight configured jobs. Live probe after the fix: the server serves
  correctly, a force-kill leaves exactly one orphan snapshot, and the next CLI
  invocation reaps it to zero.

## Dossier III WP-A07 checkpoint — legacy value semantics (2026-09-01)

- [x] `3068350`. The RoI Index is retyped as a descriptive, preference-dependent
  composite whose geometric form follows from a stated axiom set rather than
  from economics; `θ` is correctly named the CES substitution parameter, with
  the elasticity σ = 1/(1−θ) stated separately; lens weights are disclosed
  preferences, never fitted output elasticities. `voi.ts` became
  `instrumentationSensitivity.ts` and says it is not value of information.
  `reliability()` became `localDataWeight()`; the James–Stein dominance claim is
  removed, because the theorem's conditions (p ≥ 3 Gaussian means, KNOWN
  variance, squared-error loss) do not hold for a Beta–Binomial posterior with an
  estimated hyperprior. The frontier's strongest label is
  `observational_separation`.
- [x] Enforced by pattern in the existing `public-claims-contract` sweep, so each
  prohibition is machine-checked rather than reviewed once.
- [x] Exact-head run `33474731747` concluded success across all eight jobs.
  See D-058.

## Dossier III WP-A08 checkpoint — declared models and the value/cost split (2026-09-01)

- [x] `b38aee4`. Four arbitrary constants became declared, overridable models
  with a stated basis: `DECLARED_REACH_UTILITY` (AII-011) replaces an inline
  ternary and reports itself through `impactHow`; `DECLARED_LIFT_FLOOR_FRACTION`
  (AII-010) is named, and lift bounds carry `lowBasis`/`highBasis` so a partially
  identified set is never presented as the same kind of object as a disclosed
  scenario band. The budget advisor is relabelled a heuristic scenario generator
  (AII-026). The rate-drift alarm tests that a rate is not constant and says so
  (AII-024). Exact-head run `33475544810` concluded success. See D-059.
- [x] `c1f7ac5`. `realizedValueUsd` named a COST on one payload branch and a
  VALUE on the other, which is how the value spine came to render a cost as the
  fourth claim in `metered != billed != allocated != realized value` while every
  contract test passed. Split into `spendOnRealizedUnitsUsd`,
  `acceptanceWeightedSpendUsd`, `totalSpendOnRealizedUnitsUsd` and
  `realizedSpendShare` for cost, `manualEquivalentValueUsd` for value, with both
  old identifiers banned repo-wide by a test that walks the tree. See D-060.
- [!] **Exact-head run `33477085151` for `c1f7ac5` concluded FAILURE**:
  `team-server-test` on all three operating systems, plus `candidate-head`,
  with sixteen TS2339/TS2353 errors. `team-server/` is a third compilation
  domain that the root typecheck cannot see, and it imports `ProjectValue`
  straight out of `src/team/rollup.ts`. The migration renamed `src/` only.
  This is the second time in this program that the same gap produced a red
  head — the first was TS1294 at WP-A04. Repaired in the WP-A09 packet, which
  extends the split through `team-server/` including its Postgres columns,
  extends the identifier ban to walk `team-server/`, and records the
  three-domain rule in `CLAUDE.md` so the next agent does not rediscover it.
  See D-062.

## Dossier III WP-A09 checkpoint — program evidence reconciled (2026-09-01)

- [x] Read every GitHub Actions run identifier cited anywhere in
  `docs/program/` and `docs/RELEASE-GATE.md` and recorded its actual
  conclusion. Two checkpoints had described a gate in the future tense and never
  returned to it; **both of those runs had concluded FAILURE.** All other cited
  runs were verified to have concluded success, exactly as their records
  implied.
- [x] `test/program-evidence-contract.test.ts` now requires every run identifier
  in a program record to state that run's outcome, where `PENDING` is an
  accepted and deliberately greppable outcome, and forbids predicting an
  outcome that has not been observed. No test can check whether a PENDING was
  ever revisited, so that half remains discipline — but the debt is now visible
  to `grep -rn PENDING docs/`.
- [x] The `(not yet published)` labels throughout **Current baseline** are
  historical: they record each slice's state when it was written, and every one
  of them is included in the publication checkpoint at `200b9a4`. They are not a
  claim that the branch is unpublished.

Remaining after A09: Frontier B (universal issuance legality, removal of
`established:boolean`, WorkUnit/OutcomeAdapter migration) and every external
gate. The register's `PARTIAL` rows each carry an explicit residual requirement
in `docs/program/AUDIT-REGISTER.md`; a `PARTIAL` is not a nearly-finished
`COMPLETED`.

## Continuation addendum — economic reconstruction frontier (2026-09-04)

The historical sections above preserve their original checkpoint context. The
current branch subsequently published the following bounded economic slices:

- [x] `81e0041f833752a3489d2a553bba7bc70f5e8881` persists canonical historical
  FX observations append-only with digest identity and revalidated
  serialization/read integration; explicit target-currency, rate-book,
  effective-time and recorded-time context now propagates through bounded
  Store/read-model/export/dashboard/CLI consumers. GitHub Actions run
  `33907284590` concluded successfully across all eight jobs.
- [x] `1a4e406b8aef09876220da84da584897a833c2fc` makes exact-allocation
  persistence resolve every cited multi-hop `price_corrected` predecessor
  through the validated economic ledger to its charge root, refusing an
  incomplete chain while retaining the existing exact conservation and
  finalized-close checks. GitHub Actions run `33909224912` concluded
  successfully across all eight jobs.

The latest code checkpoint is `5c8c21778f731e7409dea33936a958ec49fff170` on
`origin/gpt56/magnum-opus-reconstruction`, with CI run `33951767030` concluding
successfully across all eight jobs. Local verification at this head is
1,474 root tests total, 1,470 pass, 0 fail and 4 platform skips; root TypeScript,
build, and `git diff --check` pass. The packet inventory is **11 COMPLETED /
30 PARTIAL / 35 NOT_STARTED**.
These are bounded foundations, not final dossier completion: provider-authoritative
FX, universal consumer migration, per-link basis agreement across all adjustment
kinds, complete correction/close/supersession semantics, receipt/team
reconciliation, remaining kernel issuance boundaries and external gates remain
open. WP-F07 is partial: its new control module is observation-only and in-memory;
persistence, authorization, and real target integration remain open.

## Continuation addendum — signed `.fiscuspack` verification (2026-09-05)

- [x] `34033843aefa305dcaffe65deff59a4916191b3b` adds canonical Ed25519
  manifest signing and verification, attachment digest/completeness reporting,
  key-identity checks, and separate integrity/authenticity/truth outcomes.
  Embedded-key verification does not establish authenticity; that requires an
  explicitly supplied matching trust anchor, and truth remains
  `not_evaluated`. RED-first production/adversarial coverage passes 12/12.
  GitHub Actions run `33955176173` concluded success across all eight jobs.

WP-G05 remains `PARTIAL`: independent verification, executable cross-runtime or
hosted production-bundle interoperability, CLI/API integration, producer-key
authorization, and final packet completion remain open. The packet inventory is
still **11 COMPLETED / 30 PARTIAL / 35 NOT_STARTED**.

## Continuation addendum — countermodel decision-domain coverage (2026-09-05)

- [x] `571e5fa53b3935b9ecff9dbd283f49e69e1751bd` adds an explicit
  `FragilityAssessment.certified` outcome and a decision-domain
  `decisionCountermodels()` adapter. Certification requires non-empty complete
  assumption coverage with every recorded world explicitly excluded; live,
  pending, realized and uncovered states remain non-certifying. The decision
  adapter emits named actionable witnesses without selecting an action.
  RED-first domain coverage passes 29/29. GitHub Actions run `33956325591`
  concluded success across all eight jobs.

WP-B04 remains `PARTIAL`: value-gate, allocation, profile, minimal
cut/support-set, generalized-search and formal-completeness requirements remain
open. The packet inventory is still **11 COMPLETED / 30 PARTIAL / 35 NOT_STARTED**.

## Continuation addendum — sequential inference lane (2026-09-05)

- [x] `7562671685ce401224296f7e1836556a51dc1f77` adds a standalone sequential
  Bernoulli protocol/result lane with registered looks, explicit unsupported-domain
  refusals, canonical protocol/observation/result provenance, and semantic result
  verification that recalculates the anytime interval before use. RED-first
  anytime/sequential/causal/drift coverage passes 71/71. GitHub Actions run
  `33957557346` concluded success across all eight jobs.

WP-E07 remains `PARTIAL`: Store/CLI/dashboard integration and durable result
persistence, cluster-aware/adaptive methods, and universal causal/product claims
remain open. The packet inventory is **11 COMPLETED / 31 PARTIAL / 34 NOT_STARTED**.

## Continuation addendum — plugin process host (2026-09-05)

- [x] `74c53bb47ee876381158f821000e7ff7018fd4c2` adds a host-mediated plugin
  process path with a scrubbed environment, bounded stdio and output, request
  timeout, evidence-only parsing, and active request-ID binding. Unsupported
  OS-level isolation, direct egress, credentials, and unmediated capabilities
  are refused. RED-first plugin coverage passes 24/24. GitHub Actions run
  `33958662348` concluded success across all eight jobs.

WP-G03 remains `PARTIAL`: the process boundary is not an OS sandbox, and
durable Store/CLI/dashboard integration and hard OS resource enforcement remain
open. The packet inventory remains **11 COMPLETED / 31 PARTIAL / 34 NOT_STARTED**.

## Continuation addendum — contribution attribution (2026-09-05)

- [x] `34c82d0a0b50b0d32bcb8ff97a7d964667f733e9` adds graded contribution
  association, generated-lineage and hunk/AST precedence, confounder/candidate
  refusal, and an additive realization payload that does not feed outcome or
  value gates. RED-first contribution engine/consumer coverage passes 15/15.
  GitHub Actions run `33960160991` concluded success across all eight jobs.

WP-D03 remains `PARTIAL`: broader language/AST coverage, independent attribution
validation, benchmark completeness, and packet-level completion remain open.
The packet inventory remains **11 COMPLETED / 31 PARTIAL / 34 NOT_STARTED**.
