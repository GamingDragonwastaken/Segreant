/**
 * A total says how it was priced, in parts (H003, H007, H011). The headline word
 * follows the weakest part, and an amount a tool reported is never called list
 * price.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeBasis, cohortOf } from '../src/cost/basis.ts';
import { basisLines } from '../src/cli/basisLines.ts';

const row = (model: string, costBasis: string, rateMatchKind: string, costUsd: number, requests = 1) =>
  ({ provider: 'openai', model, costBasis, rateMatchKind, costUsd, requests });

test('each ledger basis lands in its own cohort; a family match is not an exact one', () => {
  assert.equal(cohortOf({ costBasis: 'local_list_price', rateMatchKind: 'exact_provider' }), 'list_exact');
  assert.equal(cohortOf({ costBasis: 'local_list_price', rateMatchKind: 'exact_cross_provider' }), 'list_exact');
  assert.equal(cohortOf({ costBasis: 'local_list_price', rateMatchKind: 'family_provider' }), 'list_family');
  assert.equal(cohortOf({ costBasis: 'fallback_estimate', rateMatchKind: 'fallback' }), 'fallback');
  assert.equal(cohortOf({ costBasis: 'tool_reported_unverified', rateMatchKind: 'reported' }), 'tool_reported');
  assert.equal(cohortOf({ costBasis: 'legacy_unknown', rateMatchKind: 'legacy_unknown' }), 'unrecorded');
});

test('the headline word follows the weakest part', () => {
  assert.equal(summarizeBasis([row('gpt-6-sol', 'local_list_price', 'exact_provider', 5)]).headlineLabel, 'List cost');
  assert.equal(summarizeBasis([
    row('gpt-6-sol', 'local_list_price', 'exact_provider', 5),
    row('custom-x', 'unpriced', 'unpriced', 0, 3),
  ]).headlineLabel, 'List cost', 'unpriced rows add requests, not dollars');
  assert.equal(summarizeBasis([
    row('gpt-6-sol', 'local_list_price', 'exact_provider', 5),
    row('mystery', 'fallback_estimate', 'fallback', 1),
  ]).headlineLabel, 'Estimated cost');
  assert.equal(summarizeBasis([row('m', 'tool_reported_unverified', 'reported', 123.45)]).headlineLabel, 'Tool-reported cost');
  assert.equal(summarizeBasis([row('m', 'synthetic_demo', 'exact_provider', 9)]).headlineLabel, 'Sample cost');
  assert.equal(summarizeBasis([]).headlineLabel, 'Cost');
});

test('a tool-reported amount is printed as tool-reported, never as API list price (H007)', () => {
  const basis = summarizeBasis([
    row('gpt-6-sol', 'local_list_price', 'exact_provider', 10, 4),
    row('unknown-model', 'tool_reported_unverified', 'reported', 123.45, 1),
  ]);
  const text = basisLines(basis, '').join('\n');
  assert.match(text, /\$123\.45  tool-reported/);
  assert.match(text, /\$10\.00  list price/);
  assert.match(text, /None of these is your bill\./);
  assert.equal(basis.exactShare, 10 / 133.45);
});

test('fallback models are named, costliest first (H011)', () => {
  const basis = summarizeBasis([
    row('codex-auto-review', 'fallback_estimate', 'fallback', 77),
    row('gpt-6.1-sol', 'fallback_estimate', 'fallback', 305),
    row('gemini-pro-default', 'fallback_estimate', 'fallback', 1),
  ]);
  const fb = basis.cohorts.find((c) => c.id === 'fallback')!;
  assert.deepEqual(fb.models.map((m) => m.model), ['gpt-6.1-sol', 'codex-auto-review', 'gemini-pro-default']);
  assert.match(basisLines(basis, '').join('\n'), /fallback rate: gpt-6\.1-sol, codex-auto-review and 1 more/);
});

test('a free model the tool reported at $0 reads as no charge, not as a $0.00 price', () => {
  const text = basisLines(summarizeBasis([
    row('gpt-6-sol', 'local_list_price', 'exact_provider', 10),
    row('union-alpha', 'tool_reported_unverified', 'reported', 0, 859),
  ]), '').join('\n');
  assert.match(text, /859 requests the tool reported at no charge: union-alpha/);
  assert.doesNotMatch(text, /\$0\.00  tool-reported/);
});

test('a fallback part points at reprice, which previews before it writes', () => {
  const text = basisLines(summarizeBasis([row('gpt-6.1-sol', 'fallback_estimate', 'fallback', 305)]), '').join('\n');
  assert.match(text, /segreant reprice  previews new prices/);
  assert.match(text, /nothing changes without --apply/);
});
