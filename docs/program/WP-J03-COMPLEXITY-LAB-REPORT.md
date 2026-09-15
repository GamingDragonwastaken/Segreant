# WP-J03 Complexity Lab: Design and Precondition Audit Report

**Work Packet:** `WP-J03` — Complexity Lab
**Status:** `NOT_STARTED` (Read-only Architecture & Precondition Audit)
**Controlling Authority:** `docs/TOKEN-GOVERNANCE-AND-COMPLEXITY-LAB.md` (§6, §12), `docs/ECONOMIC-CONTROL-FOUNDATION.md` (§3), `docs/program/FISCUS-REMAINING-WORK-AUDIT.md` (lines 478, 483).

---

## 1. Executive Summary & Verification Findings

This report audits the readiness of the Fiscus codebase for **WP-J03 Complexity Lab**. The task mission mandates:
> Inspect WP-J03 Complexity Lab and implement one narrow, dependency-free foundation if the current code already exposes a measurable complexity surface; otherwise return a read-only design/precondition report rather than inventing a product.

### Core Audit Finding
**The current codebase does NOT expose an operational complexity surface.**
Specifically:
1. **Source Surface:** There are zero (`0`) files in `src/` that compute, reference, or export complexity metrics. The proposed research directory `src/research/complexity/` does not exist.
2. **CLI Surface:** `src/cli.ts` does not dispatch `fiscus lab` or `fiscus complexity`. In `test/documentation-commands.test.ts`, `fiscus lab complexity` is explicitly allowlisted under `PLANNED` with the verified reason:
   > `docs/TOKEN-GOVERNANCE-AND-COMPLEXITY-LAB.md` introduces `fiscus lab complexity` under "Proposed product boundary" and lists "Build the Complexity Lab" as future work, so its own text tells the reader it does not exist.
3. **Dashboard API Surface:** `src/dashboard/contracts.ts` declares nineteen (`19`) routes (`/api/health` through `/api/clear-proposals`); exactly zero (`0`) expose or consume complexity data.
4. **Benchmark Surface:** `scripts/benchmark.mjs` measures synthetic ingestion, epistemic issuance, and read-model assembly; no complexity benchmark exists.
5. **Economic & Frontier Alignment:** `src/value/frontier.ts` partitions work by `taskType` (from conventional commit descriptions) and reports unit size (`candidateMedianUnitLines`) purely as an observational confounder. This strictly honors `docs/ECONOMIC-CONTROL-FOUNDATION.md` §3:
   > Task complexity can be a useful feature. It must not become the central decision rule... Complexity remains in `x`; it does not become the objective.

### Conclusion
Because the existing codebase exposes no measurable complexity surface, attempting to implement an ad-hoc complexity scoring algorithm or mock router would constitute "inventing a product" and committing **complexity-theater**, violating the constitutional rules of `FISCUS-REMAINING-WORK-AUDIT.md`. Therefore, per the task contract, we return this read-only design and architecture specification while keeping the packet `NOT_STARTED` until the prerequisites are met.

---

## 2. Existing Measurable Observables in Fiscus

While no unified complexity surface exists, the repository captures several raw, content-free, and privacy-preserving observables across three operational domains that will serve as the empirical inputs to the Complexity Lab when initialized:

### 2.1 Structural Observables (Git & WorkUnits)
In `src/value/realization.ts`, `attributeCommits()` and `WorkUnit` records provide:
- `linesAdded`, `linesDeleted`: Raw diff magnitude.
- `filesChanged`: Scope of codebase modification.
- `taskType`: Categorical classification (`feature`, `fix`, `refactor`, `test`, `docs`, `perf`, `chore`, `other`) derived deterministically via `classifyTaskType(commitSubject)` in `src/value/taskType.ts`.
- `hadProposal`, `acceptance`: First-pass proposal capture and mean edit-distance acceptance.
- `survivingLines`, `survivalRatio`: Longitudinal code durability via git blame scans.

### 2.2 Execution Observables (Proxy & Request Ledger)
In `src/store/db.ts` and `src/store/economicReadModel.ts`:
- `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`.
- `durationMs`: Wall-clock request latency.
- `statusCode`: HTTP failure, retry, or rate-limit indications.
- `attributedRequests`: Multi-turn count behind a work unit.
- `provider`, `model`: Dominant model assignment.

### 2.3 Epistemic Observables (Trusted Epistemic Kernel)
In `src/epistemic/`:
- Multi-axis profiles (`ClaimProfile` across integrity, authenticity, coverage, measurement, causality, finality).
- Derivation depth and dependency fan-out in the epistemic DAG.

---

## 3. Complexity Lab Architecture Specification

When work begins on WP-J03, implementation must adhere to the product boundary defined in `docs/TOKEN-GOVERNANCE-AND-COMPLEXITY-LAB.md` §6:

```text
src/research/complexity/        # pure experimental mathematics
fiscus lab complexity ...       # read-only / local output
```

### 3.1 Guiding Invariants
1. **Isolated Research Mathematics:** The lab lives under `src/research/complexity/`. It must have zero mutating dependencies on production routing, pricing, billing, or budget enforcement.
2. **Explicitly Non-Decision-Making:** The lab outputs inspectable characterizations (`ComplexityProfile`), never automated routing mandates.
3. **Multi-Estimator Pluralism:** No single scalar is canonized. The lab maintains multiple competing estimators (Structural, IRT, Nonlinear Interaction, Epistemic Uncertainty).
4. **Provenance-Aware:** Every emitted profile identifies its feature extractor, model version, training/calibration snapshot, and input digest.

