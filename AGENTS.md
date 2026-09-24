# Fiscus agent operating contract

> **Current phase (2026-09-24): pre-launch.** The reconstruction program
> (Foundational Audit II, Execution Dossier III) is closed. Start every session
> from [HANDOFF.md](HANDOFF.md), then
> [docs/program/ACTIVE-EXECUTION.md](docs/program/ACTIVE-EXECUTION.md) for the
> current checklist. The `docs/program/*` records remain the specification for
> existing behaviour; they are not a work queue, and historical branches are not
> sources to merge from.

This repository is executed under the Expert Mode / Magnum Opus standard. The
agent responsible for a task owns discovery, implementation, verification,
reconciliation, durable evidence, and handoff. A worker report, a plan, or a
passing narrow test is not completion evidence by itself.

## Autonomous skill selection

For every substantive task, ask which available skills materially improve the
result and compose the smallest sufficient set. At minimum, use the relevant
execution/orchestration, test-driven-development, debugging, git, security,
API/interface, documentation, and verification skills when their trigger
conditions apply. Prefer CodeGraph for structural code questions whenever
`.codegraph/` exists; run `codegraph status --json`, sync after source changes,
and use `codegraph explore` before broad text search. Record skill-driven
decisions in the execution evidence when they change scope, design, or proof.

## Mission and quality rules

- Treat `docs/program/*`, the controlling dossier, and Foundational Audit II as
  the specification hierarchy. Do not invent a competing architecture without
  evidence that the approved one is false.
- Preserve the distinction between the local execution overlay and the
  canonical/GitHub-facing packet register. Never infer local completion from a
  remote register, or remote completion from an unverified local claim.
- Expand the quality horizon—dependencies, standards, adversarial cases,
  privacy, operability, and future compatibility—without expanding authority
  into destructive actions, force-pushes, releases, deployments, secrets, or
  paid commitments.
- Use TDD for behavior changes: establish a meaningful RED test, implement the
  smallest correct GREEN change, then refactor only while the suite remains
  green. Use systematic debugging for failures rather than weakening tests or
  semantics.
- Make incremental, atomic commits with descriptive messages. Before every
  checkpoint, inspect the staged diff, run the strongest proportionate tests,
  check for secrets and unintended paths, and push only the intended branch.
- Do not declare a packet complete until its exact acceptance evidence exists:
  implementation, focused tests, relevant regression/baseline checks, durable
  register updates, clean scope, and an explicit residual/open-gate statement.

## Orchestration and continuity

The root agent is the reconciler and remains responsible for integration. Use
bounded parallel workers only for genuinely independent packets or design
questions; isolate their work, give each a precise contract and acceptance
evidence, and never overwrite a lane with uncommitted work. Reconcile only
after focused verification and conflict checks. Maintain the durable program
registers (`LOCAL-EXECUTION-INVENTORY.md`, `PACKET-INVENTORY.md`,
`AUDIT-REGISTER.md`, `DECISION-LOG.md`, `EVIDENCE-INDEX.md`, and
`ACTIVE-EXECUTION.md`) at coherent checkpoints. Keep one supervisor at most;
never create per-worker recurring schedules or duplicate packet jobs.

When state is unchanged, do not manufacture activity. When blocked, name the
precise dependency and the strongest safe alternative. When a packet is
superseded or external-gated, preserve the reason and evidence rather than
silently reopening or claiming closure.
