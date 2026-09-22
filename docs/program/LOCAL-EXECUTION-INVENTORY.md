# Local Execution Inventory

This file is a **historical execution overlay**, not an active queue.
`docs/program/PACKET-INVENTORY.md` is the canonical 76-packet ledger and
`docs/program/ACTIVE-EXECUTION.md` is the canonical post-merge state.

## Final integration

- Canonical branch: `main`.
- Final reconciliation source head:
  `0ef56701b5435e51ac8a15a4c19d4a75555c33cb`.
- PR #20: merged by normal merge commit
  `726ae7007bfb6abafdb7ad01e0156d424bce472e`.
- Exact candidate CI: run `35743000421`, success.
- Post-merge `main` CI: run `35743877958`, success.
- Dossier state: 71 `COMPLETED`, 1 `BLOCKED_EXTERNAL`,
  4 `SUPERSEDED_WITH_REASON`, 0 non-terminal.
- Foundational Audit II: 36 terminal findings.
- WP-J02: completed at the bounded `budget.dailyUsd` online-control boundary.
- WP-I04: repository browser/axe work complete; exact
  NVDA/JAWS/VoiceOver behavior remains external.

## Historical worker-lane rule

Old `luna-next/*`, reconstruction, foundation, verification and alternate
integration lanes are historical evidence only. Their useful work was integrated,
superseded or independently reimplemented in the final tree. They are not alternate
authorities and must not be cherry-picked into `main` merely because they contain
commits.

Any future executor needing historical packet/worker detail should read
`DECISION-LOG.md` and `EVIDENCE-INDEX.md`; this file deliberately does not
repeat stale worktree states.

## Current acceptance boundary

The dossier/reconciliation phase is closed. New engineering begins from `main`.
External field evidence remains in `EXTERNAL-GATES.md` and is not converted into
repository completion.
