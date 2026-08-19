from pathlib import Path

root = Path(__file__).resolve().parents[1]

def read(path: str) -> str:
    return (root / path).read_text(encoding='utf-8')

def write(path: str, text: str) -> None:
    (root / path).write_text(text, encoding='utf-8')

def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one replacement target, found {count}')
    write(path, text.replace(old, new, 1))

replace_once(
    'src/cli.ts',
    '  Fiscus — meter and cap what your AI coding agents spend, locally.',
    '  Fiscus — local AI financial operations: meter, control, reconcile, allocate, and evidence value.',
)

# Keep local-component claims local. The dashboard/store do not themselves
# exfiltrate data; the product has separate explicit network-capable actions.
replace_once(
    'src/dashboard/server.ts',
    ''' * A small read-only HTTP server over the same Store the proxy writes to. It\n * exposes a JSON API and serves a single self-contained HTML page. Bound to\n * localhost only — like everything else, nothing leaves the machine.''',
    ''' * A small local HTTP server over the same Store the proxy writes to. It exposes\n * a JSON API and serves the bundled dashboard on loopback only. The dashboard\n * itself makes no off-device request; separate explicit Fiscus actions may use\n * the network according to docs/DATA-BOUNDARIES.md.''',
)
replace_once(
    'src/store/db.ts',
    ''' * No native module, no build step, no external service. The whole point of the\n * product is that nothing leaves the machine, so the store is a single local\n * file under ~/.aegisflow.''',
    ''' * No native module, no build step, no external service. Persistence is a single\n * local file under ~/.aegisflow; network-capable product actions are separate\n * from this store and governed by explicit data boundaries.''',
)

replace_once(
    'README.md',
    '''Local-first financial control and outcome evidence for AI coding-agent spend: a\nproxy that meters configured traffic, assigns a local list-price estimate,\nmeasures evidence of what that spend actually *returns* (Return on\nIntelligence), and presents review-only within-task model trials with explicit\nprovider and operator-controlled egress boundaries.''',
    '''Local-first financial control and outcome evidence for AI spend: Fiscus\nmeters configured traffic and supported local tool logs, separates metered cost\nfrom provider billing evidence and allocation, and measures what that spend\nactually *returns* (Return on Intelligence). Coding-agent workflows currently\nhave the deepest validated outcome instrumentation; non-coding outcomes use\nexplicit adapters with their evidence limits exposed. Provider and\noperator-controlled egress boundaries remain explicit.''',
)
replace_once(
    'README.md',
    '''answered it. Fiscus's core is **Return on Intelligence (RoI)**: a measure of\nrealized AI value that works across *any* token usage (not just coding), is\nmeasured from the request path instead of surveys, and composes four value\nlenses into a non-compensatory index where one strong axis cannot buy back a\ncollapsed one. That is resistance to single-axis optimization, not a proof\nagainst Goodhart effects in task selection, instrumentation, or baselines.''',
    '''answered it. Fiscus's core is **Return on Intelligence (RoI)**: an\nevidence-limited framework for realized AI value. Coding workflows can bind\nrequest-path evidence to git/CI outcomes; supported non-coding workflows can use\nexplicit reported-outcome adapters instead. RoI composes four value lenses into\na non-compensatory index where one strong axis cannot buy back a collapsed one.\nThat is resistance to single-axis compensation, not a proof against Goodhart\neffects in task selection, instrumentation, reporting, or baselines.''',
)
replace_once(
    'README.md',
    '''That index is unitless on purpose — it answers *"how well is the intelligence\nworking, across every axis at once?"*, and a geometric mean resists gaming because\none weak lens drags the whole number down.''',
    '''That index is unitless on purpose — it answers *"how well is the intelligence\nworking, across every instrumented axis at once?"* A geometric mean makes weak\nlenses non-compensatory; it does not make the surrounding measurement system\nimmune to gaming.''',
)

