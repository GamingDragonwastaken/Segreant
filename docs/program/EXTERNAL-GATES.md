# External Gates

External gates are not excuses for unfinished repository work. They are facts that cannot be honestly established from source code, fixtures, simulations or self-attestation alone.

| ID | Gate | Internal preparation required | External evidence required | Acceptance criterion | Status |
| --- | --- | --- | --- | --- | --- |
| X-001 | Real provider-bill reconciliation | Provider scope, import/pull path, exact money, reconciliation residuals, provenance/export | Owner-authorized provider bill/Costs evidence for a known scope | Reconciliation run binds local and provider evidence at declared grain; residuals explained; no request-level overclaim | BLOCKED EXTERNALLY |
| X-002 | Field-valid causal net-benefit claim | Correct protocol, randomization, estimand registry, estimator, missingness/interference/compliance handling, outcome/value model | Governed prospective study with real assigned units and independently retained outcomes/costs | Preregistered analysis completes; assumptions/gates pass; result represented with valid uncertainty | BLOCKED EXTERNALLY |
| X-003 | Production team-service qualification | Production architecture, mature JOSE/auth stack or equivalent assurance, secrets, DB migration/recovery, rate limiting, authorization, backup, telemetry boundaries | Real deployment environment, IdP, Postgres/service infrastructure, operator policy | Threat model and runbook validated; restore tested; authz negative tests; production load/security evidence | BLOCKED EXTERNALLY |
| X-004 | WCAG 2.2 AA runtime evidence | Semantic DOM, keyboard/focus behavior, contrast tokens, accessible names, automated checks | Browser/runtime accessibility testing and ideally human assistive-tech review | No unresolved AA violations in supported flows; keyboard and screen-reader critical tasks work | PARTLY EXTERNAL |
| X-005 | Design-partner workflow validity | Instrumentation, onboarding, evidence inspector, exports, docs | Real users across technical and finance/ops audiences | Predefined task-success/usability/interpretability criteria met without claim confusion | BLOCKED EXTERNALLY |
| X-006 | Independent security assessment | Threat model, static/dynamic checks, SBOM, supply-chain provenance, hardened defaults | Independent reviewer/penetration assessment | No unresolved critical/high findings; medium findings triaged with explicit residual risk | BLOCKED EXTERNALLY |
| X-007 | Independent mathematical/statistical review | Formal definitions, proofs, simulations, reproducible notebooks/code, literature matrix | Qualified external reviewers | No unresolved correctness flaw in claimed theorems/estimators; novelty wording corrected where needed | BLOCKED EXTERNALLY |
| X-008 | Originality/field-leading claim | Prior-art matrix, benchmark methods, reproducible contribution | Scholarly/industry comparison and independent adoption/review | Closest prior art identified; contribution survives comparison; public language matches evidence | BLOCKED EXTERNALLY |
| X-009 | Production performance/SLA | Repeatable benchmark harness, profiling, regression budgets, representative data generator | Realistic workloads/hardware/deployment topology | Declared SLOs measured repeatedly with variance/tails; no unsupported extrapolation | PARTLY EXTERNAL |
| X-010 | Public release/package trust | Reproducible build, package smoke, provenance/signing/SBOM, changelog, support policy | Owner authorization and registry/release infrastructure | Exact release artifact digest/provenance verified after publication | OWNER-RESERVED |

## Gate protocol

For every external gate, repository work must leave:

1. an executable or precisely documented protocol;
2. required input/data schema;
3. acceptance/rejection criteria defined before data collection where applicable;
4. a place to record raw evidence and exact artifact identities;
5. a claim template that prevents the result from being overstated;
6. an explicit reason the gate cannot currently close.

External gates may not be converted into `PASS` using synthetic/demo data unless the claim is explicitly only that the protocol/software works on synthetic/demo data.
