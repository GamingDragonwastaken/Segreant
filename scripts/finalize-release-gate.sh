#!/usr/bin/env bash
set -euo pipefail

CANDIDATE_SHA="163b936fb0a9aeeb41519849137e4206c3e4f774"

git cat-file -e "$CANDIDATE_SHA^{commit}"
unexpected="$(git diff --name-only "$CANDIDATE_SHA"..HEAD | grep -vE '^(\.github/workflows/(ci|final-candidate-matrix|finalize-release-record)\.yml|scripts/finalize-release-gate\.sh)$' || true)"
if [ -n "$unexpected" ]; then
  echo "Unexpected delta above verified candidate:" >&2
  echo "$unexpected" >&2
  exit 1
fi

cat >> docs/RELEASE-GATE.md <<'EOF'

### Remediation candidate record — commit `163b936`, 2026-08-19

Code candidate: `163b936fb0a9aeeb41519849137e4206c3e4f774` (`Give pricing provenance full GUI parity`). This is the frozen product tree for the truth-closure remediation. **This record is a verified remediation-candidate record, not an npm publication, production-deployment approval, or claim that every external gate is closed.**

The exact-SHA final matrix is **Final Candidate Matrix #2, run `32213075068`**. Every job in that run checked out `163b936fb0a9aeeb41519849137e4206c3e4f774` explicitly and asserted `git rev-parse HEAD` before testing. The permanent CI event on the exact product commit was `action_required` with no jobs because the commit removed the temporary verification workflow; that GitHub workflow-approval state is not used as test evidence here.

| Requirement | Result |
| --- | --- |
| Candidate identity | **Pass.** `release:verify` on exact `163b936fb0a9aeeb41519849137e4206c3e4f774` recorded `cleanBefore: true` and `cleanAfter: true`. Every Final Candidate Matrix job independently asserted the same checkout SHA. |
| Source validation | **Pass.** Exact-candidate `npm run typecheck`, **597/597 tests / 0 fail**, and `npm run build` passed. The main test suite also passed independently on Ubuntu, macOS, and Windows in run `32213075068`. |
| Packed artifact | **Pass.** Exact-candidate `npm pack` produced `fiscus-0.1.0.tgz`, **143 files**, required surfaces `bin`, compiled `dist`, pricing, baselines, and dashboard HTML present. SHA-256: `48f1678390823090cd9755a3263a085cdb4684ae26c93d9da76bef015b898031`. |
| Clean installed CLI | **Pass.** `release:verify` installed the tarball with `--ignore-scripts` into a fresh directory and invoked the installed `fiscus --help`; the final matrix repeated a clean tarball install and real bin invocation. |
| Packaged dashboard/API | **Pass (automated transport/runtime evidence).** The final matrix started the **installed tarball** with isolated `AEGIS_HOME` and labelled demo data; health, overview, value, billing, pricing coverage, root shell, browser entrypoint, value renderer, and evidence renderer were all fetched from the packaged server. The pricing check additionally proved that coverage remains read-only and is not represented as provider-billed/reconciled cost. |
| Model-trial truthfulness | **Pass for the packaged API/evidence contract.** Packaged `/api/value` self-labelled demo data and every seeded model switch remained `confidence: trial`; the matrix rejects an evidence-strength promotion. The browser module graph containing the value renderer also shipped. This row does **not** substitute for the separate visual-inspection row below. |
| Billing-boundary truthfulness | **Pass.** Packaged scope preview remained `applied: false` / `operator_declared_unverified`; the applied test scope retained its declared provider project; packaged demo `/api/billing` stayed `not_reconciled` with zero fabricated provider records. |
| Direct-Costs connector boundary | **Pass.** Packaged OpenAI Costs preview retained `networkAttempted: false` and `credentialRead: false` against an explicitly applied project scope. No live provider pull occurred. |
| Intended CI / matrix | **Pass via exact-SHA replacement evidence.** Final Candidate Matrix `32213075068` passed **8 jobs**: main Ubuntu/macOS/Windows; team-server Ubuntu/macOS/Windows; packaged candidate; and real PostgreSQL 17. The matrix was read-only and pinned the code SHA, so its workflow-definition staging commit could not alter the tested tree. |
| Visual check | **Not performed in this remediation and therefore not claimed.** The packaged browser modules and HTTP surfaces were exercised automatically, but no human/vision browser inspection of the final candidate is recorded here. `release:verify` correctly reports `visualBrowserInspection: requires_separate_evidence`. |

Additional exact-candidate evidence:

- Team server unit suite: **55/55**, independently green across Ubuntu, macOS, and Windows.
- Real `PgRollupStore` integration: **pass** against PostgreSQL 17 in the final matrix.
- GUI capability registry: **45 total = 26 full / 14 partial / 5 planned**. `budget-recommend` and the complete read-only `pricing --coverage` workflow are now full; remaining gaps retain explicit reasons and safe CLI alternatives rather than being relabelled for parity optics.
- Research/economic-control primitives are shipped as **partial, isolated research capability** only. They do not route requests or enforce policy; promotion/calibration remains an explicit future gate.
- The Store refactor moved public persistence contracts out of the SQLite implementation while preserving the `Store` façade and existing imports; no query/runtime semantics were changed by that extraction.

**External gates deliberately remain open:**

1. **Real provider reconciliation — `external_validation_required`.** No controlled finalized provider bill/account has been reconciled end to end by this remediation. Synthetic or operator-supplied evidence does not satisfy that gate.
2. **Internet-facing team deployment — `external_validation_required`.** The real PostgreSQL adapter is tested, but production TLS, real OIDC policy, backup/restore, secret rotation, and an actual internet deployment are not thereby certified.
3. **npm publication — `not_attempted`.** No package was published.
4. **Final visual browser inspection — `requires_separate_evidence`.** Automated module/API smoke is not relabelled as a visual review.

The review head containing this record is intentionally **documentation-only above the verified product candidate**. No release, merge, or publication is authorized by this record.
EOF

# Restore every workflow to the exact verified candidate and remove staging-only
# helpers. The resulting content tree must be candidate + release-gate record.
git checkout "$CANDIDATE_SHA" -- .github/workflows/ci.yml
git rm -f .github/workflows/final-candidate-matrix.yml .github/workflows/finalize-release-record.yml scripts/finalize-release-gate.sh

git diff --check
changed="$(git diff --name-only "$CANDIDATE_SHA" | sort)"
if [ "$changed" != 'docs/RELEASE-GATE.md' ]; then
  echo "Final tree is not documentation-only above candidate:" >&2
  echo "$changed" >&2
  exit 1
fi

git add -A
git config user.name "Fiscus truth-closure bot"
git config user.email "noreply@github.com"
git commit -m "Record exact truth-closure release evidence"
final_sha="$(git rev-parse HEAD)"
test -z "$(git status --porcelain --untracked-files=all)"
echo "FINAL_REVIEW_SHA=$final_sha"
git push origin HEAD:agent/truth-closure
