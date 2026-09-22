import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ancestors,
  appendDagEdge,
  appendDagNode,
  asOfGraph,
  assumptionDependencies,
  conflictPaths,
  createEpistemicDag,
  descendants,
  measurementDependencies,
  minimalCutSets,
  minimalSupportingSets,
  projectRevocation,
  supersededBy,
  type DagEdgeInput,
  type DagNodeInput,
} from '../src/epistemic/dag.ts';

const nodes: DagNodeInput[] = [
  { id: 'evidence:invoice', kind: 'evidence', availableAt: '2026-08-02T00:00:00.000Z' },
  { id: 'evidence:experiment', kind: 'evidence', availableAt: '2026-08-03T00:00:00.000Z', epistemic: 'conflicted' },
  { id: 'assumption:coverage', kind: 'assumption', availableAt: '2026-08-01T00:00:00.000Z' },
  { id: 'measurement:cost', kind: 'measurement', availableAt: '2026-08-01T00:00:00.000Z' },
  { id: 'claim:billed', kind: 'claim', availableAt: '2026-08-04T00:00:00.000Z' },
  { id: 'claim:causal', kind: 'claim', availableAt: '2026-08-04T00:00:00.000Z' },
  { id: 'decision:budget', kind: 'decision', availableAt: '2026-08-05T00:00:00.000Z' },
  { id: 'claim:billed:v2', kind: 'claim', availableAt: '2026-08-06T00:00:00.000Z', supersedes: ['claim:billed'] },
];

const edges: DagEdgeInput[] = [
  { from: 'evidence:invoice', to: 'claim:billed', relation: 'supports' },
  { from: 'assumption:coverage', to: 'claim:billed', relation: 'assumes' },
  { from: 'measurement:cost', to: 'claim:billed', relation: 'measures' },
  { from: 'evidence:experiment', to: 'claim:causal', relation: 'supports' },
  { from: 'claim:billed', to: 'decision:budget', relation: 'derives' },
  { from: 'claim:causal', to: 'decision:budget', relation: 'derives' },
];

test('immutable DAG exposes ancestors, descendants, assumptions, measurements, and conflict paths', () => {
  const dag = createEpistemicDag(nodes, edges);
  assert.deepEqual(ancestors(dag, 'decision:budget'), [
    'assumption:coverage', 'claim:billed', 'claim:causal', 'evidence:experiment',
    'evidence:invoice', 'measurement:cost',
  ]);
  assert.deepEqual(descendants(dag, 'evidence:invoice'), ['claim:billed', 'decision:budget']);
  assert.deepEqual(assumptionDependencies(dag, 'claim:billed'), ['assumption:coverage']);
  assert.deepEqual(measurementDependencies(dag, 'claim:billed'), ['measurement:cost']);
  assert.deepEqual(conflictPaths(dag, 'decision:budget'), [['evidence:experiment', 'claim:causal', 'decision:budget']]);
  assert.equal(Object.isFrozen(dag), true);
  assert.equal(Object.isFrozen(dag.nodes), true);
  assert.equal(Object.isFrozen(dag.edges), true);
});

test('as-of graph excludes evidence and descendants unavailable at the requested decision time', () => {
  const dag = createEpistemicDag(nodes, edges);
  const historical = asOfGraph(dag, '2026-08-02T12:00:00.000Z');
  assert.deepEqual(historical.nodes.map((node) => node.id), ['assumption:coverage', 'evidence:invoice', 'measurement:cost']);
  assert.deepEqual(historical.edges, []);
  assert.deepEqual(asOfGraph(dag, '2026-08-05T12:00:00.000Z').nodes.map((node) => node.id), [
    'assumption:coverage', 'claim:billed', 'claim:causal', 'decision:budget', 'evidence:experiment',
    'evidence:invoice', 'measurement:cost',
  ]);
});

