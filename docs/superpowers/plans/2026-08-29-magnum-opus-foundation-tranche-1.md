# Fiscus Magnum Opus Foundation Tranche 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a green deterministic baseline and implement the first small, testable Trusted Epistemic Kernel primitives without disturbing the preserved high-assurance candidate.

**Architecture:** Work on `gpt56/magnum-opus-reconstruction`, branched from candidate `31577d5...`. First make the existing OIDC temporal boundary deterministic, then add a dependency-light kernel under `src/evidence/` whose types encode claim state, grain/scope and witness-bearing derivations. This tranche deliberately does not migrate every existing feature; later tranches consume these stable primitives.

**Tech Stack:** Node 24, strict TypeScript, `node:test`, `node:assert`, SQLite only where persistence is required. No new runtime dependency in this tranche.

**Spec:** `docs/program/FISCUS-FOUNDATIONAL-AUDIT-II-ARCHIVE.md` plus reconstructed canonical audit; `docs/program/DECISION-LOG.md`; `docs/program/AUDIT-REGISTER.md`.

## Global Constraints

- Do not modify `main`.
- Preserve PR #8 and unrelated high-assurance work.
- Exact-head CI evidence is required before calling the baseline green.
- Behavior changes use TDD; the existing macOS failure is accepted RED evidence for Task 1, but the deterministic boundary tests must also be capable of failing if verifier time moves back to ambient wall clock.
- Do not use a wider `nbf` delta as the final fix for the race.
- New kernel primitives must not claim novelty; they are Fiscus semantics built using established formal/evidence ideas.
- No feature module may silently upgrade evidence strength, grain, construct, or trust.
- No public release, merge, credentials, paid services, or production deployment.

---

### Task 1: Deterministic OIDC Time Semantics

**Files:**
- Modify: `team-server/src/oidc.ts`
- Modify: `team-server/test/oidc.test.ts`

**Interfaces:**
- Consumes: existing `OidcConfig`, `verifyIdToken`.
- Produces: `OidcConfig.nowEpochSeconds?: () => number`, defaulting to `Math.floor(Date.now()/1000)` when absent.

- [ ] **Step 1: Preserve RED evidence**

Record CI run `33222840344`, macOS team job `99020364863`, and the failing `nbf` assertion in `docs/program/EVIDENCE-INDEX.md`.

- [ ] **Step 2: Add deterministic boundary tests before production change**

Change the two `nbf` boundary tests to use a fixed verifier time:

```ts
const FIXED_NOW = 1_800_000_000;
const fixedClock = () => FIXED_NOW;

const inside = idp.sign(validPayload(idp, {
  iat: FIXED_NOW,
  exp: FIXED_NOW + 3600,
  nbf: FIXED_NOW + 60,
}));
assert.equal((await verifyIdToken(inside, cfg(idp, { nowEpochSeconds: fixedClock }))).valid, true);

const outside = idp.sign(validPayload(idp, {
  iat: FIXED_NOW,
  exp: FIXED_NOW + 3600,
  nbf: FIXED_NOW + 61,
}));
assert.equal((await verifyIdToken(outside, cfg(idp, { nowEpochSeconds: fixedClock }))).valid, false);
```

Before production support exists, typecheck/CI must fail because `nowEpochSeconds` is not part of `OidcConfig`.

- [ ] **Step 3: Implement one verifier clock sample**

Add:

```ts
export interface OidcConfig {
  issuerUrl: string;
  clientId: string;
  jwksUrl?: string;
  jwksCacheTtlMs?: number;
  nowEpochSeconds?: () => number;
}
```

Then replace the temporal-validation wall-clock sample with:

```ts
const now = cfg.nowEpochSeconds?.() ?? Math.floor(Date.now() / 1000);
```

Do not use the injected time for cache TTLs/network timeouts; it represents JWT claim-evaluation time only.

- [ ] **Step 4: Verify deterministic edge semantics**

Required behavior:

- `nbf == now + 60`: accepted if all other claims are valid;
- `nbf == now + 61`: rejected;
- `iat == now + 60`: accepted;
- `iat == now + 61`: rejected;
- `exp == now`: rejected;
- ambient JWKS delay cannot change the result under a fixed verifier clock.

Run team-server typecheck/tests in CI and inspect exact job output.

- [ ] **Step 5: Commit only the clock/test repair**

Commit message: `fix(team): make OIDC time-boundary verification deterministic`.

---

### Task 2: Establish Trusted Kernel Claim-State Primitive

**Files:**
- Create: `src/evidence/claimState.ts`
- Create: `test/evidence-claim-state.test.ts`

**Interfaces:**
- Produces:

```ts
export type ClaimState = 'unknown' | 'supported' | 'refuted' | 'conflicted';
export interface EvidencePolarity { supports: boolean; refutes: boolean; }
export function claimStateOf(evidence: Iterable<EvidencePolarity>): ClaimState;
export function mergeClaimState(a: ClaimState, b: ClaimState): ClaimState;
```

- [ ] **Step 1: Write failing truth-state tests**

Tests must establish:

```ts
claimStateOf([]) === 'unknown'
claimStateOf([{supports:true, refutes:false}]) === 'supported'
claimStateOf([{supports:false, refutes:true}]) === 'refuted'
claimStateOf([{supports:true, refutes:false},{supports:false,refutes:true}]) === 'conflicted'
```