replace_once(
    'docs/THE-STANDARD.md',
    '''## 2. The unit of work\n\nThe atom is the **commit** — the smallest thing git makes objectively\nverifiable. Commits group into **tasks** (a session's worth) and **periods**\n(a sprint). Everything below is computed per commit and aggregated up.\n\n---\n\n## 3. The funnel — eight gates''',
    '''## 2. The unit of work\n\nFor the **coding adapter**, the atom is the **commit** — the smallest unit git\nmakes objectively verifiable. Commits group into **tasks** (a session's worth)\nand **periods** (a sprint), and the eight-gate funnel below is computed at that\ngrain.\n\nFiscus also supports explicit non-coding outcome adapters. Those use the\nbounded session/outcome unit supplied by the adapter rather than pretending a\ncommit exists. Their evidence depth is currently weaker and must remain labelled\nas such; coding-gate semantics do not become universal merely because the\nproduct's financial layer is broader.\n\n---\n\n## 3. The coding funnel — eight gates''',
)
replace_once(
    'docs/THE-STANDARD.md',
    '''Gates 3–8 can be reconstructed by anyone with git + CI hooks. Gates **1–2 can\nonly be measured from inside the request path**, which is exactly where\nFiscus sits. This is the moat.''',
    '''Gates 3–8 can be reconstructed from git + CI evidence. In current Fiscus,\ngates **1–2 are captured from the request path**, which is where the product can\nobserve proposed output before it becomes an artifact. That is a distinctive\nsource of evidence, not an exclusivity claim: another system that retained both\nproposal and final-artifact evidence could construct a comparable signal.''',
)
replace_once(
    'docs/THE-STANDARD.md',
    '''- **Not a per-developer leaderboard tied to comp.** It's a coaching and\n  accounting instrument. (Gaming is a non-concern by design intent — the metric\n  is about realized production; optimizing realized production *is the goal*.)''',
    '''- **Not a per-developer leaderboard tied to comp.** It's a coaching and\n  accounting instrument. It is **not immune to gaming**: the funnel and\n  non-compensatory lenses reduce some single-axis incentives, while selection,\n  reporting, instrumentation, and baselines can still be manipulated. Resource\n  consumption metrics such as tokens and spend are inputs, not productivity\n  targets, and should not be rewarded as individual performance.''',
)

replace_once(
    'docs/AI-FINANCIAL-OPERATIONS-ROADMAP.md',
    '''**Audited against the source on 2026-08-17 — see [VISION-AUDIT.md](VISION-AUDIT.md).** Section 3's "what exists today" is now stale in both directions, and the audit records three vocabularies specified here that were implemented differently or not at all (cost basis, evidence source, enforceability status). Where this document and the code disagree on a label that is already in migrated databases, the code is authoritative and this document is what needs correcting.''',
    '''**Source-status refresh: 2026-08-19.** [VISION-AUDIT.md](VISION-AUDIT.md) remains the historical 2026-08-17 audit; the canonical machine-readable current-status surface is [CAPABILITIES.json](CAPABILITIES.json). Where this roadmap and migrated code disagree on an implemented label, the code is authoritative. Section 3 below has been refreshed only for capabilities now demonstrably implemented; external provider/deployment proof gaps remain open.''',
)
replace_once(
    'docs/AI-FINANCIAL-OPERATIONS-ROADMAP.md',
    '| Financial source of truth | Local price-table metering and tool-log estimates. | Authoritative provider/billing ingestion, period close, source identity, currency, credits, discounts, adjustments, and retained source lineage. | P0 |',
    '| Financial source of truth | Metered/tool-log estimates plus immutable operator-supplied OpenAI billing evidence and direct OpenAI Costs observations, each retaining source/provenance separately. | Finalized authoritative bill/period-close validation, broader provider coverage, contractual credits/discounts/adjustments, and verified provider-account identity. | P0 |',
)
replace_once(
    'docs/AI-FINANCIAL-OPERATIONS-ROADMAP.md',
    '| Reconciliation | Repricing can improve an estimate; there is no bill-to-ledger comparison. | A per-provider-account, per-period reconciliation record with coverage, variance, and reason codes. | P0 |',
    '| Reconciliation | Immutable project-day reconciliation runs compare compatible OpenAI provider observations with declared-scope proxy traffic and retain residuals, conditions, source kind, and coverage. | End-to-end validation against a real finalized provider bill/account, documented finality, multi-provider support, and period-close operations. | P0 |',
)
replace_once(
    'docs/AI-FINANCIAL-OPERATIONS-ROADMAP.md',
    '| Allocation and showback | Project/user labels and value-aware budget recommendations. | Versioned direct/shared allocation rules, unallocated cost, effective dates, approval, reversal, and period showback exports. | P0 |',
    '| Allocation and showback | Cost centres, versioned direct/fixed/shared rules, exact-microdollar conserving runs, unallocated residuals, effective-time rule application, and showback-only API/GUI surfaces are implemented. | Organization-grade ownership/identity, approval/reversal workflow, closed-period exports, and any chargeback claim. | P0 |',
)
replace_once(
    'docs/AI-FINANCIAL-OPERATIONS-ROADMAP.md',
    '| Central controls | Local proxy caps protect only routed traffic. | Policy objects with scope, owner, version, exception, simulation, decision log, and an honest observed-only state for off-path usage. | P0 |',
    '| Central controls | Local proxy controls are explicitly `enforced_in_path`; imported/off-path spend is `observed_only`, provider-native control is uninspected, and saved cap changes reach the running proxy. Experimental decision-ledger/promotion mathematics exists only as pure research code. | Organization-scoped policy ownership/versions/exceptions/approvals and a proven central enforcement plane; research primitives must clear calibration/promotion gates before runtime use. | P0 |',
)

