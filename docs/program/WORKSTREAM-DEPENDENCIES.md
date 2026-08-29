# Workstream Dependencies

```text
W0 Baseline + durable state
  -> W1 Epistemic primitives (four-valued state, scope, grain, time)
       -> W2 Exact Money/Rate + economic basis
       -> W3 Claim/Evidence/Derivation/Supersession/Revocation
            -> W4 MeasurementModel + CompletenessWitness
                 -> W5 WorkUnit/OutcomeContract migration
                 -> W6 Economic subledger/reconciliation migration
                 -> W7 Causal estimand/design/estimator unification
                      -> W8 Utility/DecisionCertificate/VOI/regret
                           -> W9 Control policy/action certificates
  -> W10 Canonical contracts + GUI/CLI/API schema parity
  -> W11 Security/reliability/supply-chain hardening
  -> W12 Standards interoperability (FOCUS/OTel/PROV/attestations)
  -> W13 Performance/accessibility/packaging
All -> W14 external validation protocols -> W15 final adversarial audit
```

Rules:
- Legacy value features remain operational adapters where possible while constitutional semantics migrate underneath.
- No downstream module may bypass a stricter kernel invariant for backward compatibility; compatibility must occur at translation boundaries.
- Research conjectures may be implemented behind maturity labels but may not become decision-grade claims until their gate is satisfied.
