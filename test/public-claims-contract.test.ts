/**
 * Public product claims are part of the financial-control surface. This test
 * pins the known false privacy/coverage shortcuts and requires every current
 * surface to route an operator to the executable capability/evidence contract.
 * Historical audit and release records are deliberately outside this scope.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
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

test('landing metadata scopes provider traffic instead of claiming code never leaves the machine', () => {
  const head = read('web', 'index.html').split('</head>', 1)[0]!;

  assert.doesNotMatch(head, /(?:no|without)\s+(?:a\s+)?byte(?:s?)\s+of\s+(?:your\s+)?code\s+(?:leaves|leaving)\s+(?:the\s+)?(?:machine|device)/i);
  assert.match(head, /local-first/i);
  assert.match(head, /routed provider traffic|upstream you configure|configured provider/i);
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
  const rootCli = read('src', 'cli.ts');

  assert.match(readme, /Observed value scenario/);
  assert.doesNotMatch(readme, /estimated causal return exceeds/i);
  assert.doesNotMatch(classic, /Causal RoI return|Gross upper-bound|estimated causal return above break-even/i);
  assert.match(classic, /Observed value scenario/);
  assert.match(modern, /not causal evidence/);
  assert.match(modern, /causalStudyCard/);
  assert.match(contract, /qualified causal-study result/i);
  assert.match(protocol, /production code cannot create\s+a new v1\s+assignment/i);
  assert.match(protocol, /CLI\s+does not yet expose v2 protocol registration or assignment/i);
  assert.match(causalCli, /exposes retained version-1 status, inspection, and replay verification only/i);
  assert.match(causalCli, /Public causal mutations and version-2 projection are deferred/i);
  assert.doesNotMatch(causalCli, /register without --apply|fiscus causal register --file/i);
  assert.match(rootCli, /V1 is inspect-only/i);
  assert.match(rootCli, /all causal\s+mutations and v2 public projection remain deferred/i);
  assert.doesNotMatch(rootCli, /Registration\/assignment are local-only and require/i);
  assert.doesNotMatch(causalCli, /provider route.*=/i);
  assert.match(modern, /Version-2 studies and every causal mutation remain Store-only or deferred/i);
  assert.doesNotMatch(modern, /fiscus causal register|use pre-exposure randomized assignment/i);
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
  'docs/CAPABILITY-EVIDENCE-CONTRACT.md',
  'docs/ECONOMIC-CONTROL-FOUNDATION.md',
  'docs/FAQ.md',
  'docs/INTEGRATIONS.md',
  'docs/METHODOLOGY.md',
  'docs/RETURN-ON-INTELLIGENCE.md',
  'docs/DATA-BOUNDARIES.md',
  'docs/CAUSAL-EVIDENCE-PROTOCOL.md',
  'docs/LIFT-AI-SIDE-JUDGE-DESIGN.md',
  'docs/RELEASE-GATE.md',
  'src/cli/causalCmd.ts',
  'src/cli/valueCmd.ts',
  'src/config.ts',
  'src/dashboard/server.ts',
  'src/dashboard/routes.ts',
  'src/dashboard/web/classic.html',
  'src/dashboard/web/app/main.ts',
  'src/dashboard/web/app/core/actions.ts',
  'src/dashboard/web/app/core/api.ts',
  'src/dashboard/web/app/core/registry.ts',
  'src/dashboard/web/app/views/data.ts',
  'src/dashboard/web/app/views/value.ts',
  'src/store/db.ts',
  'src/cli/teamCmd.ts',
  'src/value/instrumentationSensitivity.ts',
  'src/value/lenses.ts',
  'src/value/frontier.ts',
  'src/value/reliability.ts',
  'src/value/cohort.ts',
  'src/value/drift.ts',
  'src/judge/tier.ts',
  'src/judge/orchestrate.ts',
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
  ['blanket code-never-leaves claim', /(?:no|without)\s+(?:a\s+)?byte(?:s?)\s+of\s+(?:your\s+)?code\s+(?:leaves|leaving)\s+(?:the\s+)?(?:machine|device)/i],
  ['blanket nothing-ever-sent-off-device claim', /nothing\s+is\s+ever\s+sent\s+off[- ]device/i],
  ['blanket nothing-sent-anywhere claim', /nothing\s+is\s+(?:ever\s+)?sent\s+anywhere/i],
  ['blanket never-transmitted claim', /(?:is|are) never transmitted anywhere/i],
  ['historical path-prefix machine-boundary claim', /proving the prefix never leaves the machine\./i],
  ['causal RoI formula in live docs', /RoI_causal\s*=\s*RoI_gross/i],
  ['causal RoI break-even formula in live docs', /RoI_causal[^\n]{0,240}(?:pays for itself|break-even)/is],
  // WP-A07. The aggregator, its weights and the shrinkage weight are all
  // legitimate calculations described in language stronger than the mathematics
  // supports. Each pattern below names one specific overclaim, not the
  // calculation it decorates.
  ['geometric form asserted as forced without its axiom set', /\b(?:form is forced|forces the log generator)\b/i],
  ['lens weights called empirical output elasticities', /lens(?:es)?['’]?s? (?:\*\*)?output elasticit/i],
  ['CES substitution parameter called the elasticity of substitution', /θ is the elasticity of substitution/],
  ['aggregator zero-collapse asserted as economic impossibility', /no (?:single )?axis can (?:compensate|be bought back)/i],
  ['Stein dominance claimed for empirical-Bayes rate shrinkage', /Stein['’]s result|strictly beats the raw rate/i],
  ['shrinkage weight labelled confidence', /plain-language ["“]confidence["”]|Confidence[^\n]{0,32}(?:view\.reliability|\.reliability\b)/i],
  ['observational separation labelled evidence-supported', /evidence_supported/],
  ['rate drift labelled Goodhart without an incentive model', /Goodhart(?:-proof|-resistance| alarm| streams| watch)/i],
];

const INTENTIONAL_REJECTED_CLAIMS = [
  {
    relativePath: 'docs/RELEASE-GATE.md',
    label: 'blanket zero-egress claim',
    text: 'zero egress',
    count: 1,
    reason: 'release-gate prohibition quoted as an intentional non-claim example',
  },
  {
    relativePath: 'docs/RELEASE-GATE.md',
    label: 'historical path-prefix machine-boundary claim',
    text: 'proving the prefix never leaves the machine.',
    count: 1,
    reason: 'historical path-prefix forwarding evidence retained verbatim',
  },
  {
    relativePath: 'docs/RELEASE-GATE.md',
    label: 'observational separation labelled evidence-supported',
    text: 'evidence_supported',
    count: 11,
    reason:
      'commit-bound gate rows record the label the packaged artifact carried at that commit — each row says the demo showed NO evidence_supported. ' +
      'Rewriting them would falsify the evidence they exist to preserve. New rows use the observational label; this count must be reviewed, not bumped.',
  },
] as const;

function matchesIn(source: string, pattern: RegExp): string[] {
  const globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  return Array.from(source.matchAll(globalPattern), (match) => match[0]);
}

test('the rejected-claim scan keeps universal value and privacy wording out of current surfaces', () => {
  const matches: Array<{ relativePath: string; label: string; text: string }> = [];
  for (const relativePath of CURRENT_CLAIM_SURFACES) {
    const source = read(...relativePath.split('/'));
    for (const [label, pattern] of REJECTED_LIVE_CLAIMS) {
      for (const text of matchesIn(source, pattern)) matches.push({ relativePath, label, text });
    }
  }

  for (const intentional of INTENTIONAL_REJECTED_CLAIMS) {
    const actual = matches.filter((match) =>
      match.relativePath === intentional.relativePath &&
      match.label === intentional.label &&
      match.text === intentional.text,
    ).length;
    assert.equal(actual, intentional.count, `${intentional.reason}: exact occurrence count`);
  }

  const residual = matches.filter((match) => !INTENTIONAL_REJECTED_CLAIMS.some((intentional) =>
    intentional.relativePath === match.relativePath &&
    intentional.label === match.label &&
    intentional.text === match.text,
  ));
  assert.deepEqual(residual, [], 'rejected live claim matches must be corrected or precisely scoped');
});

test('README and both dashboards separate ordinary value scenarios from causal evidence', () => {
  const readme = read('README.md');
  const classic = read('src', 'dashboard', 'web', 'classic.html');
  const modern = read('src', 'dashboard', 'web', 'app', 'views', 'value.ts');

  assert.match(readme, /Observed value scenario/);
  assert.match(readme, /not a causal return|qualified causal-study result|causal net benefit result is separate/i);
  assert.match(classic, /Observed value scenario/);
  assert.match(classic, /qualified randomized study is required for causal net benefit|not causal evidence/i);
  assert.match(modern, /causalStudyCard/);
  assert.match(modern, /not causal evidence|causal study/i);
});

test('modern dashboard egress copy qualifies local UI and file detection separately from outbound traffic', () => {
  const shell = read('src', 'dashboard', 'web', 'app', 'main.ts');
  const data = read('src', 'dashboard', 'web', 'app', 'views', 'data.ts');

  assert.match(shell, /configured egress boundary|configured provider|outbound/i);
  assert.match(data, /configured egress boundary|configured provider|outbound/i);
  assert.doesNotMatch(shell, /nothing\s+is\s+(?:ever\s+)?sent\s+anywhere/i);
  assert.doesNotMatch(data, /nothing\s+is\s+(?:ever\s+)?sent\s+anywhere/i);
});

test('CLI and ROI documentation qualify scenario values separately from causal results', () => {
  const cli = read('src', 'cli', 'valueCmd.ts');
  const roiDocs = read('docs', 'RETURN-ON-INTELLIGENCE.md');

  assert.match(cli, /Value scenario/);
  assert.match(cli, /causal study required for break-even|not a causal return/i);
  assert.match(roiDocs, /observed value scenario/i);
  assert.match(roiDocs, /qualified causal-study result|causal net benefit result is separate/i);
});

test('instrumentation sensitivity and methodology describe coverage and two-direction movement', () => {
  const methodology = read('docs', 'METHODOLOGY.md');
  const sensitivity = read('src', 'value', 'instrumentationSensitivity.ts');

  assert.match(methodology, /measured|unmeasured|unknown necessary lenses/i);
  assert.match(methodology, /coverage/i);
  assert.match(sensitivity, /reference|sensitivity/i);
  assert.match(sensitivity, /may raise or lower|either direction/i);
});

test('the ambiguous realized-value identifier cannot return to the source tree', () => {
  // AII-012. `realizedValueUsd` named two different claims: the attributed
  // SPEND on units that realized, and the manual-equivalent VALUE they produced.
  // Reading one where the other was meant is not a typo — it is the collapse of
  // cost into value that this product exists to refuse, and it shipped once
  // precisely because both fields were real, numeric and identically named, so
  // neither the compiler nor a reviewer could see it. The split identifiers make
  // that substitution a type error; this keeps the ambiguous name from coming
  // back and quietly re-enabling it.
  const offenders: string[] = [];
  let scanned = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'dist') continue;
        walk(rel);
        continue;
      }
      if (!/\.(ts|html|mjs)$/.test(entry.name)) continue;
      // Backtick-quoted mentions are prose explaining why the name was split,
      // which is worth keeping. Anything else is the identifier itself.
      const source = read(...rel.split('/'));
      scanned += 1;
      // `realizedValueRate` was the same conflation one derivative down: a share
      // of attributed SPEND, named as a rate of value.
      if (/(?<![A-Za-z`])(?:realizedValueUsd|realizedValueRate)(?![A-Za-z`])/.test(source)) offenders.push(rel);
    }
  };
  walk('src');
  // `team-server/` is a separate npm project with its own tsconfig, so the root
  // typecheck cannot see it — but it imports `ProjectValue` straight out of
  // `src/team/rollup.ts`. The first attempt at this migration renamed `src/`
  // only, passed every root gate, and broke the team-server typecheck on CI in
  // sixteen places. A ban that stops at `src/` is a ban with a hole in it.
  walk('team-server/src');
  walk('team-server/test');
  assert.ok(scanned > 150, `the walk must be non-vacuous, scanned ${scanned}`);
  assert.deepEqual(offenders, [], 'use spendOnRealizedUnitsUsd / realizedSpendShare for cost, manualEquivalentValueUsd for value; never the ambiguous names');
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
