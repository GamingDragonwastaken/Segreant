# Workstream Dependencies

This file records dependency order so the program does not optimize visible surfaces before their semantics are trustworthy.

```text
B0 Durable state + approved audit archive
  |
  v
B1 Green deterministic exact-head baseline
  |
  +--------------------+
  |                    |
  v                    v
K1 Trusted Kernel      S1 Continuous security/reliability
  |
  +-----> M1 Exact Money/Rate
  |
  +-----> O1 WorkUnit/OutcomeContract
  |          |
  |          +-----> C1 Contribution attribution
  |
  +-----> ME1 MeasurementModel/completeness
  |
  +-----> CA1 Causal registry + inference repairs
  |             |
  |             +-----> D1 Decision engine
  |
  +-----> P1 Provenance/attestation mapping
  |
  +-----> A1 Canonical API/browser contracts
                  |
                  +-----> UX1 Progressive evidence UX

M1 + O1 + ME1 + CA1 + D1
  |
  v
E1 Economic subledger/event migration
  |
  v
C2 Control-policy certificates and safe action boundary
  |
  v
I1 Breadth/integration expansion
  |
  v
F1 Full conformance + adversarial final gate
```

## Dependency rationale

### B0 -> everything

The execution environment is not assumed persistent. Durable state and the approved architecture must live with the repository before code changes begin.

### B1 -> constitutional code

A red baseline destroys attribution of future failures. Fix the known nondeterministic OIDC test first and bind subsequent work to a green exact head.

### K1 -> M1/O1/ME1/CA1/P1/A1

Scope, grain, evidence state, derivation witnesses and revocation semantics are shared concepts. Building domain-specific replacements first would duplicate truth semantics and recreate the current split-brain architecture.

### M1 before economic subledger and decision economics

Exact monetary semantics are required before financial event sourcing, utility differences, regret, or policy constraints can claim exact financial behavior.

### O1 + ME1 before contribution/value redesign

The system must know what a work unit and outcome contract are, and what construct an observable measures, before a sophisticated contribution algorithm can be interpreted correctly.

### CA1 before D1 policy recommendations

Decision certificates consume identified sets/effects. Observational analyses may remain useful but cannot be allowed to masquerade as intervention evidence.

### A1 before deep UX parity work

The GUI should render canonical claims, not perpetuate manually duplicated payload meanings.

## Parallel-safe work

The following may proceed in parallel **after B1** if changes do not share files/interfaces without coordination:

- K1 kernel implementation and S1 bounded-input/supply-chain analysis;
- M1 exact money algebra and ME1 measurement model research/tests once kernel interfaces are stable;
- standards mapping documentation and independent benchmark harness design.

## Owner-reserved gates

The following block regardless of internal dependency completion:

- merge to `main`;
- public release/npm publication;
- license/name changes;
- production internet-facing deployment;
- use of real provider credentials;
- paid services/commitments;
- owner-value choices that cannot be derived as engineering decisions.
