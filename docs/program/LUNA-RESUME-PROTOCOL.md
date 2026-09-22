# Luna / Codex Resume Protocol

This file exists to prevent a stale local checkout from continuing development underneath the GPT-5.6 Sol reconstruction history.

## Controlling remote

- Repository: `GamingDragonwastaken/Fiscus`
- Reconstruction branch: `gpt56/magnum-opus-reconstruction`
- Remaining-work authority: `docs/program/FISCUS-REMAINING-WORK-AUDIT.md`
- Durable state: `docs/program/FISCUS-MAGNUM-OPUS-STATE.md`
- Do not develop from the old pre-reconstruction local branch merely because it already exists on disk.
- Do not merge PR #10. It exists only to make GitHub Actions evaluate the reconstruction branch against `main`.

## Mandatory local resynchronization before editing

The next Luna/Codex run MUST build forward from the current remote reconstruction history.

1. Record the current local state before touching refs:

```bash
git status
git branch --show-current
git rev-parse HEAD
```

2. Preserve any unique local work. If there are uncommitted changes, stash them or commit them on a clearly named salvage branch. If there are local-only commits, create a durable salvage branch/tag before synchronization. Never destroy unique prior Luna work simply to obtain a clean checkout.

3. Fetch the actual remote state:

```bash
git fetch --all --prune
```

4. Inspect the current reconstruction tip rather than trusting a SHA written in an older handoff:

```bash
git rev-parse origin/gpt56/magnum-opus-reconstruction
git log --left-right --graph --oneline HEAD...origin/gpt56/magnum-opus-reconstruction
```

5. Switch to a local tracking checkout of the reconstruction branch. If the local branch has no unique commits and is clean, fast-forward only:

```bash
git switch gpt56/magnum-opus-reconstruction
git pull --ff-only origin gpt56/magnum-opus-reconstruction
```

If that local branch is stale/divergent, first preserve all unique work as described above. Once preservation is verified, it is acceptable to hard-align the **local checkout only** to the remote reconstruction tip:

```bash
git reset --hard origin/gpt56/magnum-opus-reconstruction
```

This command is permitted only after unique local work has been salvaged. Never force-push or rewrite the remote reconstruction branch as part of resynchronization.

6. Do not automatically merge/rebase an old Luna development branch on top of reconstruction. Review old local-only commits and cherry-pick only changes that remain compatible with Foundational Audit II and the Trusted Epistemic Kernel invariants.

7. Verify local and remote identity before building:

```bash
git rev-parse HEAD
git rev-parse origin/gpt56/magnum-opus-reconstruction
```

These SHAs must match before the baseline build unless Luna intentionally creates a new child branch from that exact remote tip.

8. Install/update dependencies from the repository lockfiles, then run the strongest local baseline available (typecheck/build/tests/package smoke and any relevant workspace suites). Do not make intentionally RED TDD specifications green by weakening them.

9. Continue development either directly on the reconstruction branch or on a child branch created from its exact current tip. All new work must build forward from the synchronized reconstruction history, not from the stale pre-reconstruction checkout.

## Exact next implementation order after synchronization

1. Inspect current CI and exact remote head.
2. Implement the already-RED robust decision specification.
3. Implement the already-RED transitive revocation specification.
4. Migrate legacy coding demo fixtures to explicit required lifecycle evidence.
5. Restore exact-SHA green CI and package smoke without weakening strict realization semantics.
6. Update `FISCUS-MAGNUM-OPUS-STATE.md`, `AUDIT-REGISTER.md`, `DECISION-LOG.md`, and `EVIDENCE-INDEX.md`.
7. Continue the dependency-ordered remaining-work program in `FISCUS-REMAINING-WORK-AUDIT.md`.

## Standing rule

**Salvage unique local work -> fetch remote -> align local checkout to the current reconstruction tip -> verify exact SHA -> build/test -> continue forward.**
