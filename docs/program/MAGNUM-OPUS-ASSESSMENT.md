# Fiscus — A Whole-Project Assessment

**Author:** Claude (Fable 5.1), acting as strategist and architect for the reconstruction program.
**Written:** 2026-09-09, against branch `gpt56/magnum-opus-reconstruction` at `7032e4c` (CI-verified, eight of eight jobs).
**Method:** six read-only survey lanes with fixed output schemas (product & positioning; epistemic kernel; money path & store; product surfaces; engineering system; program method), each told to cite `file:line`, separate verified from inferred, and score on one ladder — then my own reading of the dossier, the kernel append boundaries, and the last twenty decision records. Lane claims I could check, I checked; where I could not, this document says so.
**What this is:** an opinion with evidence, written to be argued with. **What it is not:** a decision record, a plan that replaces `FISCUS_EXECUTION_DOSSIER_III.md`, or a claim of completion. Every proposal here that changes product behaviour is a proposal until the owner decides.

The ladder used throughout, from the program's own quality standard:

```text
correct → competent → professional → excellent → exceptional → field-leading → magnum opus → potentially historic
```

---

## 0. The verdict in one page

Fiscus is an **excellent** piece of work with a **field-leading** idea inside it, held below its ceiling by three things that are each fixable: the kernel's central proof obligation is discharged by an unchecked token; a third of the kernel never runs and the two claims the product makes most often have no issuer in it; and the program's own knowledge — twenty-six instances of one defect class, a dozen hard-won rules — lives as prose that a future maintainer will not read.

The idea worth the whole project is not the ten-axis profile or the append-only DAG. It is this: **a machine-checked census of every place in a repository where the authority to strengthen a claim is exercised, with a test that walks the real import graph, refuses to be vacuous, and compares the published description of itself cell by cell.** That is a soundness argument about the *codebase*, not about the data. I have not seen it executed at this quality outside formal-methods tooling, and it is the mechanism that makes every honest limitation in this repository survive the next commit. Everything below is in service of letting that idea, and the accounting discipline it protects, outlive the people and agents who built it.

| Section | Ladder | One line |
|---|---|---|
| Product & positioning | professional | The four-way distinction is structurally enforced and genuinely rare; the audience story contradicts itself and the team story is "bring your own server". |
| Epistemic kernel | excellent | Careful primitives, best docblocks I have read at this scale, one field-leading mechanism — and a witness check that matches on `kind` alone. |
| Money path & store | excellent | Exact core, fail-closed proxy, migration-under-lock integrity — and the three deletion paths the last twenty records were about are three unwrapped statements. |
| Product surfaces | professional | The spine makes the thesis unavoidable; onboarding contradicts itself in its first sixty seconds; a plugin host with zero consumers. |
| Engineering system | excellent | Incident-documented rigor everywhere; the browser typecheck runs in one job of eight; no incremental build. |
| Program method | excellent | Falsifiable, self-correcting, honest about being wrong — and duplicated, prose-coupled, and not yet packaged as the method it is. |
| **Whole** | **excellent, with field-leading elements** | The truth boundary is small and formal as intended; it is not yet *unavoidable*, and its knowledge is not yet *durable*. |

The distance from here to magnum opus is not a matter of more features. It is four moves: make the truth boundary unavoidable (§4.1), make the kernel's obligations real rather than nominal (§4.2), issue the claims the product actually makes (§4.3), and turn the program's knowledge into instruments that outlast any agent (§7). The rest of this document is the argument for those four moves and the evidence behind them.

---

## 1. The charter of this assessment

```text
MISSION:        Say where Fiscus stands, what would make it a once-in-a-lifetime piece of work,
                and what has to change so that the work survives years of hands it cannot choose.
DELIVERABLE:    This document, committed and CI-verified like any other packet; and the defect
                packets it spawned (D-189 onward), built under the program's own TDD rule.
LEAD MODE:      Strategist / architect.
SUPPORTING:     Investigator (six survey lanes), reviewer (adversarial pass on my own draft),
                continuity manager (records that survive context resets).
EXEMPLARS:      SQLite's testing culture and public-domain longevity; seL4's separation of proof
                from code and its refusal to claim more than the proof covers; the FOCUS spec as
                interoperability discipline; Manski's partial identification as the honest shape of
                a number; in-toto/SPDX as the shape a verifiable-evidence format takes when it
                escapes one tool.
DOCTRINE:       The program's own — unknown stays unknown; withhold rather than inflate; every
                figure carries its basis; enormous at the capability boundary, tiny and formal at
                the truth boundary; build as though inspected twenty years from now.
AUTHORITY:      I may assess, propose, and build repository-internal packets under the dossier.
                Product-behaviour changes, publication, deployment, name and license are the owner's.
COMPLETION:     Each claim here is tied to a file, a line, a measured number, or is marked inferred.
RECOVERY:       If this document is wrong somewhere, the decision log is the place the correction
                lands, and the survey reports are retained in session records for re-derivation.
```

**Quality contract for the project itself** (what "magnum opus" would mean here, so the word is not decorative):