Also prove merge is commutative, associative and idempotent over all four states using exhaustive loops.

- [ ] **Step 2: Verify RED**

Root typecheck/test must fail because the module does not exist.

- [ ] **Step 3: Implement information-preserving state algebra**

Represent each state as the pair `(positiveEvidence, negativeEvidence)` and merge with boolean OR. Do not implement precedence such as “fail wins”; conflict must survive.

- [ ] **Step 4: Verify exhaustive algebraic properties**

Run exact test file plus root suite in CI.

- [ ] **Step 5: Commit**

Commit message: `feat(evidence): add four-state claim evidence algebra`.

---

### Task 3: Grain and Scope Primitives

**Files:**
- Create: `src/evidence/grain.ts`
- Create: `src/evidence/scope.ts`
- Create: `test/evidence-grain.test.ts`

**Interfaces:**

```ts
export type GrainKind = 'request' | 'session' | 'work_unit' | 'project_day' | 'project' | 'account_day' | 'account' | 'organization' | 'custom';
export interface Grain { kind: GrainKind; key?: string; }
export type GrainRelation = 'equal' | 'coarser' | 'finer' | 'incomparable';
export function compareGrain(source: Grain, target: Grain): GrainRelation;

export interface EvidenceScope {
  organization?: string;
  account?: string;
  project?: string;
  fromEpochMs?: number;
  toEpochMs?: number;
}
export function scopeContains(outer: EvidenceScope, inner: EvidenceScope): boolean;
```

- [ ] **Step 1: Write failing grain tests**

Include:

- request is finer than project-day;
- project-day is finer than project when project means cross-period project scope;
- account-day and project-day are incomparable without an explicit relationship witness;
- custom grains compare equal only when keys match;
- unknown structural relationships return `incomparable`, never guessed.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement only conservative relations**

Do not build a total order. Encode only relations that are semantically valid independent of organization-specific hierarchy.

- [ ] **Step 4: Add No-Granularity-Laundering helper**

Produce:

```ts
export function requiresRefinementWitness(source: Grain, target: Grain): boolean;
```

It returns true for `finer` targets and for `incomparable` relations; false only for equal/coarser claims.

- [ ] **Step 5: Verify and commit**

Commit message: `feat(evidence): make scope and grain explicit claim dimensions`.

---

### Task 4: Witness-Bearing Derivation Skeleton

**Files:**
- Create: `src/evidence/derivation.ts`
- Create: `test/evidence-derivation.test.ts`

**Interfaces:**

```ts
export type WitnessKind =
  | 'identity'
  | 'authenticity'
  | 'completeness'
  | 'granularity_refinement'
  | 'measurement_validity'
  | 'causal_identification'
  | 'valuation'
  | 'allocation';

export interface DerivationWitness {
  id: string;
  kind: WitnessKind;
  sourceEvidenceIds: readonly string[];
  statement: string;
}

export interface ClaimDescriptor {
  id: string;
  state: ClaimState;
  grain: Grain;
  scope: EvidenceScope;
  evidenceIds: readonly string[];
  witnessIds: readonly string[];
}

export function validateDerivation(input: ClaimDescriptor, output: ClaimDescriptor, witnesses: readonly DerivationWitness[]): readonly string[];
```

- [ ] **Step 1: Write failing witness tests**

At minimum:

- finer output grain without `granularity_refinement` witness is rejected;
- finer grain with referenced witness is accepted by this narrow invariant;
- a negative/supporting claim cannot assert completeness-dependent strengthening merely by omitting events; this tranche represents the witness requirement but does not yet infer domain negatives automatically;
- output may preserve or weaken grain without a refinement witness.

- [ ] **Step 2: Verify RED**

- [ ] **Step 3: Implement the narrow validator**

Return structured human-readable violation codes/messages rather than throwing for ordinary invalid derivations. Do not attempt the complete future Evidence Calculus in this tranche.

- [ ] **Step 4: Verify properties and commit**

Commit message: `feat(evidence): require witnesses for claim-strengthening derivations`.

---

### Task 5: Tranche Review and State Checkpoint

**Files:**
- Modify: `docs/program/FISCUS-MAGNUM-OPUS-STATE.md`
- Modify: `docs/program/AUDIT-REGISTER.md`
- Modify: `docs/program/EVIDENCE-INDEX.md`
- Modify: `docs/program/RESEARCH-REGISTER.md`

- [ ] **Step 1: Inspect exact branch history and changed files**

Verify no `main` mutation and no unrelated source drift.

- [ ] **Step 2: Fetch exact-head workflow runs/jobs/logs**

Record run IDs and outcomes. No success claim without an exact-head completed workflow.

- [ ] **Step 3: Adversarial review**

Try to construct:

- claim-state conflict lost by merge;
- grain refinement accepted without witness;
- incomparable grains accidentally ordered;
- injected JWT clock affecting JWKS cache behavior;
- a newer SHA incorrectly inheriting an older green CI result.

- [ ] **Step 4: Update registers**

Close only evidence-supported audit items. Leave conceptual items open until migrated through production paths.

- [ ] **Step 5: Plan next tranche**

Next dependency target after this plan is exact Money/Rate + richer Trusted Kernel evidence profile/MeasurementModel, unless exact-head evidence reveals a higher-priority P0/P1.
