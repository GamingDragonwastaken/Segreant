/**
 * WP-H03: bounded mutation assurance for high-consequence invariants.
 *
 * The support module does not edit source files, use a database, or use random
 * input. It runs a fixed set of in-memory predicate mutations and proves that
 * an adversarial oracle would fail closed against each one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatHighConsequenceMutationReport,
  runHighConsequenceMutationAssurance,
} from './support/high-consequence-mutations.ts';

test('WP-H03 kills every bounded high-consequence mutant', () => {
  const report = runHighConsequenceMutationAssurance();

  assert.equal(report.allKilled, true, formatHighConsequenceMutationReport(report));
  assert.equal(report.mutations.length, 6);
  assert.equal(report.killed, report.mutations.length);
  assert.equal(report.survived, 0);
  assert.deepEqual(
    report.mutations.map((mutation) => mutation.name),
    [
      'forged conservation boolean',
      'conservation line-total drift',
      'conflicted completeness downgraded to supported',
      'transitive revocation edge omitted',
      'execution-plan qualification gate removed',
      'one-rival dominance accepted as robust dominance',
    ],
  );
});

test('WP-H03 report is deterministic and names the refusal contract', () => {
  const first = runHighConsequenceMutationAssurance();
  const second = runHighConsequenceMutationAssurance();
  assert.deepEqual(first, second);

  for (const mutation of first.mutations) {
    assert.equal(mutation.expectedRefusal.length > 0, true);
    assert.equal(mutation.target.length > 0, true);
    assert.equal(mutation.assurance, 'killed');
    assert.equal(mutation.actualOutcome, 'accepted');
  }

  const rendered = formatHighConsequenceMutationReport(first);
  assert.match(rendered, /forged conservation boolean/);
  assert.match(rendered, /target=/);
  assert.match(rendered, /expected refusal=/);
  assert.match(rendered, /actual outcome=accepted/);
  assert.match(rendered, /assurance=killed/);
});
