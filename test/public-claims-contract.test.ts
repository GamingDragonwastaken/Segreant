/**
 * Public product claims are part of the financial-control surface. This test
 * pins the known false privacy/coverage shortcuts and requires every current
 * surface to route an operator to the executable capability/evidence contract.
 * Historical audit and release records are deliberately outside this scope.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), 'utf8');

test('the current capability and evidence contract contains the required boundaries', () => {
  const contract = read('docs', 'CAPABILITY-EVIDENCE-CONTRACT.md');
  assert.match(contract, /## Authority order/);
  assert.match(contract, /## Financial truth chain/);
  assert.match(contract, /## Supported now/);
  assert.match(contract, /## Intended direction/);
  assert.match(contract, /## Not established or not offered/);
  assert.match(contract, /## Egress and retention matrix/);
  assert.match(contract, /## Change rule/);
  assert.match(contract, /Fiscus has no Fiscus-hosted product telemetry by default/);
});

test('current public privacy copy distinguishes local product data from provider traffic', () => {
  const integrations = read('docs', 'INTEGRATIONS.md');
  const faq = read('docs', 'FAQ.md');
  const methodology = read('docs', 'METHODOLOGY.md');
  const architecture = read('docs', 'ARCHITECTURE.md');
  const classic = read('src', 'dashboard', 'web', 'classic.html');

  assert.doesNotMatch(integrations, /nothing about your prompts or code ever leaves the device/i);
  assert.match(integrations, /forwards routed requests to the AI provider/i);
  assert.match(integrations, /DATA-BOUNDARIES\.md/);
  assert.doesNotMatch(faq, /Does my code or prompts ever leave my machine\?\s+No\./is);
  assert.match(faq, /does not send your prompts or code to a Fiscus-operated telemetry service/i);
  assert.doesNotMatch(methodology, /No prompts, no code, no keys\s+are ever transmitted/i);
  assert.match(methodology, /configured AI provider/i);
  assert.doesNotMatch(architecture, /no prompt text, source code, or credentials ever leave the device/i);
  assert.match(architecture, /forwarded to the configured provider/i);
  assert.doesNotMatch(classic, /no prompt or code leaves your device/i);
  assert.match(classic, /browser-app property/i);
});

test('public coverage and egress claims remain scoped to the supported path', () => {
  const landing = read('web', 'index.html');
  const registry = read('src', 'dashboard', 'web', 'app', 'core', 'registry.ts');
  const readme = read('README.md');

  assert.doesNotMatch(landing, /zero egress/i);
  assert.doesNotMatch(landing, /100%\s*<\/div><div class="lbl">of calls metered/i);
  assert.match(landing, /when traffic is explicitly routed through Fiscus/i);
  assert.doesNotMatch(registry, /only action in Fiscus that sends data off this machine/i);
  assert.match(registry, /Other explicit outbound paths are documented in DATA-BOUNDARIES\.md/i);
  assert.match(readme, /CAPABILITY-EVIDENCE-CONTRACT\.md/);
  assert.doesNotMatch(readme, /works across \*any\* token usage/i);
});

test('historical direction documents point current readers to the contract', () => {
  const roadmap = read('docs', 'AI-FINANCIAL-OPERATIONS-ROADMAP.md');
  const audit = read('docs', 'VISION-AUDIT.md');

  assert.match(roadmap, /direction document, not a current capability claim/i);
  assert.match(roadmap, /Historical pre-2026-08-18 baseline/i);
  assert.doesNotMatch(audit, /PRODUCT_BRIEF\.md/);
  assert.match(audit, /live capability\/evidence contract/i);
});

test('ordinary value surfaces cannot revive causal break-even copy while the study lane stays evidence-gated', () => {
  const readme = read('README.md');
  const classic = read('src', 'dashboard', 'web', 'classic.html');
  const modern = read('src', 'dashboard', 'web', 'app', 'views', 'value.ts');
  const contract = read('docs', 'CAPABILITY-EVIDENCE-CONTRACT.md');
  const protocol = read('docs', 'CAUSAL-EVIDENCE-PROTOCOL.md');
  const causalCli = read('src', 'cli', 'causalCmd.ts');

  assert.match(readme, /Observed value scenario/);
  assert.doesNotMatch(readme, /estimated causal return exceeds/i);
  assert.doesNotMatch(classic, /Causal RoI return|Gross upper-bound|estimated causal return above break-even/i);
  assert.match(classic, /Observed value scenario/);
  assert.match(modern, /not causal evidence/);
  assert.match(modern, /causalStudyCard/);
  assert.match(contract, /qualified causal-study result/i);
  assert.match(protocol, /pre-exposure balanced assignment blocks/i);
  assert.match(causalCli, /Registration and assignment require --apply/i);
  assert.doesNotMatch(causalCli, /provider route.*=/i);
});

/**
 * These are the current, shipped claim surfaces. Keep this list explicit: a
 * whole-directory exception would let a stale public/runtime claim disappear
 * behind an allowlist instead of being reviewed. Historical release records
 * and research quotations are checked separately and are not treated as live
 * product copy.
 */
const CURRENT_CLAIM_SURFACES = [
  'README.md',
  'CLAUDE.md',
  'PRODUCT.md',
  'docs/ARCHITECTURE.md',
  'docs/FAQ.md',
  'docs/METHODOLOGY.md',
  'docs/RETURN-ON-INTELLIGENCE.md',
  'docs/DATA-BOUNDARIES.md',
  'docs/LIFT-AI-SIDE-JUDGE-DESIGN.md',
  'src/cli/valueCmd.ts',
  'src/dashboard/server.ts',
  'src/dashboard/web/classic.html',
  'src/dashboard/web/app/core/actions.ts',
  'src/dashboard/web/app/core/api.ts',
  'src/dashboard/web/app/views/value.ts',
  'src/store/db.ts',
  'src/value/voi.ts',
  'src/judge/tier.ts',
  'web/index.html',
] as const;

