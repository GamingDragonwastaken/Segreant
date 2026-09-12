/**
 * A team total must say whether the rollups it summed were whole snapshots.
 *
 * WHAT `aggregateProjects` ASSUMES. It keeps `latest_rollup_per_dev` and treats
 * that one rollup as the developer's window. That assumption is only true if
 * every contributing rollup covered every project on its machine. Nothing on
 * the wire said so, so the assumption could not be checked and was not stated:
 * a total summed from a scoped rollup and a whole one reported exactly the same
 * `coverage` block as a total summed from two whole ones.
 *
 * WHY THE SERVER STATES IT RATHER THAN REFUSING IT. A rollup pushed by an older
 * client declares no scope at all, and `unknown` is not `project` — refusing
 * every rollup that cannot say would refuse the ones that merely predate the
 * field, which is inferring provenance from silence in the other direction.
 * The honest move is the one D-102 already made for unequal windows: neither
 * refuse nor reweight, state the basis. `wholeSnapshot` is true only when every
 * contributing rollup declared `all-projects`, and an empty set reports false
 * for the reason the empty window coverage reports `uniform: false` — nothing
 * is not agreement.
 *
 * WHAT THIS DOES NOT ESTABLISH. That the totals are right, or that a rollup
 * declaring `all-projects` really covered them: that check lives at the mint,
 * against the ledger, and a server cannot repeat it. This asserts only that the
 * claim survives the wire and reaches the reader of the total.
 *
 * Recorded at D-199.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWindowCoverage } from '../src/aggregate.ts';
import type { ObservationWindow } from '../src/store.ts';

function window(overrides: Partial<ObservationWindow> = {}): ObservationWindow {
  return {
    periodFrom: '2026-06-01T00:00:00.000Z',
    periodTo: '2026-07-01T00:00:00.000Z',
    developerCount: 1,
    coverage: 'complete',
    scopes: ['all-projects'],
    ...overrides,
  } as ObservationWindow;
}

test('a total summed only from whole snapshots says so', () => {
  const coverage = buildWindowCoverage([window()]) as unknown as { wholeSnapshot?: boolean; scopeKinds?: string[] };
  assert.equal(coverage.wholeSnapshot, true);
  assert.deepEqual(coverage.scopeKinds, ['all-projects']);
});

test('one scoped contributor is enough to stop the total calling itself a snapshot', () => {
  const coverage = buildWindowCoverage([
    window(),
    window({ periodFrom: '2026-06-02T00:00:00.000Z', scopes: ['project'] }),
  ]) as unknown as { wholeSnapshot?: boolean; scopeKinds?: string[]; note?: string };
  assert.equal(coverage.wholeSnapshot, false);
  assert.deepEqual(coverage.scopeKinds, ['all-projects', 'project']);
  assert.match(coverage.note ?? '', /project|scope/i, 'the note must say what the total is not');
});

test('a contributor that cannot say is not read as a snapshot', () => {
  const coverage = buildWindowCoverage([window({ scopes: ['unknown'] })]) as unknown as { wholeSnapshot?: boolean };
  assert.equal(coverage.wholeSnapshot, false, 'legacy silence is unknown, and unknown is never all-projects');
});

test('an empty set of contributors is not an agreeing one', () => {
  const coverage = buildWindowCoverage([]) as unknown as { wholeSnapshot?: boolean; scopeKinds?: string[] };
  assert.equal(coverage.wholeSnapshot, false);
  assert.deepEqual(coverage.scopeKinds, []);
});
