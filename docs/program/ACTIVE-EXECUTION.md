# Active Execution

**Post-merge canonical state, not historical log.** The Execution Dossier III
reconstruction, final reconciliation, and post-merge assurance hardening are
integrated into `main`. Historical decisions and commit-bound evidence remain in
`DECISION-LOG.md` and `EVIDENCE-INDEX.md`.

## Canonical repository state

| Field | State |
|---|---|
| Default / implementation authority | `main` |
| Final reconciliation source head | `0ef56701b5435e51ac8a15a4c19d4a75555c33cb` |
| Final integration PR | #20 — merged with a normal merge commit |
| Merge commit | `726ae7007bfb6abafdb7ad01e0156d424bce472e` |
| Exact candidate CI | run `35743000421` — success |
| Latest verified canonical `main` head | `28dc6dd15c280086c72e018fc2fd43cfb688c965` |
| Latest canonical `main` CI | run `35773660407` — success; PR-only `candidate-head` correctly skipped on push |
| Open pull requests | none |
| Public release / npm publish / deployment | not performed |
| `main` branch protection | none (observed 2026-09-24); policy prepared in `REPOSITORY-HYGIENE.md` |

Boundaries still classified `unmigrated_authority`: none.

## Program accounting

Execution Dossier III: **76 packets — 71 `COMPLETED`, 1
`BLOCKED_EXTERNAL`, 4 `SUPERSEDED_WITH_REASON`, 0 non-terminal.**

Foundational Audit II: **36 terminal findings**, no
`OPEN/PARTIAL/IN_PROGRESS` row.

The sole dossier external packet is WP-I04's exact assistive-technology field
behavior. Chromium/axe runtime evidence is repository-complete;
NVDA/JAWS/VoiceOver behavior requires a real assistive-technology runtime.

WP-J02 is implemented: bounded online control of `budget.dailyUsd` requires a
separate delegated policy, canonical decision Claim/DAL gate, zero-exploration
v1, tail-risk circuit breaker, safe-baseline rollback, operator override,
append-only audit and crash-recoverable write-ahead state.

WP-F06's old generic approval-stack worker branch is intentionally superseded by
that narrower delegated-controller architecture; it is not missing implementation.

## Post-merge hardening

After PR #20, `main` gained only targeted assurance/operations work: the
`@types/node` update, executable PostgreSQL production probe and runbook,
real-provider reconciliation runbook, deterministic high-consequence fuzz/fault
injection, and program-record repair. Those code/test changes are green on push run `35765884653` at `4bc37d589...`;
the record-only follow-up `28dc6dd...` is green on push run `35773660407`. The PR-only
`candidate-head` job is intentionally skipped on push; exact-head evidence remains
run `35743000421` for frozen reconciliation head `0ef56701...`.

## Remaining work

No repository-internal dossier packet remains non-terminal. Remaining work is
external evidence or ordinary future product development:

- provider-authoritative billing reconciliation;
- a real governed causal study;
- production deployment validation;
- independent security and research review;
- real assistive-technology / field usability testing;
- longitudinal design-partner evidence;
- future release/publish/deployment actions when explicitly authorized.

Historical reconstruction, foundation, alternate integration and worker branches
are not alternate authorities. They must not be cherry-picked into `main`
because they contain commits; use `main` plus the decision/evidence records.

## Current phase: pre-launch

Opened 2026-09-24. The goal is a first release that outside people can
install, understand in thirty seconds, and use on real work, and then evidence
from those people. Internal packet work is closed; new work is ordinary product
development.

### Owner decisions (block the steps that depend on them)

| Decision | State | Blocks |
|---|---|---|
| **Name / npm package.** `fiscus` on npm belongs to an unrelated AI-agent payments project (`docs/NAME-COLLISION-REVIEW.md`). Keep the name with a different package name, or rename. | open | branding, mascot, landing page, npm publication |
| **License.** MIT today: anyone may use, modify and sell it, including you. Alternatives: Apache-2.0 (adds a patent grant), or keep the core permissive and license `team-server/` separately later. Relicensing is easy only while the owner is the sole copyright holder. | open, MIT stands until decided | first public release |
| **Sponsorship.** GitHub Sponsors button added (`.github/FUNDING.yml`). The owner must enable a GitHub Sponsors profile for the button to accept money. An in-app notice is deliberately deferred until there are users; its constraints are in `docs/NEUTRALITY.md`. | profile pending | — |
| **Branch retirement and `main` protection.** Prepared in `REPOSITORY-HYGIENE.md`. | awaiting owner action | — |

### Checklist

1. [x] Public story rebuilt: short README around the core workflows; the full
   reference moved to `docs/GUIDE.md`; docs index at `docs/README.md`.
2. [x] Continuity collapsed: `HANDOFF.md` is a one-page entry point; this file
   is the operational truth.
3. [x] `npx fiscus` removed from user docs; it would fetch the other project's
   package.
4. [ ] Retire historical branches (owner, `REPOSITORY-HYGIENE.md` §1).
5. [ ] Protect `main` (owner, `REPOSITORY-HYGIENE.md` §2).
6. [ ] Name decision, then rebrand: identity, mascot, screenshots, GitHub About
   text and topics, `package.json` name.
7. [ ] Release candidate: freeze a SHA, pack, install the tarball on a clean
   machine, run the CLI, demo and dashboard smoke there, and record it in
   `docs/RELEASE-GATE.md`.
8. [ ] First release: tag, GitHub Release, npm publish under the chosen name,
   then install from the registry and repeat the smoke (owner authorization).
9. [ ] Design partners: three to ten people running coding agents. Record
   install friction, time to first useful number, what they misread and what
   they stop using. This is external gate X-07.
10. [ ] Real provider reconciliation on one real account (X-01), using
    `docs/REAL-PROVIDER-RECONCILIATION-RUNBOOK.md`.
11. [ ] Public launch (Show HN and similar) only after 8 to 10 have produced
    evidence.