```text
QUALITY CEILING: A reference implementation other tools are measured against — the way SQLite is
                 for embedded persistence — for the specific problem of saying exactly what an AI
                 spend figure means and refusing to say more.
BENCHMARKS:      SQLite (testing depth, longevity), seL4 (proof/code boundary), FOCUS (interop),
                 METR's "19% slower" (one number the field cites), Manski (bounds over points).
DISTINCTION:     Not a dashboard. A kernel whose refusals are machine-checked against the codebase
                 that uses it, plus an evidence format that survives leaving the tool.
CRITIC:          The dossier's own — statistician, accountant, database engineer, security engineer,
                 formal-methods researcher, operator. Each rejects hand-waving in their own domain.
WEAK LINKS:      Nominal obligations; unreached code; prose-coupled knowledge; onboarding.
EVIDENCE:        Property tests over the lattice laws; an external verifier that reads Fiscus
                 evidence without Fiscus; one published, pre-registered causal study.
```

---

## 2. What Fiscus is, as I understand it

A local-first ledger and control layer for AI spend that refuses to collapse four different claims into one number: what was *metered* through a proxy or imported from tool logs, what a provider *billed*, what an *allocation* rule assigned, and what the spend *realized* as surviving work. Each claim has its own evidence standard, its own provenance columns that default to `legacy_unknown` and are never backfilled, and — increasingly — its own record in an append-only epistemic ledger whose rules refuse a claim stronger than the evidence beneath it. The product surfaces (a ~44-verb CLI and a seven-view dashboard with a four-band "spine") exist to show those claims *with their basis*, and the program that is rebuilding it is run by AI agents under an owner's dossier, recording every decision as a falsifiable entry with a counterexample.

The sentence that matters: **Fiscus is an argument that an AI cost tool can be honest, and the argument is being made in code that checks itself.** Whether it becomes a landmark depends on whether that self-checking becomes unavoidable, portable, and legible to people who never read this repository.

---

## 3. What is genuinely great

These are the parts I would defend to the demanding critic without hedging.

**3.1 The four-way distinction is load-bearing, not decorative.** Separate tables and labels (`legacy_unknown`, `not_reconciled`, `operator_declared_unverified`, `derived_allocation_of_local_estimates`), a reconciliation that *cannot* reach a zero residual by construction (`reconciled_with_residual`, never `reconciled`), and a spine that renders four bands separated by a literal `≠`. CloudZero, Datadog, LangSmith and their peers collapse cost into value routinely. This does not, and the refusal is enforced by types and schema rather than by copy. (Verified: product lane; `src/dashboard/web/app/components/spine.ts:68-97`; `src/billing/reconcile.ts`.)

**3.2 The issuance map and its test.** `src/epistemic/issuance-map.ts` declares seventeen boundaries with class, reach, and — since D-188 — an invocation entry point each; `test/issuance-map.test.ts` walks the real import closure, refuses dynamic imports that would defeat the walk, asserts its own non-vacuity, fails when any unlisted file calls `claim({`, and compares the published projection cell by cell. Separating `product` / `imported_uninvoked` / `unreached` because *imported and invoked are different facts* is a distinction most architecture-fitness work never makes. It caught its own author twice (D-184, D-188). (Verified: I wrote the last two changes and watched RED name exactly the thirteen undeclared boundaries and exactly one stale cell.)

**3.3 The exact-money core and its only door.** `money.ts` accepts only decimal strings, coefficients are `bigint`, cross-basis addition is refused, non-terminating conversion is refused rather than rounded. `Store.persistRequest` writes the legacy float row and the immutable exact charge event in one transaction, and `compatibilityCostUsd` re-derives the float from the exact amount and throws if they disagree beyond 1e-12. That is the correct answer to legacy/exact coexistence, enforced at the one place a request enters. (Verified: money lane, `src/store/db.ts:626-720`, `src/economics/money.ts:98-197`.)

**3.4 Fail-closed is real, not a slogan.** The proxy blocks on any guard exception, latches an accounting-failure state, returns 503 with `budget_enforcement_unavailable`, and logs the blocked attempt at zero cost with an *unverified* basis rather than claiming zero spend. The guard takes the max of exact and float on incomplete coverage — the fail-closed reading of two lower bounds. (Verified: `src/proxy/server.ts:450-470`, `src/budget/guard.ts:106-131`.)

**3.5 The program corrects its own record and then builds a gate so it cannot drift the same way again.** D-169 (stale boundary totals), D-184 (a reach field that lied), D-188 (a projection stale by a whole packet): each time the fix was a mechanical check, not a promise to be careful. Five of five PARTIAL packets spot-checked by the method lane name a specific missing mechanism rather than "more work needed"; five of five decision entries spot-checked cite tests that exist and assert what the entry says. That is rarer than it sounds.

**3.6 The docblocks.** The kernel lane called them the best it had read in a repository this size. They carry the failure history in the source (`D-104`, `D-106`, `D-152`, `D-184`), which is the only place a future maintainer is guaranteed to look.

---

## 4. What holds it back — ranked by consequence

Each item names its evidence and what would close it. The first three are the ones that decide whether the truth boundary is real.

### 4.1 The truth boundary is small and formal but not yet unavoidable

