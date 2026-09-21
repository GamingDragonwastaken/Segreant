# Fiscus originality, substitution, and complexity-theater review

**Checkpoint:** 2026-09-21

This is a design review, not an originality certificate. It classifies what
Fiscus should claim, what a mature standard can replace, and what combination
may be distinctive without pretending that the combination is a new theorem.

## Substitution test

| Fiscus mechanism | Mature substitute / adjacent system | What substitution preserves | What it would lose | Decision |
| --- | --- | --- | --- | --- |
| Provider/model/token telemetry | OpenTelemetry GenAI; Langfuse; Datadog Agent Observability | Request tracing, token/session metadata, quality/latency exploration | Fiscus exact Money, local retention/coverage semantics and epistemic gates | Interoperate; do not rebuild generic tracing |
| Cost/usage exchange | FOCUS Cost and Usage | Typed dimensions/metrics and cross-provider billing interchange | Fiscus source authority, exact event lineage, retention consequences | Adapt outward through a versioned FOCUS mapper |
| Provenance graph | W3C PROV; in-toto/SLSA | Portable entity/activity/agent and build provenance | Fiscus ClaimProfile, causal identification and revocation semantics | Export/bridge; do not replace kernel |
| Signed portable attestation | W3C VC/Data Integrity | Cryptographic integrity/authorship and verifier interoperability | Fiscus truth/non-claim boundary and direct trust policy | Optional envelope only when an issuer/verifier exists |
| Compliance/trust operations | Vanta and GRC platforms | Framework monitoring, audit preparation, trust-center workflows | AI-finance exactness, causal/economic ledger and local-first boundary | Position as adjacent; integrate rather than clone |
| General model recommendations | LLM observability dashboards and model routers | Operational cost/quality comparison | Fiscus conservative evidence floor, exact Money, countermodels and no-action decision semantics | Keep Fiscus recommendation layer narrow and review-only |

## Claim taxonomy

1. **Standardized, not novel:** exact cost/usage columns, telemetry fields,
   provenance relationships, signatures, and trace/evaluation primitives.
2. **Fiscus-specific semantics:** treating financial figures as typed claims with
   exact monetary basis, source/coverage/retention consequences, and explicit
   non-claims; binding causal escalations to randomized evidence and typed
   transport/identification witnesses; keeping local-first data minimization as
   part of the accounting contract.
3. **Potentially distinctive combination:** a local AI-finance ledger that
   composes exact economic events, epistemic revocation, causal experiments,
   budget decision assurance and standard-compatible exports without presenting
   observability telemetry as financial truth. This is a product combination,
   not a novel theorem or certification.
4. **Not currently proven:** market leadership, broad provider coverage,
   external issuer authority, causal effects in deployed organizations,
   customer ROI, compliance certification, or historical originality.

## Complexity-theater guard

Every proposed advanced algorithm must identify its simple substitute, expected
decision benefit, held-out evaluation, calibration/coverage, privacy boundary,
shift-abstention policy, maintenance cost and rollback. A signed standard
envelope, an LLM score, or a mathematically elaborate estimator cannot bypass
those gates. This review therefore sends adaptive OPE, online control and
complexity research back to their dependency-gated packets rather than adding
decorative machinery to Fiscus now.


