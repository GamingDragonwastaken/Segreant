# Fiscus current-market capability matrix

**Checkpoint:** 2026-09-21

This is a source-backed product benchmark, not a claim that Fiscus is superior
to any listed system. The comparison asks whether Fiscus should build,
interoperate, or deliberately refuse a capability. Sources are current primary
vendor/specification pages read at this checkpoint.

| Capability | Existing market baseline | Fiscus evidence today | Strategic reading |
| --- | --- | --- | --- |
| LLM application tracing, sessions, tools, prompts, evaluations | [Langfuse observability](https://langfuse.com/docs/observability/overview) and [platform overview](https://langfuse.com/docs) provide traces, prompt management, datasets, experiments, evaluations, dashboards and alerts; [Datadog Agent Observability](https://docs.datadoghq.com/llm_observability/) provides traces, operational dashboards and quality/privacy/safety investigation. | Fiscus captures local request/session/token/cost evidence and preserves minimal-egress boundaries, but is not a general LLM application tracing platform. | Interoperate with OTel/Langfuse/Datadog-style telemetry rather than clone their trace UI. Fiscus should consume only declared, bounded evidence and preserve source/coverage states. |
| Prompt versioning and prompt-to-trace analysis | [Langfuse prompt management](https://langfuse.com/docs/prompt-management/overview) versions/deploys prompts and links versions to traces. | Fiscus records model/provider/request provenance and proposal/contribution evidence; it does not manage prompts as a hosted deployment control plane. | Treat prompt identity as an optional treatment/provenance input. Do not make a prompt-management product or silently retain prompt contents. |
| Cost, token and latency analytics | [Datadog cost monitoring](https://docs.datadoghq.com/llm_observability/investigate/cost/) calculates estimated request cost from public rates/token annotations and discloses partial/unavailable cost; [Langfuse metrics](https://langfuse.com/docs/metrics/overview) slices cost/latency/quality by model, prompt and user. | Fiscus has exact Money/economic events, local/provider basis separation, retention coverage, rate-card provenance and fail-closed budget enforcement. | This is a Fiscus differentiator in semantics, not a claim of broader observability. Import/export through FOCUS/OTel adapters; never replace exact local evidence with an estimated dashboard metric. |
| Cost/usage interchange | [FOCUS Cost and Usage v1.3](https://focus.finops.org/docs/specification/v1-3/datasets/cost-and-usage/) standardizes typed dimensions/metrics and permits supplemental columns. | Fiscus has provider billing/request/economic records but no complete FOCUS adapter. | Build the adapter before inventing another export vocabulary; preserve exact basis, currency, source identity, coverage and unsupported columns. |
| GenAI telemetry vocabulary | [OpenTelemetry semantic conventions](https://opentelemetry.io/docs/specs/semconv/) and [GenAI attributes](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/) define common provider/model/token/session semantics, with mixed/development maturity and moved/deprecated entries. | Fiscus uses its own exact local records and can map provider/model/token fields, but does not claim OTel conformance. | Use OTel as a compatibility layer. OTel attributes are observations, not provider billing authority, causal evidence, or ClaimProfile support. |
| Trust/compliance/risk operations | [Vanta](https://www.vanta.com/) positions automated continuous compliance, risk, audit preparation, third-party risk and trust-center proof across many frameworks. | Fiscus has evidence/claim/egress/kernel primitives but is not a GRC platform and does not issue compliance certifications. | Preserve the original analogy only as positioning: Fiscus is “trust for AI finances,” not a Vanta substitute. Interoperate with trust/provenance exports where useful. |
| Cloud-native cost allocation and showback | [OpenCost](https://opencost.io/docs/) is a vendor-neutral open-source project for measuring and allocating cloud-infrastructure and container costs, with real-time monitoring, showback and chargeback. | Fiscus has exact local AI-economic events and allocation/showback semantics, but it is not a Kubernetes cost engine. | Interoperate at the cost/usage boundary; do not duplicate Kubernetes allocation, cluster accounting or cloud-provider billing integrations. Preserve Fiscus exact-basis and evidence-coverage semantics when importing. |
| Kubernetes cost optimization and automated actions | [IBM Kubecost](https://www.kubecost.com/) provides real-time Kubernetes visibility, allocation, cloud-bill reconciliation, optimization recommendations, budgets, forecasting, anomaly detection, governance and automated workload actions. | Fiscus has review-only recommendations and no autonomous spend/routing controller; its economic ledger is AI-request oriented rather than Kubernetes-resource oriented. | Treat Kubecost/OpenCost as category substitutes for Kubernetes FinOps. Fiscus may interoperate with their exports, but must not claim generic cloud-cost or automated-optimization novelty. |
| AI lifecycle governance, risk and compliance | [IBM watsonx.governance](https://www.ibm.com/docs/en/watsonx/saas?topic=governing-ai) tracks AI assets and prompt templates through lifecycle stages, supports evaluation/monitoring, factsheets, risk/compliance workflows and governance-console integrations. | Fiscus has a local evidence/claim kernel and financial provenance, not an enterprise AI-GRC inventory or regulatory-compliance suite. | Interoperate with governance/provenance exports; keep Fiscus’s scope as AI-finance evidence and exact economic truth, not model-risk certification or compliance management. |
| Portable provenance and signed statements | W3C PROV, VC/Data Integrity, in-toto/SLSA and related standards cover provenance relationships, signed credentials/proofs and build provenance. | Fiscus has append-only epistemic/economic ledgers, signed packs/receipts and typed non-claims. | Use mature envelopes for portability; keep Fiscus semantics for exact Money, coverage, revocation, causal identification and decision authorization. |
| Autonomous recommendations and online control | Market systems commonly offer dashboards, alerts, evals, and configurable actions; those are not evidence that an action is causally optimal or safe. | Fiscus has review-only budget advice, DAL/countermodel gates, and no autonomous spend-changing policy. | Keep human approval, evidence floors, rollback and no-action semantics. J01/J02 remain dependency-gated until causal/control foundations are real. |

## Build / interoperate / refuse

- **Build:** exact local economic truth, source/coverage/retention consequences,
  epistemic ClaimProfile, causal/legal issuance, conservative recommendation
  gates, and local-first privacy boundaries.
- **Interoperate:** FOCUS, OpenTelemetry GenAI, PROV, VC/Data Integrity and
  in-toto/SLSA through versioned adapters that preserve unsupported/partial
  states.
- **Do not duplicate:** general trace storage, hosted prompt deployment,
  generic LLM-evaluation dashboards, GRC framework automation, or a new signed
  attestation vocabulary.
- **Refuse:** any market feature whose output would be read as provider-authoritative,
  causal, complete, or safe merely because it is instrumented, signed, or scored.

## Evidence boundary

This matrix establishes current capability observations and integration choices;
it does not establish market share, superiority, pricing, customer outcomes,
certification, or historical originality. Re-run the primary-source review before
making external positioning or investment claims.

## Refresh evidence (2026-09-21)

The matrix was broadened and re-read against current primary sources for
OpenCost, IBM Kubecost and IBM watsonx.governance. The result strengthens the
substitution boundary: mature systems already cover generic cloud/Kubernetes
allocation, cost optimization, AI lifecycle governance, risk and compliance.
Fiscus’s defensible scope is the composition of exact local AI-finance
accounting, source/coverage/revocation semantics and conservative decision
evidence—not a replacement for those categories.
