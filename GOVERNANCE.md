# Governance

Segreant is maintained by a single maintainer today. This document says what that
means in practice, what changes without a vote, and what an outsider can rely
on if the project grows past one person.

## Decision record

Substantive design or correctness decisions that affect contributors are
explained in the issue or pull request that lands them: the problem, a concrete
counterexample, the chosen fix, and its verification. Source code, the test
suite, the public contracts in `docs/`, and the merged review record settle any
disagreement between prose and product behaviour. Maintainer planning and audit
records are deliberately not part of the public repository or its authority.

## Owner-reserved decisions

The maintainer alone decides, and no contribution or discussion changes this
without a decision-log entry recording the change:

- Publishing a package to a registry, tagging, or creating a GitHub release
  (`docs/RELEASE-PROCESS.md`).
- The project name, package name/scope, and LICENSE text or copyright
  attribution.
- Enabling, deploying, or operating any hosted or team infrastructure
  (`team-server/`).
- Accepting a new runtime dependency at the root package (`.claude/CLAUDE.md`'s
  zero-dependency rule).
- Adding a new outbound network path or changing the egress-rule vocabulary in
  [`docs/DATA-BOUNDARIES.md`](docs/DATA-BOUNDARIES.md).
- Brand, positioning, and any product/donation neutrality claim
  ([`docs/NEUTRALITY.md`](docs/NEUTRALITY.md)).

## Proposing a decision

Open an issue or PR describing the problem with a concrete example, not a
preference. A change that touches an invariant in `.claude/CLAUDE.md` or an
owner-reserved item above needs the maintainer's explicit sign-off before
merge regardless of test status; everything else is judged by
[`CONTRIBUTING.md`](CONTRIBUTING.md)'s evidence bar. Accepted decisions that
change product behavior or a stated guarantee must update the relevant public
contract in the same PR.

## If this project outgrows one maintainer

No co-maintainer process exists yet. If that changes, this file will name who
has merge authority over what before the new process takes effect.
