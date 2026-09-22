/**
 * EVERY ADVICE PRODUCER IN THE PRODUCT IS CLASSIFIED: GATED, WITHHELD, OR
 * OFFLINE (WP-F05, D-248).
 *
 * D-220 put the budget cap through the assurance gate and D-240 the frontier's
 * model switches. What remained was the claim that nothing ELSE advises: the
 * usage/cohort path, the advisor's frontier reallocation hints, the raw
 * allocation helper. This gate enumerates every exported function under `src/`
 * whose name says it recommends or advises and requires each to be classified:
 *
 *   - `gated`     its output carries a `DecisionAssuranceGate` (the probe here
 *                 calls it and reads `assurance.requiredLevel`);
 *   - `withheld`  it exists but no product path calls it, and the gate proves
 *                 that by reading the import graph;
 *   - `consumer`  a CLI/GUI surface that renders a gated producer and refuses
 *                 to act below the bar (the refusal string must be present).
 *
 * Two more facts are pinned because they were once false or once dead code:
 * `recommendBudget` never turns frontier cells into a trim/grow action (the
 * `frontier` input is accepted for compatibility and not read), and the usage
 * path's "largest exposure" line is labelled as not a recommendation.
 *
 * Not established here: whether a caller declared EVERY input its decision
 * rests on. The gate reads the declared set; completeness of that set is the
 * evidence holder's claim and stays a review item, never inferred.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recommendBudget } from '../src/budget/recommend.ts';
import { claimProfile } from '../src/epistemic/profile.ts';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

type Kind = 'gated' | 'withheld' | 'consumer';

const CLASSIFIED: ReadonlyArray<{ name: string; file: string; kind: Kind; probe: () => void }> = [
  {
    name: 'recommendBudget', file: 'src/budget/recommend.ts', kind: 'gated',
    probe: () => {
      const rec = recommendBudget({
        dailySpends: Array.from({ length: 14 }, (_, i) => 10 + (i % 3)),
        realizedSpendShare: 0.5,
        currentDailyCapUsd: null,
        frontier: [
          { key: 'a', roiIndex: 5, costUsd: 100 } as never,
          { key: 'b', roiIndex: 500, costUsd: 100 } as never,
        ],
        decisionInputs: [{ id: 'claim:test', profile: claimProfile({ epistemic: 'supported', integrity: 'unknown', authenticity: 'self_asserted', scope: 'conditional', coverage: 'partial', measurement: 'proxy_unvalidated', causality: 'none', monetaryBasis: 'list', finality: 'provisional', decisionFitness: 'not_assessed' }) }],
      });
      assert.ok(rec.decision, 'a review-ready recommendation carries its decision');
      assert.equal(rec.decision!.assurance.requiredLevel, 'DAL-3', 'a cap changes spend');
      assert.equal(rec.decision!.assurance.authorizesAction, false);
      assert.deepEqual(rec.reallocations, [], 'frontier cells never become a trim/grow action');
    },
  },
  {
    name: 'budgetAdvice', file: 'src/value/report.ts', kind: 'gated',
    // Wraps recommendBudget with the store-derived basis; the gate rides on the wrapped decision.
    probe: () => { assert.ok(readFileSync(join(ROOT, 'src/value/report.ts'), 'utf8').includes('decisionInputs: budgetCapDecisionInputs(')); },
  },
  {
    name: 'recommendAllocation', file: 'src/budget/allocate.ts', kind: 'withheld',
    probe: () => {
      const callers = sourceFiles().filter((f) => !f.endsWith(join('budget', 'allocate.ts')) && /\brecommendAllocation\b/.test(readFileSync(f, 'utf8')));
      assert.deepEqual(callers, [], 'the raw allocation helper is offline: no product path calls it');
    },
  },
  {
    name: 'cmdBudgetAdvisor', file: 'src/cli/valueCmd.ts', kind: 'consumer',
    probe: () => {
      const src = readFileSync(join(ROOT, 'src/cli/valueCmd.ts'), 'utf8');
      assert.ok(src.includes('requires a certified DecisionCertificate at'), 'the advisor refuses --apply below the bar');
      assert.ok(src.includes('not a purchase'), 'the usage path labels its exposure line as not a recommendation');
    },
  },
];

function sourceFiles(dir = join(ROOT, 'src')): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('every exported advice producer is classified and its probe holds', () => {
  const found: { name: string; file: string }[] = [];
  for (const full of sourceFiles()) {
    const file = relative(ROOT, full).replaceAll('\\', '/');
    for (const m of readFileSync(full, 'utf8').matchAll(/^export (?:async )?function ([A-Za-z]*(?:recommend|Recommend|advice|Advice|advis|Advis)[A-Za-z]*)\(/gm)) {
      found.push({ name: m[1]!, file });
    }
  }
  assert.ok(found.length >= 3, `the advice corpus must be found (${found.length})`);
  const unclassified = found.filter((f) => !CLASSIFIED.some((c) => c.name === f.name && c.file === f.file));
  assert.deepEqual(unclassified, [], 'an advice producer exists that is neither gated, withheld, nor a refusing consumer');
  const stale = CLASSIFIED.filter((c) => !found.some((f) => f.name === c.name && f.file === c.file));
  assert.deepEqual(stale.map((c) => c.name), [], 'a classification names a producer the source no longer exports');
  for (const entry of CLASSIFIED) entry.probe();
});

test('recommendBudget does not read its frontier input: the reallocation hint is withheld by construction, not by an empty fixture', () => {
  const src = readFileSync(join(ROOT, 'src/budget/recommend.ts'), 'utf8');
  assert.equal(/inp\.frontier|input\.frontier/.test(src), false, 'frontier cells are accepted for compatibility and never ranked into an action');
  assert.equal(/const cells: FrontierCell\[\] = \[\]/.test(src), false, 'the dead reallocation branch has been removed rather than disabled by an empty constant');
});