### 3.2 Canonical `ComplexityProfile` Schema
The canonical output of the lab is a composite profile rather than a collapsed scalar:

```typescript
export interface ComplexityProfile {
  readonly schemaVersion: 1;
  readonly profileId: string;
  readonly evaluatedAt: string;
  readonly subject: string; // project, workUnit, or request identifier

  /** Structural complexity: content-free observable features */
  readonly structural: {
    readonly diffVolume: { added: number; deleted: number; files: number };
    readonly contextTokens: number;
    readonly taskType: string;
    readonly toolCount: number;
  };

  /** Execution complexity: observed multi-turn dynamics */
  readonly execution: {
    readonly requestCount: number;
    readonly totalTokens: number;
    readonly reasoningTokens: number;
    readonly durationMs: number;
    readonly retryCount: number;
  };

  /** Epistemic complexity: model-conditioned predictive uncertainty */
  readonly epistemic: {
    readonly predictiveUncertainty: number | null; // U(x, a)
    readonly poolUncertainty: number | null;        // C_epistemic(x)
    readonly estimationMethod: string;
  };

  /** Model sensitivity: separation across candidate models */
  readonly modelSensitivity: {
    readonly performanceDispersion: number | null; // S_model(x)
    readonly candidatePairwiseSeparation: Record<string, number>;
  };

  /** Predicted compute distribution: stochastic forecast */
  readonly predictedCompute: {
    readonly p50Tokens: number;
    readonly p90Tokens: number;
    readonly p99Tokens: number;
    readonly cvarTokens: number;
  } | null;

  /** Quality and calibration bounds */
  readonly confidence: {
    readonly calibrationStatus: 'uncalibrated_research' | 'prospective_validated';
    readonly coverageInterval: [number, number] | null;
  };

  /** Provenance metadata */
  readonly provenance: {
    readonly estimatorId: string;
    readonly estimatorVersion: string;
    readonly inputDigest: string;
    readonly calibrationDatasetId: string | null;
  };
}
```

---

## 4. Promotion Rules Audit (Why production promotion is not yet eligible)

Section 12 of `docs/TOKEN-GOVERNANCE-AND-COMPLEXITY-LAB.md` sets ten (`10`) strict promotion rules that must pass before any Complexity Lab estimator may advance into the production decision or control plane. Here is the evaluation against the current repository state:

| Rule | Requirement | Current State | Audit Verdict |
|---|---|---|---|
| **Rule 1** | Target quantity precisely defined | "Complexity" has no mathematical consensus; no formal estimand is specified in code. | ❌ **OPEN** |
| **Rule 2** | Temporal separation of training and evaluation | No historical train/eval split or prospective dataset exists. | ❌ **OPEN** |
| **Rule 3** | Calibration error measured | No calibration error benchmarks or scoring rules (e.g. Brier score) exist. | ❌ **OPEN** |
| **Rule 4** | Simple baselines included | No baseline models (e.g., diff size alone, linear token count) are registered for competition. | ❌ **OPEN** |
| **Rule 5** | Positive incremental decision value on held-out evaluation | The decision engine (`src/decision/`) operates strictly on interval dominance and regret without complexity input. | ❌ **OPEN** |
| **Rule 6** | Robustness under distribution shift & shift-based abstention | No shift detection or abstention mechanism exists in the codebase. | ❌ **OPEN** |
| **Rule 7** | Explicit privacy & data boundaries | `docs/DATA-BOUNDARIES.md` defines egress rules, but content inspection policies for informational complexity are unbuilt. | ❌ **OPEN** |
| **Rule 8** | Feature availability proven at decision time without outcome leakage | Post-hoc realization features (diff lines, test passes) are only known *after* execution; using them for pre-routing would be outcome leakage. | ❌ **OPEN** |
| **Rule 9** | Model emits uncertainty & coverage | No conformal prediction or calibrated Bayesian intervals exist for complexity. | ❌ **OPEN** |
| **Rule 10** | Rollback / fallback exists | Routing currently defaults to direct operator/client choice; no automated routing engine exists to roll back from. | ❌ **OPEN** |

All ten promotion gates are unfulfilled. Promoting or building an uncalibrated complexity metric would directly violate the project's constitutional commitments; the packet therefore remains `NOT_STARTED`.

---

## 5. Remaining Packet Scope & External Gates

When the foundational prerequisites are established, the remaining scope of WP-J03 comprises:

1. **Research Estimator Foundation:**
   - Implement `src/research/complexity/profile.ts` declaring `ComplexityProfile`.
   - Implement a baseline structural feature extractor over local, content-free git/request observables.
   - Implement a basic Item Response Theory (2PL) task-difficulty estimator as an isolated mathematical model.
2. **Read-Only CLI Surface:**
   - Wire `fiscus lab complexity <target>` in `src/cli.ts` (once removed from `PLANNED` in `test/documentation-commands.test.ts`), outputting JSON or tabular diagnostic summaries only.
3. **Research Harness Benchmarking:**
   - Extend `scripts/benchmark.mjs` with calibration benchmarks comparing multi-feature estimators against single-variable baselines.
4. **External Gates (Cannot Be Fabricated Locally):**
   - Prospective developer-task datasets with empirical time and token outcomes.
   - Independent peer review of proposed complexity estimators against established software-engineering metrics.
   - Human validation that workload-normalized spend explanation correctly controls for task difficulty without penalizing high-SLA engineers.
