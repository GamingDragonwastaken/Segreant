# Handoff — start here

One page for a new person or agent session. If it disagrees with the code or
with [docs/program/ACTIVE-EXECUTION.md](ACTIVE-EXECUTION.md), those
win and this page is stale; fix it.

## What Fiscus is

A local-first ledger and spend guard for AI coding agents. It meters traffic
through a local proxy or from tools' own logs, enforces budgets (fail-closed),
reconciles against provider billing where evidence allows, allocates to cost
centres, and measures outcomes. It keeps four claims apart: **metered usage ≠
provider-billed cost ≠ allocated cost ≠ value.** Read [README.md](../../README.md) for
the product and [PRODUCT.md](../../PRODUCT.md) for who it is for.

## State right now

- **Canonical branch:** `main`. It is the only authority. There are no
  alternate codebases.
- **The reconstruction program is finished.** Execution Dossier III (76
  packets) and Foundational Audit II (36 findings) are terminal. Do not reopen
  them, and do not cherry-pick from historical branches (`gpt56/*`,
  `luna-next/*`, `codex/*`, `agent/*`, `research/*`). Their retirement plan is
  in [docs/program/REPOSITORY-HYGIENE.md](REPOSITORY-HYGIENE.md).
- **Current phase: pre-launch.** The work is now release, positioning and
  getting real users, not more internal packets. The ordered checklist and the
  open owner decisions are in
  [ACTIVE-EXECUTION.md](ACTIVE-EXECUTION.md#current-phase-pre-launch).
- **Blocking owner decision:** the name. `fiscus` on npm belongs to an
  unrelated project in the AI-agents-and-money space
  ([NAME-COLLISION-REVIEW.md](../NAME-COLLISION-REVIEW.md)). Nothing is
  published until that is decided. Until then, never tell anyone to run
  `npx fiscus`.
- **Not done, and not claimable:** npm publication, a GitHub release, real
  provider-bill reconciliation, a causal study, outside users, independent
  security review. [EXTERNAL-GATES.md](EXTERNAL-GATES.md) says what
  each one needs.

## Where to look

| Task | Start at |
|---|---|
| Change code in a module | [CONTEXT.md](../../CONTEXT.md) routing table, then that module's `CONTEXT.md` |
| The hard rules and the three typecheck passes | [.claude/CLAUDE.md](../../.claude/CLAUDE.md) |
| What may be claimed publicly | [docs/CAPABILITY-EVIDENCE-CONTRACT.md](../CAPABILITY-EVIDENCE-CONTRACT.md) |
| User-facing docs | [docs/README.md](../README.md) |
| Cutting a release | [docs/RELEASE-PROCESS.md](../RELEASE-PROCESS.md), [docs/RELEASE-GATE.md](../RELEASE-GATE.md) |
| Why something was decided | [docs/program/DECISION-LOG.md](DECISION-LOG.md) |
| Proof the reconstruction closed | [docs/program/FINAL-GATE.md](FINAL-GATE.md) |

## Before you push

```bash
npm run typecheck:all   # root, browser app, and team-server — three separate passes
npm test                # rebuilds dist/ first
npm run test:team-server
```

Scan the diff for credentials, personal data and local paths; the repo is public.
Consequential changes go to `main` through a pull request.

## Environment

The only overrides are `FISCUS_HOME`, `FISCUS_DB` and `FISCUS_DEMO`. Use a
scratch `FISCUS_HOME` when exercising the CLI so your own ledger is untouched.
The ledger lives at `~/.fiscus/fiscus.db`.
