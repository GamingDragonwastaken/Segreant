# Local Execution Inventory

This file is now a **historical execution overlay**, not an active queue.
`docs/program/PACKET-INVENTORY.md` is the canonical 76-packet ledger and
`docs/program/ACTIVE-EXECUTION.md` is the only current resumption state.

## Final reconciliation

- Active branch: `gpt56/final-reconciliation`.
- Integration PR: #20.
- Dossier state: 71 `COMPLETED`, 1 `BLOCKED_EXTERNAL`,
  4 `SUPERSEDED_WITH_REASON`, 0 non-terminal.
- Foundational Audit II: 36 terminal findings, no `OPEN/PARTIAL/IN_PROGRESS`.
- WP-J02 is **completed** at the bounded `budget.dailyUsd` online-control
  boundary after the owner delegated autonomous online action.
- WP-I04 is the sole dossier external packet: repository Chromium/axe evidence
  exists; exact NVDA/JAWS/VoiceOver field behavior still requires real
  assistive-technology execution.

## Historical worker-lane rule

Old `luna-next/*`, reconstruction, foundation, verification and alternate
integration lanes are historical evidence only. They must not be cherry-picked
into the final candidate merely because they contain commits: their substantive
work was either integrated, superseded, or independently reimplemented on the
canonical reconstruction/reconciliation history. PR #20 is the only intended
integration candidate.

Any future executor needing historical packet/worker detail should read
`DECISION-LOG.md` and `EVIDENCE-INDEX.md`; this file deliberately does not
repeat stale local worktree states or obsolete SHA/CI claims.

## Current acceptance boundary

The final candidate is accepted only by the exact-head and synthetic merge
candidate CI contract in `FINAL-GATE.md`. A historical green checkpoint does
not establish a later head. External field evidence remains in
`EXTERNAL-GATES.md` and is not converted into repository completion.
