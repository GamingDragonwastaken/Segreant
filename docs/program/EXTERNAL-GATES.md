# External Gates

These are not repository-internal excuses. Each gate is prepared so an owner or
independent reviewer can execute it without inventing the protocol.

| Gate | Requirement | Required evidence | Acceptance criterion | Current blocker |
|---|---|---|---|---|
| X-01 Provider billing truth | Reconcile scoped Segreant observations against authoritative provider cost/bill using `docs/REAL-PROVIDER-RECONCILIATION-RUNBOOK.md` | Provider-authorized export/API evidence with account/project/time identity | Declared grain reconciliation completes with residuals explained/withheld correctly | No real provider evidence supplied |
| X-02 Causal financial result | Execute preregistered qualified study | Real assignments, adherence, outcomes, costs, missingness/interference data | Prespecified estimator + simultaneous decision criteria pass | No real governed study executed |
| X-03 Production team service | Validate actual deployment using `team-server/PRODUCTION-RUNBOOK.md` | Real IdP/Postgres/TLS/secrets/backups/authz/load evidence | Threat model and production checklist satisfied; recovery exercised | No production infrastructure authorized |
| X-04 Independent security assessment | Third-party adversarial review | Reviewer report/reproduction | No unresolved critical/high issue or documented risk acceptance by owner | External reviewer required |
| X-05 Independent research critique | Scholarly/methodological review | Paper/spec + reviewer feedback | Claimed novelty and theorem statements survive review or are corrected | External experts required |
| X-06 Field usability/accessibility | Exercise critical flows with real users and assistive technologies | Test sessions plus NVDA/JAWS/VoiceOver (or equivalent) evidence; repository Chromium/axe evidence is already complete | Defined critical flows meet the target and material field barriers are remediated | Real assistive-technology/user sessions have not been performed |
| X-07 Design-partner value | Repeated real workflow use | Longitudinal adoption/outcome evidence | Predeclared utility/reliability criteria | No design partners supplied |