write('test/product-truth-copy.test.ts', r'''import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

test('local components do not make a global zero-egress product claim', () => {
  const main = read('src/dashboard/web/app/main.ts');
  const server = read('src/dashboard/server.ts');
  const store = read('src/store/db.ts');
  assert.match(main, /Dashboard data stays local\. Network access occurs only through explicit/);
  assert.match(main, /This page loads nothing from the internet/);
  assert.doesNotMatch(server, /like everything else, nothing leaves the machine/);
  assert.match(server, /separate explicit Fiscus actions may use\s+\* the network/);
  assert.doesNotMatch(store, /whole point of the\s+\* product is that nothing leaves the machine/);
  assert.match(store, /network-capable product actions are separate/);
});

test('CLI and README describe broad AI financial operations without overstating cross-modal evidence depth', () => {
  const cli = read('src/cli.ts');
  const readme = read('README.md');
  assert.doesNotMatch(cli, /meter and cap what your AI coding agents spend, locally/);
  assert.match(cli, /local AI financial operations/);
  assert.match(readme, /Coding-agent workflows currently have the deepest validated outcome instrumentation/);
  assert.doesNotMatch(readme, /works across \*any\* token usage/);
  assert.match(readme, /explicit reported-outcome adapters/);
  assert.match(readme, /does not make the surrounding measurement system\s+immune to gaming/);
});

test('Realization Standard scopes commit gates to coding and refuses anti-gaming overclaim', () => {
  const standard = read('docs/THE-STANDARD.md');
  assert.match(standard, /For the \*\*coding adapter\*\*, the atom is the \*\*commit\*\*/);
  assert.match(standard, /explicit non-coding outcome adapters/);
  assert.match(standard, /not immune to gaming/i);
  assert.doesNotMatch(standard, /Gaming is a non-concern by design intent/);
  assert.doesNotMatch(standard, /can only be measured from inside the request path/);
});

test('financial-operations roadmap no longer describes shipped reconciliation/allocation as absent', () => {
  const roadmap = read('docs/AI-FINANCIAL-OPERATIONS-ROADMAP.md');
  assert.match(roadmap, /Source-status refresh: 2026-08-19/);
  assert.match(roadmap, /Immutable project-day reconciliation runs/);
  assert.match(roadmap, /exact-microdollar conserving runs/);
  assert.match(roadmap, /Experimental decision-ledger\/promotion mathematics exists only as pure research code/);
  assert.doesNotMatch(roadmap, /there is no bill-to-ledger comparison/);
});
''')

print('truth-copy sweep v2 applied')