`EpistemicLedger.appendClaimWithinTransaction` (`src/epistemic/ledger.ts:366`) bounds a claim against its cited evidence on integrity, authenticity, coverage, grain, scope, and the *reference* of a measurement model (D-168). It does **not** bound `causality`, `finality`, the measurement *rung*, `decisionFitness`, or `epistemic`. So a claim citing one `integrity: 'unknown'` evidence may assert `causality: 'randomized'` and `finality: 'final'` and be stored. The derivation gate (`assessDerivationLegality`, consulted at `ledger.ts:523`) binds only when a boundary *voluntarily* emits a Derivation; `causal.issuance` does, and its own note admits a single claim asserting `randomized` "would have been legal". Three mechanisms disagree about monetary re-basing: the direct path permits any, the derivation path requires a `monetary_rebasing` witness, and `preservation.ts` refuses all difference — and the most permissive is the one on the shipping path while the strictest has no importer.

**Why this is first.** The dossier's thesis is "enormous at the capability boundary, tiny and formal at the truth boundary." Formal is done. *Tiny* is done. *Unavoidable* is not, and a formal gate that can be walked around is a formal gate in name. This is WP-B01's FIXED requirement and WP-R05 verbatim.

**What closes it.** One rule at commit time, not five: any claim appended in a transaction whose profile is strictly stronger than the meet of its cited evidence on an ordered axis must, by the end of that transaction, be the output of a persisted Derivation whose legality passed. `causal.issuance` already appends claim then derivation inside one `runInTransaction`, so the rule lands without breaking the one legitimate strengthener. Floors for direct claims: causality at most `observational`; `decisionFitness` at most `not_assessed`; finality no higher than what cited evidence's `finalizedAt` supports; measurement rung no higher than the registry resolves for the cited model. This is packet D in the current tranche (§9).

### 4.2 The kernel's central obligation is discharged by a token

`hasWitness` (`src/epistemic/derivation.ts:403`) matches on `kind` alone; `DerivationWitness` carries no `epistemic` field; the ledger's `sameWitnessReference` (`ledger.ts:174`) compares id, kind, evidence ids, detail, coordinates. So a registered witness whose own `epistemic` is `refuted` lifts causality from observational to randomized, and a `measurement_validation` witness citing evidence unrelated to either claim lifts measurement to `validated`. **The obligation is real; its discharge is nominal.** This is the single highest-value soundness fix in the kernel and the narrow half of it — require `epistemic: 'supported'` at resolution — is being built now (packet B, D-190). The wide half — a required-evidence predicate per witness kind — is a design decision recorded in §12.

### 4.3 The kernel protects the claims nobody disputes

Fifteen thousand seven hundred lines of kernel produce four live canonical issuance points: provider-billed reconciliation, economic period close, coding realization, causal effect. Against the product's own four-way distinction: **provider-billed** has a live canonical issuer; **allocated** has one nothing invokes (`alloc.exactRun`, `imported_uninvoked`); **realized value** has none — `value.codingRealization`'s own note says its amount is "attributed SPEND, not realized value"; **metered usage** has no kernel issuer at all, only the `display_only` `dashboard.claimSupport`. The number on the front page of the dashboard is the one the kernel does not bind.

Twelve of forty-seven kernel files — 5,441 lines, 34.6% — are imported by no product entry point: `abstract.ts`, `preservation.ts`, all five of `src/decision/`, `causal/{producer,sequential,precision}.ts`, `outcomes/registry.ts`. Unreached code is not free; it is where the next contributor learns the wrong invariants, and it is what the issuance map's `unreached` count is quietly absorbing.

**What closes it.** Issue metered usage and realized value through the kernel (WP-C01/D01 territory), and for every unreached module set one deadline: land the reviewed consumer the module's own CONTEXT.md names, or move it to a `research/` tree outside `src/` where the map does not have to account for it. The dossier's capability non-retreat rule (§7.10) is not violated by moving code that nothing runs to where its status is honest.

### 4.4 Deletion is reasoned about brilliantly and performed carelessly

`prune`, `pruneProposals`, `clearProposals` (`src/store/db.ts:2771, 2827, 2853`) are DELETE, then record, then VACUUM — three statements, no transaction, in the class with a `transaction()` helper used once. A crash between the first two recreates the exact D-170 defect the `retention_prunes` table exists to prevent. The last twenty decision records are about what a deletion *means*; the deletion itself is not atomic with the record of it. Being fixed now (packet A, D-189). Adjacent: `setProjectAlias` is INSERT then UPDATE with no transaction; deferred `BEGIN` sits beside `BEGIN IMMEDIATE` at nine sites; four `ROLLBACK`s have no inner try.

### 4.5 The ledger's content is never re-verified

`initializeSchema` runs `quick_check`, `integrity_check`, `foreign_key_check`, byte-compares append-only trigger SQL, and re-attests schema state under `BEGIN IMMEDIATE` — better than most production systems. But digests are checked on *append*, never across the retained set. An offline writer that drops a trigger, edits `event_json`, and recreates the trigger with identical SQL passes every open-time check. `CURRENT_SCHEMA_VERSION = 1` has never moved across ~20 guarded ALTERs, so the downgrade guard compares `1 > 1` and never fires. (Money lane, verified.) WP-H01's remainder.

### 4.6 The one control action that stops a developer's work compares floats

`guard.ts:156` converts exact Money to `Number`; every threshold comparison is float-against-float against a float cap from config. `SpendBasis` honestly describes the *source* of the figure; the *comparison* is not exact. This is the only place in the money path with no Money-typed counterpart, and it is the one with a consequence. WP-C01's remainder, and a one-packet fix: parse caps as `Money` at config load, compare with `compareMoney`.

### 4.7 The product story contradicts itself where a newcomer first reads it

