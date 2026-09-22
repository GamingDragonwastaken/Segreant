/**
 * Support sets, cut sets and the revocation closure must be one answer (WP-R07).
 *
 * THE CONTRADICTION. `src/epistemic/dag.ts` contains two readings of the same
 * edge relation and they disagree about the same graph:
 *
 *   e1 --supports--> c
 *   e2 --supports--> c
 *
 *   minimalSupportingSets(c) -> [['e1'], ['e2']]   each root suffices alone
 *   minimalCutSets(c)        -> [['e1', 'e2']]     both must fall to cut it
 *   projectRevocation(['e1']) -> ['c', 'e1']       one is enough to cut it
 *
 * `minimalSupportingSets` builds one singleton set per dependency root, which
 * asserts that the roots are ALTERNATIVES. `revocationClosure` propagates
 * revocation along every dependency edge, which asserts that each root is a
 * PREREQUISITE. Both cannot be true of the same edge, and the module header
 * settles which one the graph means: "Dependency edges point from a prerequisite
 * to its dependent."
 *
 * WHICH DIRECTION IS DANGEROUS, which is why this is a soundness defect rather
 * than an inconsistency to be noted. The cut sets OVERSTATE how hard the claim
 * is to refute: they say an auditor must revoke both invoices to cut the billed
 * claim, when revoking either one already cuts it. A figure that overstates its
 * own robustness is the failure mode Fiscus exists to refuse, and "withhold
 * rather than inflate" decides the tie.
 *
 * WHAT THE GRAPH CANNOT SAY. There is no way in this model to express "either e1
 * or e2 suffices": `DAG_EDGE_RELATIONS` has no disjunction, and the docstring on
 * `minimalSupportingSets` admits the gap — "conjunction semantics can be added
 * by a future relation registry". So the disjunctive reading is not a supported
 * alternative interpretation, it is an assumption the data does not carry. When
 * a relation registry does add alternative support, both functions and the
 * closure change together, and these properties are what will hold them
 * together.
 *
 * THE PROPERTIES, STATED OVER THE CLOSURE THE PRODUCT ACTUALLY CONSULTS.
 * `Store.epistemic().revocationProjection()` is what the kernel-claim readers
 * use (D-094), so it is the authority here and the set functions are checked
 * against it rather than against each other.
 *
 *   1. A cut set cuts:      revoking all of S puts the target in the closure.
 *   2. A cut set is MINIMAL: no proper subset of S puts it there.
 *   3. A support set supports: revoking every root OUTSIDE one support set
 *      leaves the target unrevoked.
 *
 * Property 1 held before the change. Properties 2 and 3 are the ones the
 * disjunctive reading violated, and they are checked over four graph shapes —
 * two roots, a chain, a diamond and a mixed relation set — because the defect is
 * a property of the reading rather than of any one fixture.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEpistemicDag,
  minimalCutSets,
  minimalSupportingSets,
  projectRevocation,
  type DagEdgeInput,
  type DagNodeInput,
  type EpistemicDag,
} from '../src/epistemic/dag.ts';

const AT = '2026-08-01T00:00:00.000Z';

function graph(ids: readonly string[], edges: readonly [string, string, DagEdgeInput['relation']][]): EpistemicDag {
  const nodes: DagNodeInput[] = ids.map((id) => ({
    id,
    kind: id.startsWith('e') ? 'evidence' : 'claim',
    availableAt: AT,
  }));
  return createEpistemicDag(nodes, edges.map(([from, to, relation]) => ({ from, to, relation })));
}

/** Four shapes, so the properties are about the reading and not about one fixture. */
const SHAPES: { name: string; dag: EpistemicDag; target: string }[] = [
  {
    name: 'two independent roots',
    dag: graph(['e1', 'e2', 'c'], [['e1', 'c', 'supports'], ['e2', 'c', 'supports']]),
    target: 'c',
  },
  {
    name: 'a chain',
    dag: graph(['e1', 'c1', 'c2'], [['e1', 'c1', 'supports'], ['c1', 'c2', 'derives']]),
    target: 'c2',
  },
  {
    name: 'a diamond',
    dag: graph(['e1', 'c1', 'c2', 'c3'], [
      ['e1', 'c1', 'supports'], ['e1', 'c2', 'supports'],
      ['c1', 'c3', 'derives'], ['c2', 'c3', 'derives'],
    ]),
    target: 'c3',
  },
  {
    name: 'mixed dependency relations',
    dag: graph(['e1', 'e2', 'e3', 'c'], [
      ['e1', 'c', 'supports'], ['e2', 'c', 'assumes'], ['e3', 'c', 'measures'],
    ]),
    target: 'c',
  },
];

function revokes(dag: EpistemicDag, revoked: readonly string[], target: string): boolean {
  return projectRevocation(dag, [...revoked]).revokedIds.includes(target);
}

function properSubsets(set: readonly string[]): string[][] {
  const subsets: string[][] = [];
  for (const omitted of set) subsets.push(set.filter((id) => id !== omitted));
  return subsets;
}

test('every minimal cut set actually cuts the claim under the projected revocation', () => {
  // This one held before the change. It is here because a fix that made cut sets
  // smaller could satisfy minimality by producing sets that cut nothing.
  for (const { name, dag, target } of SHAPES) {
    const cuts = minimalCutSets(dag, target);
    assert.ok(cuts.length > 0, `${name}: a supported claim must have at least one cut set`);
    for (const cut of cuts) {
      assert.ok(revokes(dag, cut, target), `${name}: revoking ${cut.join('+')} does not cut ${target}`);
    }
  }
});

test('no proper subset of a minimal cut set cuts the claim', () => {
  // THE ASSERTION THE DISJUNCTIVE READING VIOLATED. `[['e1','e2']]` claims both
  // are needed; the closure cuts `c` on `e1` alone, so the set was not minimal
  // and the claim was published as harder to refute than it is.
  for (const { name, dag, target } of SHAPES) {
    for (const cut of minimalCutSets(dag, target)) {
      for (const subset of properSubsets(cut)) {
        assert.equal(
          revokes(dag, subset, target),
          false,
          `${name}: ${subset.join('+') || '(nothing)'} already cuts ${target}, so ${cut.join('+')} is not minimal`,
        );
      }
    }
  }
});

test('revoking everything outside one supporting set leaves the claim standing', () => {
  // What "supporting set" has to mean for the word to carry information: this
  // set, on its own, is enough. Under the closure it is not, whenever the roots
  // are prerequisites rather than alternatives.
  for (const { name, dag, target } of SHAPES) {
    const supports = minimalSupportingSets(dag, target);
    assert.ok(supports.length > 0, `${name}: a supported claim must have at least one supporting set`);
    const roots = [...new Set(supports.flat())];
    for (const support of supports) {
      const outside = roots.filter((id) => !support.includes(id));
      if (outside.length === 0) continue;
      assert.equal(
        revokes(dag, outside, target),
        false,
        `${name}: revoking ${outside.join('+')} cuts ${target}, so ${support.join('+')} is not sufficient support`,
      );
    }
  }
});

test('the two-root case reads the way the closure reads it', () => {
  // The concrete values, stated once, so the intended semantics is legible
  // without re-deriving it from the properties above.
  const { dag, target } = SHAPES[0]!;
  assert.deepEqual(minimalSupportingSets(dag, target), [['e1', 'e2']]);
  assert.deepEqual(minimalCutSets(dag, target), [['e1'], ['e2']]);
  assert.deepEqual(projectRevocation(dag, ['e1']).revokedIds, ['c', 'e1']);
});
