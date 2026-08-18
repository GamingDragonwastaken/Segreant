# Team server production validation

The team server is not production-certified merely because its HTTP/auth logic
passes unit tests. Promotion requires evidence for the deployment boundary.

## Required gates

- Real PostgreSQL: schema application, registration, transactional rollup insert,
  exact replay idempotency, aggregation, restart persistence, and rollback on a
  failed child insert.
- Identity: real configured OIDC issuer/audience, explicit dashboard subject policy,
  key rotation, expired/not-before handling, and a documented mapping decision for
  OIDC subjects versus developer signing keys.
- Transport: public traffic terminates TLS at a maintained reverse proxy/load
  balancer; plain HTTP is loopback/private only.
- Secrets: database/admin/OIDC secrets come from the deployment secret manager,
  have an owner and rotation procedure, and never enter logs.
- Operations: backup, restore, retention/deletion, monitoring, incident response,
  and upgrade/rollback are exercised, not merely documented.
- Privacy: k-anonymity and per-developer opt-in remain enforced on the deployed
  dashboard endpoints.

## Promotion criterion

Record the exact Fiscus commit, infrastructure revision, database version, OIDC
issuer, TLS endpoint, backup/restore evidence, and synthetic full-flow result.
Until those artifacts exist, describe this package as an experimental/operator-run
team service, not an enterprise production control plane.

## Current status

**UNPROVEN for Internet-facing production.** CI validates application logic. A
separate PostgreSQL integration check should validate the real adapter, while TLS,
real OIDC policy, backup/restore and incident controls remain deployment evidence.
