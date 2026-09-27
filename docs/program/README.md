# Program records

This directory holds the records of the Fiscus reconstruction program
(Foundational Audit II and Execution Dossier III), which is **finished**. They
are kept because they are the evidence behind the code: decisions, audit
findings and commit-bound verification. They are not user documentation, and
they are not a work queue.

| File | Role |
|---|---|
| [ACTIVE-EXECUTION.md](ACTIVE-EXECUTION.md) | **Canonical operational state**: what is true now and the current phase checklist |
| [EXTERNAL-GATES.md](EXTERNAL-GATES.md) | What only the outside world can prove |
| [REPOSITORY-HYGIENE.md](REPOSITORY-HYGIENE.md) | Historical branch retirement and the `main` protection policy |
| [FINAL-GATE.md](FINAL-GATE.md) | Proof that the reconstruction was completed |
| [FISCUS-MAGNUM-OPUS-STATE.md](FISCUS-MAGNUM-OPUS-STATE.md) | Historical program closure record |
| [DECISION-LOG.md](DECISION-LOG.md) | Every consequential decision, with its reason |
| [EVIDENCE-INDEX.md](EVIDENCE-INDEX.md) | Where the evidence for each claim lives |
| [PACKET-INVENTORY.md](PACKET-INVENTORY.md), [AUDIT-REGISTER.md](AUDIT-REGISTER.md) | The terminal packet and finding ledgers |

Everything else here is a packet-level design or report referenced from those
ledgers. New work does not start from this directory; it starts from
[HANDOFF.md](HANDOFF.md).
