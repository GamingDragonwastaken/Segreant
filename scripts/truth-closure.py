from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')

def write(path: str, text: str) -> None:
    p = ROOT / path
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding='utf-8')

def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected exactly one match, found {count}: {old[:100]!r}')
    write(path, text.replace(old, new, 1))

# ---------------------------------------------------------------------------
# P0 correctness: GET /api/scan is a preview and therefore must not mutate the
# persisted scan baseline. scanWithDiff is explicitly designed to let callers
# choose whether to save; the GET route was choosing to save anyway.
# ---------------------------------------------------------------------------
replace_once(
    'src/dashboard/server.ts',
    """      // GET preview. The filesystem walk is bounded (depth + visit budget), so this
      // stays responsive; repo paths are capped in the payload for large trees. It
      // also reports what changed since the last scan of these roots, then records
      // this scan as the new baseline (a local marker — imports/correlates nothing).
      try {
        const path = url.searchParams.get('path') || undefined;
        const { plan, diff } = scanWithDiff(store, { roots: path ? [path] : undefined });
        saveScan(store, plan);
""",
    """      // GET preview. The filesystem walk is bounded (depth + visit budget), so this
      // stays responsive; repo paths are capped in the payload for large trees.
      // IMPORTANT: preview is genuinely read-only. scanWithDiff deliberately leaves
      // persistence to its caller, and a GET must not advance the comparison baseline.
      try {
        const path = url.searchParams.get('path') || undefined;
        const { plan, diff } = scanWithDiff(store, { roots: path ? [path] : undefined });
""",
)

# ---------------------------------------------------------------------------
# P0 correctness: the browser expected reconciliation.latest while the server
# actually returns reconciliation.runs[]. Make the declared transport shape match
# reality and make the Evidence screen read the newest immutable run.
# ---------------------------------------------------------------------------
replace_once(
    'src/dashboard/web/app/core/api.ts',
    """  reconciliation?: {
    runs?: number;
    latest?: {
      providerSourceKind?: string;
      conditions?: string[];
      status?: string;
      computedAtMs?: number;
    } | null;
  };
""",
    """  reconciliation?: {
    runs: Array<{
      reconciliationRunId: string;
      computedAtMs: number;
      result: {
        status: string;
        providerSourceKind?: string;
        conditions?: readonly string[];
      };
    }>;
  };
""",
)
replace_once(
    'src/dashboard/web/app/views/evidence.ts',
    """      const latest = d.reconciliation?.latest ?? null;
""",
    """      const latestRun = d.reconciliation?.runs?.[0] ?? null;
      const latest = latestRun?.result ?? null;
""",
)
replace_once(
    'src/dashboard/web/app/views/evidence.ts',
    """                h('span', { class: 'basis', text: `last run ${relative(latest.computedAtMs ?? null)}` }))
""",
    """                h('span', { class: 'basis', text: `last run ${relative(latestRun?.computedAtMs ?? null)}` }))
""",
)