PRODUCT.md names a persona who "will never open a terminal" and says the GUI "must be sufficient on its own"; GETTING-STARTED.md is 100% CLI and, in its first sixty seconds, tells the reader not to trust `npx fiscus` and then leads with `npx fiscus demo`. README narrows the scope to "AI coding-agent spend"; PRODUCT.md widens it to "all AI spend". The registry is honest — 16 of 53 capability rows are `full` — against a product claim of "full parity". A plugin host of 1,453 lines has zero consumers outside its own tests. None of these is a lie; all of them are the kind of drift the program refuses in numbers and tolerates in prose.

### 4.8 The program's knowledge is prose, and prose does not survive

`DECISION-LOG.md` is 2,098 lines and 471 KB. `ACTIVE-EXECUTION.md`'s narrative paragraph duplicates the log's last thirty entries at full length in a single ~3,000-word paragraph. The twenty-six-instance defect class and its dozen rules — *rank by whether the absent number is a divisor*, *sweep the operation not the feature*, *a mention is not a call*, *derive the predicate from the query not the family* — are genuine method development, and they exist only as bold sentences inside that paragraph, addressed to a reader already fluent in `retentionFloor` and `offPathBound`. Two tests make prose load-bearing via exact-phrase regexes. The method lane's verdict is exact: **a result waiting for its paper.** This is the item most relevant to the owner's stated aim, and §7 is devoted to it.

### 4.9 Smaller, verified, worth a line each

- `outcomeBounds([])` returns `{0, 0}` — an upper bound of zero from zero observations — where `anytime.ts` correctly returns `[0, 1]`. Latent (no `src/` caller). Being fixed (packet C, D-191).
- DAL-3 requires every input `randomized` *and* `validated`; the measurement module states `validated` is unreachable. The `changes_spend` gate is safe because it is unsatisfiable. Correct direction, decorative top rung (WP-F05 remainder).
- `src/epistemic/CONTEXT.md` still says "three boundaries … strengthen claims outside the kernel" (it is one); `src/measurement/CONTEXT.md` says no production site resolves a model (one does); `src/store/CONTEXT.md` says "all amounts are integer microdollars" (they are arbitrary-scale decimals). No test reads CONTEXT.md files. A projection-cell check exists for `ISSUANCE-MAP.md`; the same idea is owed to the contracts.
- The browser typecheck (`src/dashboard/web/app/tsconfig.json`) runs in one of eight CI jobs — `candidate-head`, single-OS, pull-request-only. A push to the branch that breaks the browser app is green on seven jobs.
- `build-race.test.ts` staggers two spawns with a bare 25 ms `setTimeout` — the pattern `plugins-host.test.ts` explicitly rejected.
- `scripts/generate-plugin-contract.mjs`: untracked, unreferenced by any `.json`/`.mjs`/`.ts`/`.yml`, targets a file that does not exist. Pre-existing owner work; left untouched by every packet this session, and named here because an orphaned generator is friction of the accidental kind.

---

## 5. How I would build it

If I were starting Fiscus today with what this repository has learned, I would keep more than I would change — and the changes are about *where* things sit, not *what* they are.

**Keep, unchanged in spirit:** the four-way distinction as the organizing principle; exact decimal money with basis as identity; `legacy_unknown` never backfilled; read-only by default with `--apply`; fail-closed enforcement; zero runtime dependencies at the root; append-only economic events with additive corrections; the Belnap four-valued state; the issuance map as executable architecture; per-module CONTEXT.md contracts; decision records with a counterexample and a "does not establish" section.

**Change the shape of the kernel boundary.** Today the kernel is a library that boundaries *call*; the discipline is that they must. I would make it a **wall the ledger enforces at commit**: one rule — a claim may not exceed the meet of its evidence on any ordered axis without a Derivation that legalizes it in the same transaction — and witnesses that carry their own obligation (a required-evidence predicate per kind, checked at resolution, refusing any witness not `supported`). Then `assertClaimWithinItsEvidence`, `assessDerivationLegality` and `assessPreservation` collapse into one enforcement point instead of three that disagree, and `abstract.ts` becomes a *check on the checker* (property tests over the lattice laws, exhaustive over ten axes of ≤ nine values) rather than an unreached second opinion.

**Change what the kernel issues.** Metered usage and realized value first; they are the claims on the front page. Allocation second, by wiring the exact path that already exists. Reconciliation and causal effect are already canonical. Then the kernel protects the whole distinction rather than its rarest half.

**Change where knowledge lives.** Decisions in a machine-readable schema (front-matter: id, commit, CI run, test file, claim, counterexample, not-established) so structure is validated rather than regexed; the defect class and its rules extracted into a short named method document and, where a rule is mechanizable, a lint; `ACTIVE-EXECUTION.md` cut to the dossier's own ≤100-line template with the narrative deleted in favour of pointers; a generated cross-index from packet to audit finding to decision to test. This is §7.

**Change the store's facade, not its bodies.** `Store` is a 2,875-line interface with ~145 public methods across eleven domains; the domain modules already exist. Split the facade along those seams behind a thin `Store` that owns only the connection and the transaction primitive, unify on `BEGIN IMMEDIATE`, and add a ~200-line zero-dependency tagged-template query layer that derives column nullability from the schema text and refuses `= ?` and `NOT (...)` over a nullable operand — so D-187's general shape becomes unrepresentable rather than swept.

