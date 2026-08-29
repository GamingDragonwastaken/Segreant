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