# ---------------------------------------------------------------------------
# P0 correctness: an observed-lens geometric mean is not an upper bound when a
# missing lens is later measured. Keep roiIndex as the observed-lens diagnostic
# for compatibility, but add mathematically valid full-index bounds by evaluating
# every unknown necessary lens at its admissible endpoints [0,1]. Never call the
# observed score a bound again.
# ---------------------------------------------------------------------------
replace_once(
    'src/value/lenses.ts',
    """  // True when the Index is an UPPER bound on the real conversion — i.e. some
  // necessary lenses are un-instrumented, and unobserved conditions can only
  // lower it. More measurement makes the number more honest, never inflated.
  indexIsUpperBound: boolean;
""",
    """  // Deprecated compatibility flag. An observed-only, weight-renormalized mean
  // is NOT generally an upper bound: measuring a missing lens can raise or lower
  // it. Kept false so older consumers do not mistake the observed score for a
  // ceiling. Read `instrumentationInterval` for the mathematically valid bound.
  indexIsUpperBound: boolean;
  // Partial-identification interval for the FULL four-lens Index when some lenses
  // are unknown. Unknown necessary lenses are evaluated at their admissible
  // endpoints 0 and 1 using the FULL fixed weight vector; the observed-only score
  // is reported separately because it need not lie at either endpoint.
  instrumentationInterval: { low: number | null; observed: number | null; high: number | null };
""",
)
replace_once(
    'src/value/lenses.ts',
    """  const roiIndex = composeIndex(lift.instrumented ? lift.value : null);

  // Interval-valued RoI. The counterfactual Lift is only partially identified
""",
    """  const roiIndex = composeIndex(lift.instrumented ? lift.value : null);

  // A TRUE partial-instrumentation bound must keep the full weight vector. The
  // observed-only mean above renormalizes over observed lenses, so it is a useful
  // diagnostic but not a ceiling or floor. Monotonicity of the CES/power mean
  // lets us bound the full four-lens index by substituting each unknown lens with
  // 0 (lower endpoint) and 1 (upper endpoint).
  const composeFullIndex = (unknownValue: 0 | 1): number | null => {
    const pairs: Array<{ value: number; weight: number }> = [
      { value: realization.instrumented && realization.value !== null ? realization.value : unknownValue, weight: w.realization },
      { value: acceptance.instrumented && acceptance.value !== null ? acceptance.value : unknownValue, weight: w.acceptance },
      { value: lift.instrumented && lift.value !== null ? lift.value : unknownValue, weight: w.lift },
      { value: impact.instrumented && impact.value !== null ? impact.value : unknownValue, weight: w.impact },
    ];
    return 100 * weightedPowerMean(pairs, theta);
  };
  const hasUnknownLenses = all.some((l) => !l.instrumented);
  const instrumentationInterval = hasUnknownLenses
    ? { low: composeFullIndex(0), observed: roiIndex, high: composeFullIndex(1) }
    : { low: roiIndex, observed: roiIndex, high: roiIndex };

  // Interval-valued RoI. The counterfactual Lift is only partially identified
""",
)
replace_once(
    'src/value/lenses.ts',
    """  // Honesty under partial instrumentation: every un-instrumented lens is a
  // necessary condition we cannot see, and unobserved conditions can only LOWER
  // the true conversion. So a partially-instrumented Index is an upper bound.
  const indexIsUpperBound = all.some((l) => !l.instrumented);
  if (indexIsUpperBound && roiIndex !== null) {
    notes.push(
      `RoI Index is an UPPER bound: ${all.filter((l) => l.instrumented).length} of 4 lenses instrumented. ` +
        'Measuring the rest can only lower it toward the truth — more measurement, more honest, never inflated.',
    );
  }
""",
    """  // Compatibility only: the observed-only score is never labelled an upper
  // bound. Missing dimensions are represented by the explicit full-index interval.
  const indexIsUpperBound = false;
  if (hasUnknownLenses && roiIndex !== null) {
    const low = instrumentationInterval.low;
    const high = instrumentationInterval.high;
    notes.push(
      `RoI observed-lens Index uses ${all.filter((l) => l.instrumented).length} of 4 lenses and is not a bound. ` +
        `Under the declared [0,1] lens scale, the full four-lens Index is only identified within ` +
        `${low === null ? 'unknown' : low.toFixed(1)}–${high === null ? 'unknown' : high.toFixed(1)} until the missing lenses are measured.`,
    );
  }
""",
)
replace_once(
    'src/value/lenses.ts',
    """    roiInterval,
    indexIsUpperBound,
    realizationInterval: realizationCS,
""",
    """    roiInterval,
    indexIsUpperBound,
    instrumentationInterval,
    realizationInterval: realizationCS,
""",
)