**Change the product's front door, not its rooms.** One first-contact path that actually works (`npm install && npm run demo`, as README already has), the ~44 verbs behind `guide`/`scan` for newcomers, the spine's three stacked hedge paragraphs collapsed into one expandable evidence-status affordance, and PRODUCT.md's non-terminal persona either served by a GUI-first path or removed until it is. The precise/plain toggle stays — it changes verbosity, not claims, and the surfaces lane was right that it is not a symptom.

**Add what escapes the tool.** A published, versioned evidence format — Value Receipts and reconciliation records as a schema other software can verify without Fiscus (WP-G05/G06's `.fiscuspack` and independent verifier are exactly this) — is the move that turns a good tool into a reference. SPDX and in-toto are the precedents: the format outlived the first implementation.

**What I would not build:** a hosted service (the local-first choice is the product's honesty guarantee, and the team-server exists for the org case); a universal trust score (the dossier forbids it and it is the collapse the whole system refuses); a bundler or ORM to save a few hundred hand-rolled lines (the audit surface of `typescript` + `@types/node` is worth more than the convenience); a second causal system beside the first (WP-E02 says retire duplicates, and it is right).

---

## 6. The path to magnum opus, per section

Each row states the critic who must be satisfied and the evidence that would satisfy them. Sequencing follows the dossier's dependency order; nothing here re-plans it.

### 6.1 Epistemic kernel — from *excellent* to *field-leading*
- **Critic:** a formal-methods researcher who asks "what stops a caller?"
- **Moves:** (1) commit-time strengthening rule (§4.1); (2) witnesses carry their obligation and must be `supported` (§4.2); (3) exhaustive property tests over `mergeClaimProfiles`, `informationJoin`, `derivedBound`/`meetClaimBounds` — associativity, commutativity, idempotence, and the soundness statement `abstract.ts` asserts in prose; (4) canonical issuers for metered and realized (§4.3); (5) delete-or-wire deadline for the twelve unreached files.
- **Evidence:** a RED test at `appendClaim` that today accepts `causality: 'randomized'` on `integrity: 'unknown'` evidence, then refuses; the lattice laws proven over the finite domain; the issuance map showing four claims of four with a `product`-reached canonical issuer.

### 6.2 Money path & store — from *excellent* to *exceptional*
- **Critic:** a financial controller and a database engineer.
- **Moves:** atomic deletion (in flight); content verification at open with a checkpointed digest replay and a cross-check that `SUM(requests.cost_usd)` reconciles to the exact charge set over un-pruned windows; schema generation that actually moves; budgets compared in `Money`; property tests over money arithmetic (associativity, `a − a = 0`, normalization idempotence, JSON round-trip, allocation conservation over random weights); the typed query layer; the facade split.
- **Evidence:** a tampered-then-restored trigger detected at open; a seeded generator run over a million money operations with zero violations; `guard.ts` with no `Number()` on the comparison path.

### 6.3 Product & surfaces — from *professional* to *excellent*
- **Critic:** a first-time operator with fifteen minutes and a product designer who has shipped developer tools.
- **Moves:** fix GETTING-STARTED sequencing; `guide` as the first-contact narrative; collapse the hedge stack; serve or drop the non-terminal persona; close the nine `planned` registry rows starting with `exec` and `team-push`; wire the plugin host to one first-party consumer or move it out of `src/`.
- **Evidence:** the documented first path runs clean from a fresh clone on three operating systems (`package-smoke` already exists; extend it to the documented path); registry `full` count rising with each row backed by a parity test.

### 6.4 Engineering system — from *excellent* to *exceptional*
- **Critic:** the maintainer who inherits this in 2031.
- **Moves:** browser typecheck in the three-OS matrix; incremental compilation or an accepted minimal bundler for `npm test`; replace the 25 ms stagger with a synchronization signal; a mechanical staleness check for CONTEXT.md numeric claims; decide the orphaned generator.
- **Evidence:** a full local run under six CPU-bound processes at the same total as CI; a browser-breaking push going red on every OS.

### 6.5 Program method — from *excellent* to *field-leading*
- **Critic:** an editor who hates padding and an engineer at another company trying to use the method.
- **Moves:** §7 in full.
- **Evidence:** a stranger runs the deletion-sweep checklist on a different codebase and finds an instance; a decision entry is validated by schema rather than regex; `ACTIVE-EXECUTION.md` under 100 lines with nothing lost.

### 6.6 The one artifact that would change the field's view
- **Run and publish the pre-registered causal study** that `CAUSAL-EVIDENCE-PROTOCOL.md` scaffolds, with a positive lower bound on causal net benefit *or an honest null* — and publish the evidence format it was computed from so anyone can re-verify. METR's single number became citable; Fiscus's would be citable *and* reproducible from signed evidence. That is the difference between a good tool and a landmark, and it is an external gate the owner controls (§12).

---

## 7. What outlives any single agent

The owner's stated aim is work that survives years of hands — human and AI — that the project cannot choose. This section is the part of the assessment I would ask to be read if only one is. The program has already discovered the right principle by accident, three times: **a lesson that lives only in prose rots; a lesson that lives in a gate does not.** D-169, D-184 and D-188 were each a stale sentence caught by a check that did not exist until the sentence had already been wrong. The durability design is to stop relying on the accident.

**7.1 Decisions as data, not paragraphs.** Every `DECISION-LOG.md` entry from D-189 onward carries YAML front-matter — `id`, `commit`, `ci_run`, `tests`, `claim`, `counterexample`, `not_established`, `supersedes` — and a test validates the schema. The prose stays; the structure becomes queryable. A future agent asks "which decisions touched retention?" and gets an answer from a tool, not from reading 2,098 lines. Existing entries are back-filled *mechanically where the fields are present in the text* and marked `legacy_unstructured` where they are not — the program's own rule, applied to the program.

**7.2 The method, extracted.** A short standalone document — working title `docs/program/METHOD-ABSENCE-AS-RESULT.md` — that states the defect class in one paragraph, lists its twenty-six instances as a table (id, surface, mechanism, before/after number), and then states the rules as a numbered checklist any engineer can run on any codebase: enumerate every mutation; for each, every reader of every table it touches; for each reader, every sentence it can print; check each sentence against a truncated fixture; rank by whether the absent number is a divisor; sweep the operation, not the feature; derive the predicate from the query. The narrative paragraph in `ACTIVE-EXECUTION.md` is deleted in favour of a pointer. This is the paper the method lane said is waiting to be written, and it is the artifact most likely to be useful to people who never open this repository.

**7.3 Rules that are checks.** Of the dozen rules, at least four are mechanizable today and should become tests or lints rather than sentences: `= ?` / `NOT (...)` over a nullable column (a schema-derived sweep over SQL text in `src/store/`); a mention is not a call (already the invocation gate); a projection's cells match its source (already the map gate; owed to CONTEXT.md); a deletion is atomic with its record (a test that every `DELETE FROM` in `src/` sits inside a transaction that also writes its record, enumerated from the source so a new DELETE cannot arrive unswept). A rule that is a check needs no reader.

**7.4 The active state file, kept tiny.** The dossier's §4.5 template is ≤100 lines: executor, branch, SHAs, active packet, status, last verified commands, last CI, blockers, next action. `ACTIVE-EXECUTION.md` grew past that into a history because nowhere else held the narrative. With 7.1 and 7.2 in place it can be cut back without loss, and a test can hold the line count.

**7.5 One generated cross-index.** Packet ↔ audit finding ↔ decision ↔ test file, generated by a script from the front-matter and the inventory, committed, and checked for staleness like the payload contract is. Three hand-maintained registers held in sync by discipline plus one narrow gate become one derived view.

**7.6 Contracts that are checked.** CONTEXT.md files are the interface a newcomer reads first, and three of them are currently wrong. Numeric and structural claims in a CONTEXT.md ("N files", "no production caller of X", "all amounts are integer microdollars") are exactly the claims the map gate checks for `ISSUANCE-MAP.md`; the same shape of test over the contracts closes the class.

**7.7 An evidence format that leaves the tool.** The single most durable thing a project can do is define a format others verify. Receipts, reconciliation records, and completeness witnesses as a versioned schema with an independent verifier (WP-G05/G06) means the *evidence* outlives the *software* — the way an SPDX document is still readable after the tool that wrote it is gone.

**7.8 For the agents specifically.** Future executors will be models that have never seen this conversation. What they will read, in order: `CLAUDE.md`, `ACTIVE-EXECUTION.md`, the dossier packet, the module CONTEXT.md, the tests. Every one of those is a place a rule can live as a check rather than a sentence. The anti-pattern library in dossier §28 — twenty lessons already paid for — deserves the same treatment as the defect class: each lesson that can be a test becomes one, so the next agent cannot repeat it even if it never reads the list. That is what "survive multiple working principles" means in practice: the principles stop depending on being remembered.

---

**7.9 What parallel agents do to a shared checkout — measured, not theorised.** Three agents were run
concurrently on disjoint file sets in one working tree. The file-level isolation held; two other things did not,
and both are worth writing down because the next operator will try the same thing.

*Verification stopped being trustworthy.* `npm test` builds first, so each agent's full-suite run compiled the
others' half-finished source. Every agent reported a transient failure in a file it had never touched — one in
`negative-claim-contract.test.ts`, one in `dashboard-parity-population.test.ts`, one in `build-race.test.ts` — and
each passed alone. **A suite total measured while another agent is editing is not evidence of anything**, and the
only number that counts is the one taken on a quiet tree by the integrator. Per-packet RED evidence stayed sound,
because each RED ran against a tree where the file under test was untouched.

*Git is shared mutable state, and `--amend` is the sharp edge.* One agent's commit subject was mangled by
PowerShell here-string syntax (`@'...'@`) leaking into a Bash heredoc; while it repaired that with
`git commit --amend`, a second agent had already committed on top, so the amend rewrote **the other agent's
commit**, replacing its message with the first agent's. The content was never at risk — every file set was staged
by explicit path — but for a while the dashboard packet's permanent record described the ledger packet. It was
caught by reading `git log` rather than by any check, and repaired with `reset --soft` plus two re-commits,
verified by comparing the tree hash before and after: identical.

The rules that follow, and they are cheap: **give each agent its own worktree** when the work is parallel at all;
**never `--amend` in a shared checkout** — a bad message is repaired by the integrator, not by the author;
**always pass commit messages as a file** (`git commit -F`), never inline, because the shell quoting differs
between the tools an agent may reach for; and **stage by explicit path, never `git add -A`**, which is the one
rule that held here and is why nothing was lost. The deeper point for a program run by agents that cannot see each
other: file-level disjointness is not isolation, because the build output, the test runner and the git index are
all shared. Isolation has to be structural.

## 8. Where the lanes disagreed, and how I resolved it

- **Kernel value vs kernel cost** (technical). The kernel lane scored *excellent* and called a third of it over-built; the money lane praised the exact core the kernel sits beside. Resolution: both are right; the resolution is the delete-or-wire deadline (§4.3), not deletion. The dossier's non-retreat rule forbids removing capability; it does not require keeping unreached code inside `src/`.
- **Program records: value or ceremony** (priority). The method lane estimated 70/30 value/ceremony with the ceremony concentrated in one duplicated paragraph; the engineering lane called the volume unsustainable. Resolution: both hold — the content is valuable and the container is wrong. §7 fixes the container.
- **Local-first as strength or limit** (design). The product lane says the senior FinOps buyer wants org-wide always-on visibility and a per-machine ledger is not that; the surfaces lane found the team-server real but a multi-service errand. Resolution: local-first is the honesty guarantee and stays; the org story is the team tier made credible (WP-C06/H02), not a hosted service. Recorded as an owner decision in §12 because it touches product policy.
- **The precise/plain toggle** (design). I expected the surfaces lane to call it a symptom; it did not, on the evidence that both registers assert the same epistemic status. I accept that and dropped my own objection.
- **"Fifteen thousand lines per four issuers"** (factual). I checked the count of live canonical issuers against the map (four of six canonical are product-reached) and the closure figure (twelve unreached files) — both hold.

No dissenting risk was erased to make a cleaner conclusion; the ones I could not verify are in §13.

---

## 9. What was built from this assessment, and what it changed

Six packets were built from the findings above and are recorded in full in `DECISION-LOG.md`. Three of them
landed remote-green at `f717dd7` (all eight CI jobs); three more followed.

- **D-189 — deletion atomic with its record.** `prune`, `pruneProposals` and `clearProposals` were DELETE, then
  record, then VACUUM, with nothing binding the first two. A failure between them reproduced the exact D-170 state
  that `retention_prunes` exists to prevent. Now atomic; when the record cannot be written the DELETION gives way,
  so the code cannot manufacture an unlabelled unknown.
- **D-190 — a refuted witness cannot discharge.** `hasWitness` matched on `kind` alone and `DerivationWitness`
  carries no epistemic state, so a witness whose own record read `refuted` satisfied the obligation it had been
  refuted about, lifting a claim from observational to randomized. `conflicted` and `unknown` passed the same way.
  Only `supported` discharges now, and the set-aside citation stays in the record.
- **D-191 — no bound from nothing.** `outcomeBounds([])` returned an upper bound of **zero** from zero
  observations — the strongest possible negative claim, from no evidence. Now `[0, 1]`, matching `anytimeRateInterval`.
- **D-192 — §4.1's fix: the truth boundary became unavoidable.** The floor now applies at the direct append path
  and is refused immediately before COMMIT.
- **D-193 — two of three claim-use bars stated, the third refused with a reason.**
- **D-194 — the wire carries the claim, not a view of it.**

**Three corrections to this document's own findings, recorded rather than quietly fixed.** §4.3's framing that the
kernel "protects the claims nobody disputes" survives, but two specifics here were wrong or stale, and the manner
of the error is itself evidence for §7.6:

1. A survey lane and this document treated `AUDIT-REGISTER.md`'s AII-014 remainder column as current. It was stale
   from D-082 and stated that the wire carried four of ten axes. It did not. A packet was specced on that column
   and had to correct it mid-flight. **A register column is a claim like any other and rots the same way** — which
   is precisely the argument of §7.6, arriving as a measured instance rather than a proposal.
2. A grep-based reading concluded WP-B02 and WP-B05 were already complete because the type layer was clean. Both
   remainders lived in storage and on the wire. **The sweep was as complete as its enumeration and no more** — the
   program's own rule, applied to an assessment of the program.
3. D-192's `decisionFitness` floor was set at `insufficient`, not `not_assessed` as first specified, on measured
   grounds: the stricter floor refused a legitimate observation claim issued at `insufficient`. That ladder orders
   information, not permission, and making withholding the expensive path is the opposite of what the product needs.

## 9a. What is still queued

Under the dossier's TDD rule, as coherent packets, with RED verified against the unfixed tree:

- **D-189 — deletion atomic with its record.** `prune`, `pruneProposals`, `clearProposals` inside `transaction()`, VACUUM after commit; a test that breaks the record step and asserts the rows survive.
- **D-190 — a refuted witness cannot discharge.** At witness resolution in the ledger, `epistemic` must be `supported`; tests for `refuted`, `conflicted`, `unknown`, and a guard that `supported` still discharges exactly as before.
- **D-191 — no bound from nothing.** `outcomeBounds([])` returns `[0, 1]`, matching `anytime.ts`.
- **Next: the commit-time strengthening rule** (§4.1) — the packet that makes the truth boundary unavoidable. RED: a claim citing `integrity: 'unknown'` evidence with `causality: 'randomized'` is accepted today.

The remaining dossier packets continue in dependency order after these; this assessment does not re-sequence them.

---

## 10. What I would not do

- I would not lower DAL-3 so that something can pass it. The gate is right; the evidence is what has to rise.
- I would not add a runtime dependency to get a query builder, a bundler, or an OIDC library at the root. The team-server, which already carries `pg`, is the place that decision is legitimately different (WP-H02).
- I would not delete `src/decision/` or `abstract.ts`. I would move what nothing runs to where its status is honest.
- I would not write another remaining-work audit. This document is the last of its kind I intend to produce; from here the work is packets.
- I would not compress the decision log by summarizing entries. The counterexamples are the value; the structure around them is what changes.
- I would not build a hosted Fiscus.

---

## 11. Pre-mortem — how this goes wrong

1. **The commit-time rule breaks a legitimate issuer nobody enumerated.** Mitigation: the issuance map lists every issuer; run the RED suite against each of the four live canonical paths before enforcing.
2. **The witness-obligation change is under-scoped and a wide predicate later contradicts the narrow one.** Mitigation: the narrow rule (`supported` only) is a strict subset of any wider rule; record in D-190 that content checks are pending so nobody reads it as complete.
3. **Records reform stalls at the schema and the prose keeps growing.** Mitigation: land the front-matter test first so new entries cannot be added without it; back-fill second.
4. **The method document is written and never used outside the repo.** Mitigation: write it as a checklist with no Fiscus vocabulary in the steps; test it on `team-server/` as a first foreign codebase.
5. **Unreached kernel code is moved and then wanted.** Mitigation: `git mv` is reversible and the tests move with it; the deadline is a decision, not a deletion.
6. **A future agent reads this document as authority over the dossier.** Mitigation: the header says it is not, and the dossier's authority hierarchy (§1) puts it below every program register.

---

## 12. Owner decisions required

Flagged, not taken:

1. **Witness content obligations** (§4.2, wide half): should each witness kind carry a required-evidence predicate (e.g. `causal_identification` must cite the assignment evidence the output claim cites)? This changes what a valid witness *is*; it is the kernel's semantics, not an implementation detail.
2. **Delete-or-wire deadline for unreached kernel modules** (§4.3): move to `research/` or land consumers? Capability non-retreat says keep; where it sits is the owner's call.
3. **The non-terminal persona** (§4.7): build a GUI-first onboarding path, or remove the persona from PRODUCT.md until it exists.
4. **The plugin host** (§4.7): wire one first-party consumer, or move it out of `src/`. Also the fate of `scripts/generate-plugin-contract.mjs`.
5. **The team tier** (§8): the org story rests on it; production-gating it (WP-H02 OIDC/JOSE decision, WP-C06) is where the owner's product policy lives.
6. **The causal study** (§6.6): an external gate — real users, a pre-registration, and time.
7. **Records reform** (§7): the schema and the method document change how the program is recorded; I recommend both and will build them on instruction.

---

## 13. Evidence boundary

**Verified by me directly:** the issuance map gates and their RED/GREEN behaviour (D-184, D-188); the five `DELETE FROM` statements and the three unwrapped deletion paths (`db.ts:2771, 2827, 2853`); the `appendClaimWithinTransaction` / `appendDerivationWithinTransaction` boundaries and the ordering in `issueCausalStudyToKernel`; the profile ladders and evidence fields quoted; the dossier's packet count (76) against the inventory; repo statistics (216 source files / 77,993 lines; 270 test files / 54,641 lines; 607 commits since 2026-06-20).

**Verified by a lane and spot-checked by me:** `hasWitness` matching on kind (read `derivation.ts` region); the money lane's `prune` finding (read the function); the method lane's five-of-five decision spot-checks (I wrote three of the five entries and the tests exist).

**Reported by a lane, not independently re-run:** the 34.6% unreached kernel figure (computed by the kernel lane's own closure walk); the money lane's deferred-`BEGIN` site list and float comparison in `guard.ts`; the surfaces lane's registry counts (16/27/9/1 of 53); the engineering lane's CI-matrix observation about the browser typecheck; the product lane's document-drift quotes.

**Not inspected at all:** `src/store/causal.ts` (3,008 lines) beyond transaction shape; `team-server/test/`; `docs/ALLOCATION.md`, `docs/PROVIDER-RECONCILIATION.md`, `docs/BILLING-EVIDENCE-IMPORT.md`, `docs/TEAM-TIER-DESIGN.md` in full; whether `immutableJson` canonicalizes key order (decides whether `sameProposition`'s `JSON.stringify` comparison is a defect); runtime behaviour of the GUI in a browser.

**Inferred:** that the program prose is generated faster than any human reviews it line by line (7.5 commits/day); that unreached modules are where a contributor would learn wrong invariants (an argument, not a measurement).

---

## 14. Next actions

1. Land D-189/D-190/D-191 (in flight), push, verify eight of eight at the exact head.
2. Build the commit-time strengthening rule as the next kernel packet (RED first at `appendClaim`).
3. Continue the dossier in dependency order; this document does not re-plan it.
4. On owner instruction: the decision-record schema and test (§7.1), then the method document (§7.2), then the mechanized rules (§7.3).
5. WP-B04 (countermodel engine) is the last open packet on the B frontier; its remainder is narrower than the dossier implies -- `minimalInvalidatingAssumptionSets` is the one named function that exists nowhere, and `decisionCountermodels` has no consumer, which is an owner decision (§12 item 2) rather than a fix.
6. Revisit this assessment at the next tranche boundary and correct it in place; it is a living opinion, and the decision log is where its errors get recorded.
