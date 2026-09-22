/**
 * EVERY PROPOSITION THE PRODUCT ISSUES IS CLASSIFIED BY POLARITY, AND EVERY
 * ABSENCE-ASSERTING ONE NAMES ITS COMPLETENESS MECHANISM (WP-R04, D-245).
 *
 * "Absence requires completeness": a claim that nothing happened is sound only
 * over a stream shown complete for the event type, scope and period. D-109
 * gave the kernel that rule for typed `negativeClaim`s and the coding `clean`
 * gate its witnesses, and left "other negative claims need the same boundary
 * audit" open. This is that audit, as a gate: the set of proposition
 * predicates issued anywhere under `src/` is enumerated from the source, and
 * every predicate must be classified here as
 *
 *   - `positive`   asserts that something was observed or computed; its
 *                  support is the cited evidence and needs no completeness;
 *   - `bound`      asserts a LIMIT on what was not observed (a residual, an
 *                  off-path bound) and carries that bound typed in its value,
 *                  never as an absence;
 *   - `negative`   asserts absence, and must name the mechanism that
 *                  establishes completeness before it is issued.
 *
 * A predicate issued in the source and missing here fails; a classification
 * naming a predicate the source no longer issues fails; a `negative` entry
 * must point at a mechanism string that appears in its issuing file.
 *
 * Measured: twelve predicates. One is `negative` in effect — coding
 * realization's `clean` gate inside `value.realization_recorded`, which is
 * withheld without qualifying witnesses for both `commit_reverted` and
 * `linked_incident`; one is a `bound` (`billing.reconciled_with_residual`);
 * the rest are positive. Coding `clean` stays UNRESOLVED on a machine with only
 * a git revert scan, because git witnesses revert coverage and nothing local
 * witnesses incidents — that is the rule working, not a gap in it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

type Polarity = 'positive' | 'bound' | 'negative';

const CLASSIFIED: ReadonlyArray<{ predicate: string; polarity: Polarity; file: string; mechanism?: string; why: string }> = [
  { predicate: 'billing.billed_amount', polarity: 'positive', file: 'src/billing/epistemic.ts', why: 'one imported billing line, cited by its own evidence' },
  { predicate: 'billing.billed_period_total', polarity: 'positive', file: 'src/billing/epistemic.ts', why: 'a sum over cited records; coverage is the import run\'s declared coverage, not an absence claim' },
  { predicate: 'billing.provider_observed_amount', polarity: 'positive', file: 'src/billing/epistemic.ts', why: 'one provider Costs line' },
  { predicate: 'billing.provider_observed_period_total', polarity: 'positive', file: 'src/billing/epistemic.ts', why: 'a sum over cited observations' },
  { predicate: 'billing.reconciled_with_residual', polarity: 'bound', file: 'src/billing/epistemic.ts', why: 'the unexplained variance is carried as a typed residual with `offPathBound`; off-path provider usage is stated unobservable, never absent' },
  { predicate: 'causal.arm_difference_observed', polarity: 'positive', file: 'src/causal/epistemic.ts', why: 'an observed difference between arms' },
  { predicate: 'causal.effect_supported', polarity: 'positive', file: 'src/causal/epistemic.ts', why: 'a qualified causal effect, issued only when the study gates pass' },
  { predicate: 'decision.utility_interval_observed', polarity: 'positive', file: 'src/decision/epistemic.ts', why: 'the observed utility intervals' },
  { predicate: 'decision.fitness_sufficient', polarity: 'positive', file: 'src/decision/epistemic.ts', why: 'a dominance result over declared alternatives; "no better alternative" is over the DECLARED set, which the assurance assumptions state' },
  { predicate: 'economic.allocation_recorded', polarity: 'positive', file: 'src/alloc/epistemic.ts', why: 'a recorded allocation run' },
  { predicate: 'economic.period_closed', polarity: 'positive', file: 'src/economics/epistemic.ts', why: 'a closed period balance over cited charges' },
  {
    predicate: 'value.realization_recorded', polarity: 'negative', file: 'src/value/epistemic.ts',
    mechanism: 'requires qualifying completeness witnesses for the clean gate',
    why: 'carries the coding `clean` gate, an absence claim over reverts and incidents; withheld from issuance without a supported CompletenessWitness for both `commit_reverted` and `linked_incident`',
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

test('every issued proposition predicate is classified by polarity, and every negative one names a completeness mechanism that exists', () => {
  const issued = new Map<string, Set<string>>();
  for (const full of sourceFiles()) {
    const file = relative(ROOT, full).replaceAll('\\', '/');
    for (const match of readFileSync(full, 'utf8').matchAll(/predicate: '([a-z_.]+)'/g)) {
      const predicate = match[1]!;
      issued.set(predicate, (issued.get(predicate) ?? new Set()).add(file));
    }
  }
  assert.ok(issued.size >= 10, `the predicate corpus must be found (${issued.size})`);

  const unclassified = [...issued.keys()].filter((predicate) => !CLASSIFIED.some((entry) => entry.predicate === predicate));
  assert.deepEqual(unclassified, [], 'a proposition predicate is issued and its polarity is not stated');

  const stale = CLASSIFIED.filter((entry) => !issued.has(entry.predicate));
  assert.deepEqual(stale.map((entry) => entry.predicate), [], 'a classification names a predicate the source no longer issues');

  for (const entry of CLASSIFIED) {
    assert.ok(issued.get(entry.predicate)!.has(entry.file), `${entry.predicate} is classified under ${entry.file} but issued in ${[...issued.get(entry.predicate)!].join(', ')}`);
    if (entry.polarity === 'negative') {
      assert.ok(entry.mechanism, `${entry.predicate} asserts absence and must name its completeness mechanism`);
      assert.ok(readFileSync(join(ROOT, entry.file), 'utf8').includes(entry.mechanism!), `${entry.predicate}: mechanism ${JSON.stringify(entry.mechanism)} is not in ${entry.file}`);
    } else {
      assert.equal(entry.mechanism, undefined, `${entry.predicate} is ${entry.polarity} and needs no completeness mechanism`);
    }
  }
  const negatives = CLASSIFIED.filter((entry) => entry.polarity === 'negative');
  assert.ok(negatives.length >= 1, 'the audit must find the one negative predicate it was written for');
});