# Replace the old label-only test with an actual mathematical regression.
replace_once(
    'test/equation.test.ts',
    """test('partial instrumentation makes the Index an explicit UPPER bound', () => {
  // Lift un-instrumented (3 of 4 lenses) → upper bound.
  assert.equal(computeReturnOnIntelligence(report(), {}).indexIsUpperBound, true);
  // All four instrumented → not a bound.
  assert.equal(computeReturnOnIntelligence(report(), { lift: 0.6 }).indexIsUpperBound, false);
});
""",
    """test('partial instrumentation is bounded honestly: the observed-only score is NOT an upper bound', () => {
  const partial = computeReturnOnIntelligence(report(), {});
  const measuredHigh = computeReturnOnIntelligence(report(), { lift: 0.9 });
  const measuredLow = computeReturnOnIntelligence(report(), { lift: 0.2 });

  assert.equal(partial.indexIsUpperBound, false, 'renormalized observed-lens mean must never be labelled a ceiling');
  assert.ok(measuredHigh.roiIndex! > partial.roiIndex!, 'a newly measured strong lens can raise the score');
  assert.ok(measuredLow.roiIndex! < partial.roiIndex!, 'a newly measured weak lens can lower the score');
  assert.ok(partial.instrumentationInterval.low! <= measuredLow.roiIndex!);
  assert.ok(partial.instrumentationInterval.high! >= measuredHigh.roiIndex!);
});
""",
)
replace_once(
    'test/equation.test.ts',
    """test('aggregator COLLAPSES on any zero lens (Goodhart-proof) for θ ≤ 0', () => {
""",
    """test('aggregator is non-compensatory: any zero lens collapses the score for θ ≤ 0', () => {
""",
)

# ---------------------------------------------------------------------------
# Contract regression: a read-only scan must not establish its own baseline.
# ---------------------------------------------------------------------------
write('test/dashboard-scan-readonly.test.ts', """import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/db.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';

function boot(store: Store): Promise<{ base: string; close: () => Promise<void> }> {
  const server: http.Server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'test' });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

test('GET /api/scan is a pure preview and does not advance the persisted diff baseline', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fiscus-dashboard-scan-'));
  mkdirSync(join(root, 'repo', '.git'), { recursive: true });
  const store = new Store(':memory:');
  const srv = await boot(store);
  try {
    const url = `${srv.base}/api/scan?path=${encodeURIComponent(root)}`;
    const first = await (await fetch(url)).json() as { diff: { comparable: boolean } };
    const second = await (await fetch(url)).json() as { diff: { comparable: boolean } };
    assert.equal(first.diff.comparable, false);
    assert.equal(second.diff.comparable, false, 'a GET must not create the baseline used by the next GET');
  } finally {
    await srv.close();
    store.close();
  }
});
""")

# Semantic contract regression for the reconciliation shape that optional-field
# checking could not catch.
write('test/dashboard-billing-contract.test.ts', """import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BillingPayload } from '../src/dashboard/web/app/core/api.ts';

test('BillingPayload models immutable reconciliation runs, not a fabricated latest field', () => {
  const payload: BillingPayload = {
    demo: false,
    evidence: { reconciliationStatus: 'reconciled_with_residual' },
    summary: { recordCount: 1 },
    reconciliation: {
      runs: [{
        reconciliationRunId: 'r1',
        computedAtMs: 123,
        result: { status: 'reconciled_with_residual', providerSourceKind: 'provider_api_pull', conditions: [] },
      }],
    },
  };
  assert.equal(payload.reconciliation?.runs[0]?.result.status, 'reconciled_with_residual');
  assert.equal(payload.reconciliation?.runs[0]?.computedAtMs, 123);
});
""")

# ---------------------------------------------------------------------------
# Product-truth copy: remove claims stronger than the implementation/evidence.
# ---------------------------------------------------------------------------
for path in ['README.md', 'docs/RETURN-ON-INTELLIGENCE.md', 'docs/THE-STANDARD.md']:
    if (ROOT / path).exists():
        t = read(path)
        t = t.replace('Goodhart-proof', 'single-axis resistant')
        t = t.replace('GOODHART-PROOF', 'SINGLE-AXIS RESISTANT')
        write(path, t)

