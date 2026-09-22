# Governance

Fiscus is maintained by a single maintainer today. This document says what that
means in practice, what changes without a vote, and what an outsider can rely
on if the project grows past one person.

## Decision record

Every substantive design or correctness decision is written down in
[`docs/program/DECISION-LOG.md`](docs/program/DECISION-LOG.md) as a dated,
numbered entry (`D-NNN`): the problem, the concrete counterexample that showed
it, the fix, and its verification. That file — not a mailing list, not a
private channel — is the governance record. If a past decision looks wrong,
the way to challenge it is to name the entry and show a counterexample to its
verification, the same evidence standard the log itself uses.

`docs/program/PACKET-INVENTORY.md` tracks open and closed units of work
(`WP-Nxx`) against that log; it is planning state, not authority. Source code,
the test suite, and the decision log settle any disagreement between what a
document says and what the product does.

## Owner-reserved decisions

The maintainer alone decides, and no contribution or discussion changes this
without a decision-log entry recording the change:

- Publishing a package to a registry, tagging, or creating a GitHub release
  (`docs/RELEASE-PROCESS.md`).
- The project name, package name/scope, and LICENSE text or copyright
  attribution.
- Enabling, deploying, or operating any hosted or team infrastructure
  (`team-server/`).
- Accepting a new runtime dependency at the root package (`CLAUDE.md`'s
  zero-dependency rule).
- Adding a new outbound network path or changing the egress-rule vocabulary in
  [`docs/DATA-BOUNDARIES.md`](docs/DATA-BOUNDARIES.md).
- Brand, positioning, and any product/donation neutrality claim
  ([`docs/NEUTRALITY.md`](docs/NEUTRALITY.md)).

## Proposing a decision

Open an issue or PR describing the problem with a concrete example, not a
preference. A change that touches an invariant in `CLAUDE.md` or an
owner-reserved item above needs the maintainer's explicit sign-off before
merge regardless of test status; everything else is judged by
[`CONTRIBUTING.md`](CONTRIBUTING.md)'s evidence bar. Accepted decisions that
change product behavior or a stated guarantee get their own `D-NNN` entry —
the PR that lands a decision without one is incomplete.

## If this project outgrows one maintainer

No co-maintainer process exists yet. If that changes, it will be recorded as a
`D-NNN` entry in the decision log naming who has merge authority over what, and
this file will be updated to match — not the other way around.