test('revocation projection is additive, transitive, and explains each descendant without revoking siblings', () => {
  const dag = createEpistemicDag(nodes, edges);
  const projection = projectRevocation(dag, ['evidence:invoice']);
  assert.deepEqual(projection.revokedIds, ['claim:billed', 'decision:budget', 'evidence:invoice']);
  assert.deepEqual(projection.trace, [
    { nodeId: 'claim:billed', causedBy: 'evidence:invoice', path: ['evidence:invoice', 'claim:billed'] },
    { nodeId: 'decision:budget', causedBy: 'evidence:invoice', path: ['evidence:invoice', 'claim:billed', 'decision:budget'] },
    { nodeId: 'evidence:invoice', causedBy: 'evidence:invoice', path: ['evidence:invoice'] },
  ]);
  assert.equal(projection.revokedIds.includes('claim:causal'), false);
  assert.equal(projection.revokedIds.includes('evidence:experiment'), false);
});

test('supporting sets and minimal cut sets are deterministic, and read edges as prerequisites', () => {
  // The determinism this test was written for is unchanged: same graph, same
  // order, every time. The VALUES changed at D-098. They used to read the two
  // roots as alternatives — supporting sets `[['e1'],['e2']]`, cut sets
  // `[['e1','e2']]` — while `projectRevocation` cut `c` on `e1` alone. Two
  // readings of one edge relation, and the module header names the one the graph
  // means: a dependency edge points from a PREREQUISITE to its dependent.
  // `test/epistemic-support-cut-agreement.test.ts` states that agreement as
  // properties over the closure the product actually consults.
  const dag = createEpistemicDag([
    { id: 'e1', kind: 'evidence', availableAt: '2026-08-01T00:00:00.000Z' },
    { id: 'e2', kind: 'evidence', availableAt: '2026-08-01T00:00:00.000Z' },
    { id: 'c', kind: 'claim', availableAt: '2026-08-01T00:00:00.000Z' },
  ], [
    { from: 'e1', to: 'c', relation: 'supports' },
    { from: 'e2', to: 'c', relation: 'supports' },
  ]);
  assert.deepEqual(minimalSupportingSets(dag, 'c'), [['e1', 'e2']]);
  assert.deepEqual(minimalCutSets(dag, 'c'), [['e1'], ['e2']]);
});

test('supersession is a lifecycle link, not a dependency that revocation can erase', () => {
  const dag = createEpistemicDag(nodes, edges);
  assert.deepEqual(supersededBy(dag, 'claim:billed'), ['claim:billed:v2']);
  const projection = projectRevocation(dag, ['claim:billed']);
  assert.equal(projection.revokedIds.includes('claim:billed:v2'), false);
});

test('DAG rejects duplicate/missing/self edges, cycles, duplicate nodes, and malformed timestamps', () => {
  assert.throws(() => createEpistemicDag(nodes, [...edges, edges[0]!]), /duplicate dependency edge/);
  assert.throws(() => createEpistemicDag(nodes, [{ from: 'missing', to: 'claim:billed', relation: 'supports' }]), /unknown node/);
  assert.throws(() => createEpistemicDag(nodes, [{ from: 'claim:billed', to: 'claim:billed', relation: 'supports' }]), /self dependency/);
  assert.throws(() => createEpistemicDag([
    { id: 'a', kind: 'claim', availableAt: '2026-08-01T00:00:00.000Z' },
    { id: 'b', kind: 'claim', availableAt: '2026-08-01T00:00:00.000Z' },
  ], [
    { from: 'a', to: 'b', relation: 'derives' },
    { from: 'b', to: 'a', relation: 'derives' },
  ]), /cycle/);
  assert.throws(() => createEpistemicDag([
    nodes[0]!, nodes[0]!,
  ], []), /duplicate node/);
  assert.throws(() => createEpistemicDag([
    { id: 'bad', kind: 'evidence', availableAt: '2026-08-01T00:00:00Z' },
  ], []), /canonical UTC ISO-8601/);
});

test('append operations return new snapshots and leave the prior graph unchanged', () => {
  const empty = createEpistemicDag([], []);
  const one = appendDagNode(empty, { id: 'e', kind: 'evidence', availableAt: '2026-08-01T00:00:00.000Z' });
  const two = appendDagNode(one, { id: 'c', kind: 'claim', availableAt: '2026-08-01T00:00:00.000Z' });
  const linked = appendDagEdge(two, { from: 'e', to: 'c', relation: 'supports' });
  assert.deepEqual(empty.nodes, []);
  assert.deepEqual(one.nodes.map((node) => node.id), ['e']);
  assert.deepEqual(two.edges, []);
  assert.deepEqual(linked.edges, [{ from: 'e', to: 'c', relation: 'supports' }]);
});
