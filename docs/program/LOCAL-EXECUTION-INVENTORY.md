# Local Execution Inventory

This file is a **historical execution/retirement overlay**, not an active queue.
`PACKET-INVENTORY.md` is the canonical 76-packet ledger and
`ACTIVE-EXECUTION.md` is the canonical post-merge state.

## Final integration

- Canonical branch: `main`.
- Final reconciliation source: `0ef56701b5435e51ac8a15a4c19d4a75555c33cb`.
- PR #20 merged normally at `726ae7007bfb6abafdb7ad01e0156d424bce472e`.
- Exact candidate CI: `35743000421`, success.
- Current canonical main head: `4bc37d5891755fec4bd94b3e8dd8d4d359f57f45`.
- Current main push CI: `35765884653`, success for all nine jobs that execute on push; PR-only `candidate-head` skipped by design.
- Frozen exact candidate-head evidence remains `0ef56701b5435e51ac8a15a4c19d4a75555c33cb` / run `35743000421`, success.
- Dossier: 71 completed, 1 external, 4 superseded, 0 non-terminal.
- Foundational Audit II: 36 terminal findings.

## Historical branch retirement classification

These branch refs are **not alternate authorities** and should not be merged:

### Strictly represented by `main`

- `codex/high-assurance-foundation` — strict ancestor of `main`.
- `gpt56/magnum-opus-reconstruction` — strict ancestor of `main`.
- `gpt56/final-reconciliation` — strict ancestor of `main`.
- `gpt56/post-merge-cleanup` — was identical to the verified post-merge head
  before record-only synchronization.

These are safe branch-retirement candidates once branch deletion is available.

### Historical worker/alternate lanes

- `luna-next/wp-d04` — the contribution benchmark exists in canonical `main`.
- `luna-next/wp-h03` — the canonical tree contains the final fault-injection and
  deterministic high-consequence fuzz assurance.
- `luna-next/wp-f06` — intentionally **not** integrated as a second generic
  policy authority; WP-F06 is superseded by the narrower J02 delegated online
  control boundary.
- `gpt56/sol-magnum-opus-integration` — divergent early integration/archive lane;
  later canonical kernel/tests/program records supersede its runtime changes.
- `codex/fiscus-local-working-tree-snapshot-2026-08-29` — one-commit historical
  snapshot from before the reconstruction; canonical main is hundreds of commits
  ahead.
- `agent/truth-closure` — historical PR #1 lane; final reconstruction subsumes
  or supersedes its correctness/trust work.
- `research/economic-control-foundation` — historical research lane; the final
  economic-control/Complexity-Lab architecture is represented in canonical
  main/program records.

Do not force-move these divergent refs to make the branch list cosmetically clean.
Deleting a historical ref is preferable to rewriting it, after its retention value
is no longer needed.

## External boundary

Repository execution is closed. External field evidence remains in
`EXTERNAL-GATES.md`; it is not converted into repository completion.
