/**
 * The program's own state-of-the-world records drifted from the gated map they
 * describe, on the highest-priority audit item.
 *
 * WHAT DRIFTED. `docs/program/AUDIT-REGISTER.md` said of AII-036 that "three
 * boundaries are named unmigrated_authority", and its residual table named
 * them, two of which had not been that for two closures.
 * `docs/program/ACTIVE-EXECUTION.md` carried the same three as frontier item 4,
 * with an ordering argument built on two of them being reachable by the
 * product. In `src/epistemic/issuance-map.ts` the two causal boundaries became
 * `kernel_primitive` when `causal.issuance` was written — their own map notes
 * say so — leaving one boundary in that class, the one nothing reaches. The
 * frontier item that survived was an instruction to do work already done,
 * ordered by an argument that no longer held.
 *
 * WHY THAT HAPPENED, AND IT IS NOT CARELESSNESS. The map is a GATED artifact:
 * `test/issuance-map.test.ts` reads it against the source tree and walks the
 * import graph from the CLI entry point, so a boundary that changes class or
 * gains a consumer fails until the declaration is corrected. The prose was
 * gated by nothing. When one of a pair moves under a test and the other does
 * not, the ungated one is where the falsehood accumulates — and the ungated one
 * here is the document the next executor reads to decide what to do.
 *
 * WHY THIS IS A DECLARATION LINE AND NOT A SWEEP OVER THE PROSE. The first
 * version of this file swept for a boundary id within a window of the class
 * word, and it worked — it named all four real violations. It also failed on
 * the CORRECTED text, because a record that fixes a misclassification has to
 * say which boundaries moved and when, and "X was unmigrated_authority and is
 * now kernel_primitive" is a true sentence that reads identically to the false
 * one at a distance of four hundred characters. Teaching the sweep to parse
 * tense would be building a natural language parser to avoid drawing a line,
 * and loosening the window until the corrected text passed would have left it
 * unable to catch the original. So the fact is stated once per record, in a
 * fixed visible form, and THAT is what is checked. The prose around it is free
 * to explain the history, which is what prose is for.
 *
 * VISIBLE, NOT A HIDDEN MARKER. The line renders in the document a person
 * reads. A machine-readable comment invisible to the reader would let the
 * gated assertion and the human-visible account drift apart, which is the
 * defect this file exists to close wearing a different hat.
 *
 * WHAT THIS DOES NOT ESTABLISH. That the records are otherwise accurate. One
 * fact about one authority class is now checked in two files; every other
 * sentence in them is prose that nothing reads. In particular the register's
 * earlier "thirteen of fourteen are in the import closure" was stale too, and
 * the fix for that was to stop asserting a total rather than to add a second
 * gate — a number nobody states cannot go stale, and a test that checked every
 * number in prose would be brittle in proportion to how well it worked.
 *
 * Recorded at D-169.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ISSUANCE_MAP } from '../src/epistemic/issuance-map.ts';

const ROOT = join(import.meta.dirname, '..');

/** The two records that describe the current state rather than a past decision. */
const STATE_RECORDS = ['docs/program/AUDIT-REGISTER.md', 'docs/program/ACTIVE-EXECUTION.md'];

/**
 * The one sentence in each record that this test reads.
 *
 * Deliberately rigid. A declaration a writer can phrase three ways is a
 * declaration a writer can phrase in a way the test does not see, and a rule
 * that silently stops applying is worse than no rule.
 */
const DECLARATION = /Boundaries still classified `unmigrated_authority`: ((?:`[^`\n]+`(?:, )?)+|none)\./;

function record(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
}

/** The ids a record declares, read out of its one declaration line. */
function declaredIds(path: string): string[] {
  const match = DECLARATION.exec(record(path));
  assert.ok(match, `${path} must carry the issuance-class declaration line this test reads`);
  const body = match[1]!.trim();
  if (body === 'none') return [];
  return [...body.matchAll(/`([^`]+)`/g)].map((entry) => entry[1]!).sort();
}

function mappedUnmigratedIds(): string[] {
  return ISSUANCE_MAP.filter((boundary) => boundary.issuanceClass === 'unmigrated_authority')
    .map((boundary) => boundary.id)
    .sort();
}

test('each state-of-the-world record declares exactly the unmigrated boundaries the map does', () => {
  // THE COUNTEREXAMPLE. Both files named `causal.qualification` and
  // `causal.estimate` in this class while the map had them as
  // `kernel_primitive`, and the frontier ordered the next round's work on it.
  const expected = mappedUnmigratedIds();
  for (const path of STATE_RECORDS) {
    assert.deepEqual(
      declaredIds(path),
      expected,
      `${path} declares a different set of unmigrated-authority boundaries than src/epistemic/issuance-map.ts`,
    );
  }
});

test('the declaration is not vacuous: there is something to declare and the line is found', () => {
  // If every boundary were migrated the expected set would be empty, both
  // records could say `none`, and the test above would pass while checking that
  // two documents agree about nothing. It would also mean AII-036's issuance
  // half had closed, which is a thing to notice rather than to sail past.
  assert.ok(
    mappedUnmigratedIds().length > 0,
    'every issuance boundary is now migrated -- AII-036 has moved, and this test and the records it reads both need revisiting',
  );
  for (const path of STATE_RECORDS) {
    assert.match(record(path), DECLARATION, `${path} must state the declaration in the exact form this test reads`);
  }
});

test('every declared id is a boundary the map actually defines', () => {
  // A declaration naming a boundary that does not exist would satisfy nothing
  // and would read as authoritative. The set equality above catches a wrong
  // id only while the map's own set is non-empty and differs; this catches a
  // typo in either document on its own terms.
  const known = new Set(ISSUANCE_MAP.map((boundary) => boundary.id));
  for (const path of STATE_RECORDS) {
    for (const id of declaredIds(path)) {
      assert.ok(known.has(id), `${path} declares ${id}, which is not a boundary in the issuance map`);
    }
  }
});