replace_once(
    'README.md',
    """and composes four value
lenses into one index that can't be gamed on a single axis.
""",
    """and composes four value
lenses into a non-compensatory index where one strong axis cannot buy back a
collapsed one. That is resistance to single-axis optimization, not a proof
against Goodhart effects in task selection, instrumentation, or baselines.
""",
)
replace_once(
    'README.md',
    """A lens with no signal reads `uninstrumented` and is excluded — never faked — and
the report shows your lens coverage. The path to a higher number is to wire more
signal, not to game one. `fiscus roi --repo .`
""",
    """A lens with no signal reads `uninstrumented` and is excluded from the observed-lens
score — never faked — and the report shows coverage plus a full-index interval
that keeps the missing lens in the fixed weight vector at its admissible [0,1]
endpoints. The observed-only score is explicitly not called an upper bound:
measuring a missing lens can raise or lower it. `fiscus roi --repo .`
""",
)

# Package metadata should describe what ships now without pretending the broader
# platform thesis is already equally mature in every modality.
import json
pkg_path = ROOT / 'package.json'
pkg = json.loads(pkg_path.read_text(encoding='utf-8'))
pkg['description'] = 'Local-first AI Financial Operations for metered spend, provider evidence, allocation, and realized-value measurement; strongest for coding-agent workflows.'
pkg_path.write_text(json.dumps(pkg, indent=2) + '\n', encoding='utf-8')

