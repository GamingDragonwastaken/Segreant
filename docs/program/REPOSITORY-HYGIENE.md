# Repository hygiene

Two owner actions that finish the move from reconstruction to a normal
repository: retiring the historical branches, and protecting `main`. Both are
prepared here and neither has been executed; each needs the repository owner.

## 1. Historical branch retirement

**Verified 2026-09-24 against a full (unshallowed) clone.** Ancestry was checked
with `git merge-base --is-ancestor`, unique commits with
`git rev-list --count origin/main..<branch>`, and content with `git cherry`,
which ignores commits whose patch already landed on `main` under a different
SHA.

> A shallow clone reports every one of these branches as divergent, with
> hundreds of "unique" commits, because it cannot see the shared history.
> Unshallow before re-checking (`git fetch --unshallow origin`).

| Branch | Tip | Relation to `main` | Commits not on `main` | Patches not on `main` | Class |
|---|---|---|---|---|---|
| `codex/high-assurance-foundation` | `31577d5` | ancestor | 0 | 0 | safe to delete |
| `gpt56/magnum-opus-reconstruction` | `254dd4c` | ancestor | 0 | 0 | safe to delete |
| `gpt56/final-reconciliation` | `0ef5670` | ancestor | 0 | 0 | safe to delete |
| `gpt56/post-merge-cleanup` | `924ed5a` | ancestor | 0 | 0 | safe to delete |
| `luna-next/wp-d04` | `c3b8f19` | divergent | 1 | 0 | safe to delete (content already on `main`) |
| `codex/fiscus-local-working-tree-snapshot-2026-08-29` | `bceaedb` | divergent | 1 | 0 | safe to delete (content already on `main`) |
| `luna-next/wp-h03` | `2941e04` | divergent | 3 | 3 | archive, then delete |
| `luna-next/wp-f06` | `d08df8f` | divergent | 1 | 1 | archive, then delete |
| `gpt56/sol-magnum-opus-integration` | `111556a` | divergent | 6 | 4 | archive, then delete |
| `research/economic-control-foundation` | `aaf23b7` | divergent | 11 | 9 | archive, then delete |
| `agent/truth-closure` | `5281f8c` | divergent | 60 | 60 | archive, then delete |

None is active or future work. Why the unmerged commits are not needed:

- `luna-next/wp-h03` (fuzz sweeps, mutation oracle, fault injection):
  superseded by `test/high-consequence-fuzz.test.ts`,
  `test/high-consequence-mutations.test.ts` and
  `test/high-consequence-fault-injection.test.ts` on `main`.
- `luna-next/wp-f06` (approval-gated generic policy lifecycle): deliberately
  not integrated. WP-F06 is superseded by the narrower J02 delegated-controller
  boundary ([ACTIVE-EXECUTION.md](ACTIVE-EXECUTION.md)).
- `gpt56/sol-magnum-opus-integration` (OIDC temporal tests, derivation
  witnesses): an early integration lane. The witness and OIDC work landed on
  `main` in later form (`test/witness-semantic-obligation.test.ts`,
  `test/epistemic-witness.test.ts`).
- `agent/truth-closure` and `research/economic-control-foundation`: August
  remediation and research lanes, including CI-trigger commits. Their
  correctness work was redone in the reconstruction; their research direction
  lives in [ECONOMIC-CONTROL-FOUNDATION.md](../ECONOMIC-CONTROL-FOUNDATION.md).

**Archiving keeps every commit.** A tag named `archive/<branch>` holds each tip,
so deleting the branch loses nothing and the SHAs cited in evidence records
stay resolvable. Tagging all eleven, including the ones that are safe to
delete outright, costs nothing and keeps the names.

Run from a full clone. This pushes eleven tags, then deletes eleven branches:

```bash
git fetch --unshallow origin 2>/dev/null; git fetch origin --prune
BRANCHES="codex/high-assurance-foundation gpt56/magnum-opus-reconstruction
gpt56/final-reconciliation gpt56/post-merge-cleanup luna-next/wp-d04
codex/fiscus-local-working-tree-snapshot-2026-08-29 luna-next/wp-h03
luna-next/wp-f06 gpt56/sol-magnum-opus-integration
research/economic-control-foundation agent/truth-closure"
for b in $BRANCHES; do git tag "archive/$b" "origin/$b"; done
git push origin $(for b in $BRANCHES; do printf 'refs/tags/archive/%s ' "$b"; done)
git ls-remote --tags origin 'refs/tags/archive/*'   # confirm all eleven landed
git push origin --delete $BRANCHES
```

Only delete after the `ls-remote` line shows all eleven tags on the remote.

## 2. Protecting `main`

`main` has no branch protection and no ruleset (observed 2026-09-24: the
public API reports `"protected": false` for `main` and an empty rule list). For a
project whose
whole method is commit-bound evidence, that is the one gap in its own
assurance: a stray force-push could rewrite the history the release gate cites.

### Policy

| Rule | Setting | Why |
|---|---|---|
| Block force pushes | on | History is evidence; SHAs in `RELEASE-GATE.md` and `DECISION-LOG.md` must keep resolving |
| Block deletion | on | Same reason |
| Require a pull request | on, **0 approvals** | A solo maintainer cannot approve their own PR, so an approval requirement would only force a bypass on every merge. The PR is still where CI runs on the exact candidate |
| Dismiss stale approvals on push | on | Applies once other reviewers exist |
| Require conversation resolution | on | Review threads must be closed before merging |
| Allowed merge method | **merge commit only** | Squash and rebase create new SHAs, which breaks exact-candidate evidence (`candidate-head` checks the PR head SHA) |
| Required checks | all ten CI jobs (below) | Each is a distinct gate: three OSes, team-server, packaged install, supply chain, accessibility, exact head |
| Require branch up to date | off | Every merge would need a re-run. `candidate-head` already verifies the exact head |
| Bypass | admins, **via pull request only** | The owner can merge a PR in an emergency, but nobody can push directly to `main` |

The ten required checks, exactly as GitHub names them (observed on run
`35743000421`, success on all ten): `test (ubuntu-latest)`, `test (macos-latest)`,
`test (windows-latest)`, `team-server-test (ubuntu-latest)`,
`team-server-test (macos-latest)`, `team-server-test (windows-latest)`,
`package-smoke`, `security`, `browser-accessibility`, `candidate-head`.

Dependabot PRs pass through the same checks, so nothing changes for them.

### Applying it

[main-ruleset.json](main-ruleset.json) encodes the policy above. To import it:
**Settings → Rules → Rulesets → New ruleset → Import a ruleset**, choose the
file, review, and **Create**. Then confirm under **Settings → Rules → Rulesets**
that "Protect main" is **Active** and targets the default branch.

If a CI job is ever renamed, its entry in the required checks must be renamed
too, or every PR will wait forever for a check that no longer exists.