const REJECTED_LIVE_CLAIMS: ReadonlyArray<[string, RegExp]> = [
  ['universal Index upper-bound claim', /(?:the )?(?:partially[- ]instrumented )?Index is (?:an )?(?:explicit )?upper bound/i],
  ['more lenses can only lower the Index', /wiring more (?:lenses|measurement) can only lower/i],
  ['more measurement can only lower the Index', /measuring (?:the rest|a missing lens|more lenses?) can only (?:pull it )?down/i],
  ['upper-bound Index tooltip', /highest the Index could be.*(?:never up|only pull it down)/is],
  ['blanket no-build/no-service claim', /no build step,?\s*no native modules,?\s*no external services/i],
  ['blanket machine-boundary claim', /nothing leaves (?:the )?(?:machine|device|it)\b/i],
  ['blanket zero-egress claim', /(?:zero|no) (?:data )?egress\b/i],
  ['blanket all-on-device claim', /all on-device\b/i],
  ['blanket code-never-leaves claim', /no byte of (?:your )?code leaves (?:the )?(?:machine|device)/i],
  ['blanket never-transmitted claim', /(?:is|are) never transmitted anywhere/i],
  ['causal RoI formula in live docs', /RoI_causal\s*=\s*RoI_gross/i],
  ['causal RoI break-even formula in live docs', /RoI_causal[^\n]{0,240}(?:pays for itself|break-even)/is],
];

test('the rejected-claim scan keeps universal value and privacy wording out of current surfaces', () => {
  const matches: string[] = [];
  for (const relativePath of CURRENT_CLAIM_SURFACES) {
    const source = read(...relativePath.split('/'));
    for (const [label, pattern] of REJECTED_LIVE_CLAIMS) {
      if (pattern.test(source)) matches.push(`${relativePath}: ${label}`);
    }
  }
  assert.deepEqual(matches, [], 'rejected live claim matches must be corrected or precisely scoped');
});

test('current ROI and dashboard surfaces disclose measured coverage and separate causal evidence', () => {
  const readme = read('README.md');
  const methodology = read('docs', 'METHODOLOGY.md');
  const roiDocs = read('docs', 'RETURN-ON-INTELLIGENCE.md');
  const cli = read('src', 'cli', 'valueCmd.ts');
  const voi = read('src', 'value', 'voi.ts');
  const classic = read('src', 'dashboard', 'web', 'classic.html');
  const modern = read('src', 'dashboard', 'web', 'app', 'views', 'value.ts');

  for (const source of [readme, methodology, roiDocs, cli, classic, modern]) {
    assert.match(source, /observed(?:\/manual-equivalent)? value scenario|observed\/manual-equivalent/i);
    assert.match(source, /causal (?:study|net benefit)|causal evidence/i);
  }
  assert.match(voi, /observed score|sensitivity|may raise or lower|either direction/i);
  assert.match(methodology, /measured|unmeasured|unknown necessary lenses/i);
  assert.match(roiDocs, /sensitivity|disclosed neutral reference|instrumentation/i);
  assert.match(cli, /instrument|coverage|unmeasured/i);
  assert.match(voi, /reference|sensitivity|may raise or lower|either direction/i);
  assert.match(classic, /causal net benefit|not causal evidence/i);
  assert.match(modern, /not causal evidence|causal study/i);
});

test('intentional historical or quoted claim matches are explicit and narrow', () => {
  const gate = read('docs', 'RELEASE-GATE.md');
  const historicalPlan = read('docs', 'superpowers', 'plans', '2026-07-10-ultrareview-bugfixes.md');
  const intentional = [
    {
      source: gate,
      text: 'compliance certification, a Vanta replacement, “zero egress,” a verified',
      reason: 'release-gate prohibition quoted as an intentional non-claim example',
    },
    {
      source: gate,
      text: 'proving the prefix never leaves the machine.',
      reason: 'historical path-prefix forwarding evidence retained verbatim',
    },
    {
      source: historicalPlan,
      text: 'contradicting its core "nothing leaves your machine unless you opt up" pitch.',
      reason: 'historical research-plan quotation retained verbatim',
    },
  ];
  for (const entry of intentional) {
    assert.ok(entry.source.includes(entry.text), `${entry.reason} must remain explicitly enumerated`);
  }
});

test('current boundary and release-gate docs describe declared egress and historical evidence binding', () => {
  const claude = read('CLAUDE.md');
  const product = read('PRODUCT.md');
  const architecture = read('docs', 'ARCHITECTURE.md');
  const server = read('src', 'dashboard', 'server.ts');
  const db = read('src', 'store', 'db.ts');
  const landing = read('web', 'index.html');
  const releaseGate = read('docs', 'RELEASE-GATE.md');

  for (const source of [claude, product, architecture, landing]) {
    assert.match(source, /local-first/i);
    assert.match(source, /configured (?:provider|upstream)|declared egress|egress boundary|outbound/i);
  }
  for (const source of [server, db]) {
    assert.match(source, /local|localhost/i);
    assert.match(source, /declared egress|egress boundary|outbound/i);
  }
  assert.match(architecture, /build|compiled|distribution/i);
  assert.match(releaseGate, /historical[^\n]{0,160}SHA[^\n]{0,160}gate version|SHA[^\n]{0,160}gate version[^\n]{0,160}historical/i);
  assert.match(releaseGate, /exact candidate|recorded candidate commit/i);
});