# ---------------------------------------------------------------------------
# Professional public-repository maintenance surfaces.
# ---------------------------------------------------------------------------
write('SECURITY.md', """# Security Policy

## Supported versions

Fiscus is pre-1.0. Security fixes are made on the current `main` branch. Until a
stable release line exists, older commits are not maintained as supported
security branches.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability that could expose local
credentials, source material, billing data, or permit unintended local mutation.
Use GitHub's private vulnerability reporting for this repository when available.
If private reporting is unavailable, open a public issue containing **no exploit,
secret, personal path, or sensitive payload** and ask the maintainer for a private
contact channel.

A useful report includes the affected commit, platform and Node version, the
trust boundary crossed, minimal reproduction steps, and whether the issue needs
local access, browser access, provider credentials, or a team-server deployment.

## Security model

Fiscus is local-first, not offline-only. Proxy traffic goes to the provider the
operator configured, and explicitly invoked features can perform other outbound
requests. The canonical disclosure is `docs/DATA-BOUNDARIES.md`; security reports
should be evaluated against that document rather than a generic "no network"
assumption.

The local dashboard is expected to bind to loopback, reject non-local Host values,
make no external browser requests, and require the `x-aegis-local: 1` custom
header on mutating routes. A GET endpoint must not mutate persistent state.
""")
write('CONTRIBUTING.md', """# Contributing to Fiscus

Fiscus treats accounting truth and evidence boundaries as correctness properties,
not presentation details. A change that makes a number easier to read but weaker
to justify is a regression.

## Development baseline

- Node.js 24 or newer.
- `npm ci`
- `npm run typecheck`
- `npm test`
- `npm run build`

The main package intentionally has zero runtime dependencies. Do not add one
without an explicit architectural decision and an update to the product and data
boundary documentation.

## Pull requests

Keep each PR reviewable and bind claims to evidence. Explain the root cause for a
fix, the user-facing consequence, the validation performed, and any boundary that
remains unverified. Add a regression test for every correctness bug when a stable
test seam exists.

Preserve these invariants:

1. Metered usage, provider-billed cost, allocated cost, and realized value are
   distinct claims.
2. Unknown provenance stays unknown; do not infer a historical fact merely
   because it is convenient.
3. Derived accounting records are immutable or versioned; raw evidence is not
   rewritten to make later reports agree.
4. Preview/read endpoints do not persist changes. Consequential writes are
   explicit and guarded.
5. No browser CDN, analytics, web font, or other external GUI request.
6. Never commit credentials, private keys, provider exports, real user data, or
   personal filesystem paths.

## Commit and review discipline

Prefer small commits that explain *why*. Before requesting review, run the same
checks CI runs and inspect the packaged artifact when the change touches build,
CLI startup, dashboard assets, or release behavior. Release claims must follow
`docs/RELEASE-GATE.md`; a green test command in a commit message is not release
evidence by itself.
""")
write('.github/PULL_REQUEST_TEMPLATE.md', """## What changed

<!-- Describe the smallest coherent change. -->

## Why

<!-- Root cause / decision and the user or operator consequence. -->

## Truth and data boundaries

- [ ] Metered, billed, allocated, and realized figures remain distinct.
- [ ] Unknown provenance remains unknown.
- [ ] No new egress or credential access, or the data-boundary docs were updated.
- [ ] Read/preview paths remain non-mutating.

## Validation

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build` when build/package/UI behavior changed
- [ ] Regression test added for a correctness fix
- [ ] Packaged/runtime smoke checked when applicable

## Remaining limits

<!-- Name anything this PR does not prove. Do not turn an unverified assumption into a claim. -->
""")
write('.github/ISSUE_TEMPLATE/bug_report.yml', """name: Bug report
description: Report reproducible incorrect behavior
title: "[bug] "
labels: [bug]
body:
  - type: markdown
    attributes:
      value: "Do not include credentials, provider exports, private source, or personal filesystem paths. Security issues belong in private vulnerability reporting."
  - type: input
    id: version
    attributes:
      label: Fiscus version / commit
      placeholder: "0.1.0 or git SHA"
    validations:
      required: true
  - type: dropdown
    id: platform
    attributes:
      label: Platform
      options: [Windows, macOS, Linux, Other]
    validations:
      required: true
  - type: textarea
    id: observed
    attributes:
      label: What happened?
      description: Include the exact incorrect claim or behavior, with sensitive data redacted.
    validations:
      required: true
  - type: textarea
    id: expected
    attributes:
      label: What should have happened?
    validations:
      required: true
  - type: textarea
    id: reproduce
    attributes:
      label: Minimal reproduction
    validations:
      required: true
  - type: checkboxes
    id: safety
    attributes:
      label: Data safety
      options:
        - label: I removed secrets, private source, billing exports, and personal paths.
          required: true
""")
write('.github/ISSUE_TEMPLATE/feature_request.yml', """name: Feature request
description: Propose a capability or evidence improvement
title: "[feature] "
labels: [enhancement]
body:
  - type: textarea
    id: problem
    attributes:
      label: Operator problem
      description: What decision or workflow is currently impossible or misleading?
    validations:
      required: true
  - type: textarea
    id: evidence
    attributes:
      label: Evidence required
      description: What data would make the new claim defensible, and what should remain unknown?
    validations:
      required: true
  - type: textarea
    id: boundaries
    attributes:
      label: Privacy / egress / mutation boundary
      description: Does this require network access, credentials, new persistence, or a consequential write?
    validations:
      required: true
  - type: textarea
    id: proposal
    attributes:
      label: Proposed behavior
""")
write('.github/ISSUE_TEMPLATE/config.yml', """blank_issues_enabled: true
contact_links: []
""")
write('.github/dependabot.yml', """version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 5
  - package-ecosystem: npm
    directory: /team-server
    schedule:
      interval: weekly
    open-pull-requests-limit: 5
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 5
""")
write('CHANGELOG.md', """# Changelog

Fiscus is pre-1.0. This file records user-visible changes from the point at which
release discipline was formalized; Git history remains the authoritative record
for earlier development.

The format follows Keep a Changelog and releases will use Semantic Versioning.

## [Unreleased]

### Fixed

- Correct partial-instrumentation RoI semantics: an observed-only, renormalized
  index is no longer described as an upper bound; full-index identification bounds
  retain all four fixed weights.
- Keep dashboard scan previews read-only instead of advancing scan state on GET.
- Read provider reconciliation history from the immutable run collection the
  server actually returns.

### Repository

- Added security, contribution, pull-request, issue, and dependency-update policy
  surfaces for public maintenance.
""")

print('truth-closure transformations applied')
