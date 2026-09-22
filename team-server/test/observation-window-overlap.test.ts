/**
 * Two windows of the same length can still describe two different months, and
 * the coverage note reported the gap between them as though it were coverage
 * (WP-C06).
 *
 * WHAT D-102 ALREADY FIXED. A team total used to name no period at all;
 * `buildWindowCoverage` now attaches the number of distinct windows, their
 * shortest and longest length, and the span they fall inside. That was the
 * right repair and this file does not undo any of it.
 *
 * WHAT IT LEFT. The only question `uniform` answers is `windows.length === 1`,
 * and every other field is about LENGTH. Nothing asks whether the windows
 * intersect. Measured on two rollups that both declare a 30-day window, one in
 * January and one in June, the note reads:
 *
 *   contributing rollups declare 2 different observation windows, the shortest
 *   30 days and the longest 30 days, spanning 2026-01-01 to 2026-06-30
 *
 * Both lengths are 30, so the sentence's own comparison finds nothing to
 * report, and "spanning 2026-01-01 to 2026-06-30" describes a six-month period
 * of which the data covers sixty days. The four months in the middle are named
 * as span and observed by nobody. A reader is told the totals "do not describe
 * any single window", which is true and much weaker than the fact: these
 * totals describe two periods with NOTHING in common, and no instant exists at
 * which both machines were being observed.
 *
 * WHY THIS IS NOT PEDANTRY ABOUT WORDING. `totalCostUsd` across disjoint
 * windows is a sum over two separate observations of the world, and the
 * cost-weighted `avgRoiIndex` and unit-weighted `realizationRate` beside it
 * weight January against June as though they were one population. Whether that
 * is acceptable is the reader's call -- which is exactly why the reader has to
 * be told, and `spanning January to June` actively suggests the opposite.
 *
 * THE REPAIR IS THE SAME SHAPE D-102 CHOSE. Not a refusal, not a reweighting:
 * the intersection is stated. `overlap` says whether one instant exists that
 * every contributing window contains, and `overlapFrom`/`overlapTo` give it
 * when it does. The span fields are untouched, because the union is a real
 * fact too -- it was being asked to carry a meaning it does not have.
 *
 * WHAT THIS DOES NOT ESTABLISH. Nothing about whether summing across disjoint
 * windows is ever the right thing to look at, and nothing about the Postgres-
 * backed store: `buildWindowCoverage` is pure and takes the windows it is
 * given, so this file exercises the reporting and not the SQL that collects
 * them.
 *
 * Recorded at D-164.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWindowCoverage } from '../src/aggregate.ts';
import type { ObservationWindow } from '../src/store.ts';

function window(from: string, to: string, developerCount = 1): ObservationWindow {
  // `scopes` is what each contributing rollup declared it covered — a separate
  // axis from `coverage`, and irrelevant to the position question this file
  // asks, so every window here declares the same whole-machine scope.
  return { periodFrom: from, periodTo: to, developerCount, coverage: 'complete', scopes: ['all-projects'] };
}

const JANUARY = window('2026-01-01T00:00:00.000Z', '2026-01-31T00:00:00.000Z');
const JUNE = window('2026-06-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');

test('two equal-length windows in different months are reported as not overlapping', () => {
  // THE COUNTEREXAMPLE. Both 30 days, so every length field agrees and the
  // note found nothing to say beyond "2 different observation windows".
  const coverage = buildWindowCoverage([JANUARY, JUNE]);

  assert.equal(coverage.overlap, false);
  assert.equal(coverage.overlapFrom, null);
  assert.equal(coverage.overlapTo, null);
  assert.match(
    coverage.note,
    /no instant|do not overlap|nothing in common/i,
    `the note must say the windows share no instant; got ${JSON.stringify(coverage.note)}`,
  );
});

test('the span is still reported, because the union is a real fact', () => {
  // The half a fix that simply deleted the span would break. `earliestFrom`
  // and `latestTo` were never wrong; they were being read as coverage.
  const coverage = buildWindowCoverage([JANUARY, JUNE]);

  assert.equal(coverage.earliestFrom, JANUARY.periodFrom);
  assert.equal(coverage.latestTo, JUNE.periodTo);
  assert.equal(coverage.distinctWindows, 2);
  assert.equal(coverage.shortestWindowDays, 30);
  assert.equal(coverage.longestWindowDays, 30);
});

test('windows that do overlap report the instants they actually share', () => {
  // Partial overlap: 2026-01-01..02-15 and 2026-02-01..03-01 share two weeks.
  // The intersection is max(from)..min(to), and it must be the intersection
  // rather than either input.
  const coverage = buildWindowCoverage([
    window('2026-01-01T00:00:00.000Z', '2026-02-15T00:00:00.000Z'),
    window('2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'),
  ]);

  assert.equal(coverage.overlap, true);
  assert.equal(coverage.overlapFrom, '2026-02-01T00:00:00.000Z');
  assert.equal(coverage.overlapTo, '2026-02-15T00:00:00.000Z');
});

test('a single window overlaps itself, and nothing about the uniform case changes', () => {
  // The control. One window was already the honest case and must stay exactly
  // as it reads today, with the intersection equal to the window itself.
  const coverage = buildWindowCoverage([JANUARY]);

  assert.equal(coverage.uniform, true);
  assert.equal(coverage.overlap, true);
  assert.equal(coverage.overlapFrom, JANUARY.periodFrom);
  assert.equal(coverage.overlapTo, JANUARY.periodTo);
  assert.match(coverage.note, /the totals cover that period/);
});

test('three windows overlap only if ALL of them do, not merely some pair', () => {
  // The subtle one, and the reason this is an intersection rather than a
  // pairwise check. January-February and February-March share February;
  // adding June leaves no instant common to all three, and a report that said
  // "overlap: true" because two of the three agreed would be worse than
  // silence -- it would name an agreement that does not exist.
  const coverage = buildWindowCoverage([
    window('2026-01-01T00:00:00.000Z', '2026-02-15T00:00:00.000Z'),
    window('2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'),
    JUNE,
  ]);

  assert.equal(coverage.overlap, false);
  assert.equal(coverage.overlapFrom, null);
  assert.equal(coverage.overlapTo, null);
});

test('windows that merely touch at an endpoint do not overlap', () => {
  // January ends exactly where February begins. A half-open window contains
  // no instant in common with the next one, and reporting a zero-length
  // overlap as an overlap would be reporting an artefact of the boundary.
  const coverage = buildWindowCoverage([
    window('2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'),
    window('2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z'),
  ]);

  assert.equal(coverage.overlap, false);
  assert.equal(coverage.overlapFrom, null);
});

test('an empty set of windows claims neither overlap nor its absence beyond what it knows', () => {
  // Nothing is not disjoint; it is nothing. The existing empty case already
  // refuses to call itself uniform for the same reason, and `overlap` must not
  // become the one field that reads an empty set as a finding.
  const coverage = buildWindowCoverage([]);

  assert.equal(coverage.overlap, false);
  assert.equal(coverage.overlapFrom, null);
  assert.equal(coverage.overlapTo, null);
  assert.match(coverage.note, /no rollups contributed/);
});
