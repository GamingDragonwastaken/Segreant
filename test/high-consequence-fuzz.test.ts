import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatHighConsequenceFuzzReport,
  runHighConsequenceFuzzAssurance,
} from './support/high-consequence-fuzz.ts';

test('WP-H03 deterministic fuzz sweep exercises kernel, allocation, and boundary cases', () => {
  const report = runHighConsequenceFuzzAssurance();

  assert.equal(report.allPropertiesHeld, true, formatHighConsequenceFuzzReport(report));
  assert.equal(report.graphCases, 160);
  assert.equal(report.allocationCases, 120);
  assert.equal(report.boundaryCases, 240);
  assert.ok(report.reachableEdges > 0);
  assert.ok(report.unrelatedNodes > 0);
  assert.ok(report.malformedBoundaryInputs > 0);
  assert.equal(report.failures.length, 0);
});

test('WP-H03 fuzz report is deterministic and carries replay coordinates', () => {
  const first = runHighConsequenceFuzzAssurance();
  const second = runHighConsequenceFuzzAssurance();
  assert.deepEqual(first, second);
  assert.equal(first.seed, 0x48_03_fade);
  assert.match(formatHighConsequenceFuzzReport(first), /seed=1208220382/);
  assert.match(formatHighConsequenceFuzzReport(first), /graphCases=160/);
  assert.match(formatHighConsequenceFuzzReport(first), /allocationCases=120/);
  assert.match(formatHighConsequenceFuzzReport(first), /boundaryCases=240/);
});
