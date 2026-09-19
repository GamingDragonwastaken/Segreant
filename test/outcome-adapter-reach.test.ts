/**
 * THE DOMAIN-NEUTRAL OUTCOME ADAPTER IS THE ONLY ROUTE FROM EVIDENCE TO A
 * TERMINAL OUTCOME ON BOTH PRODUCT PATHS (WP-D01, D-247).
 *
 * WP-D01 asked for one WorkUnit/OutcomeAdapter contract that coding and
 * non-coding work share. D-118 routed the coding funnel through it and D-129
 * bounded what an adapter may be durably: an allowlisted descriptor with a
 * digest, never executable code rehydrated from storage. What was left open
 * was reach — whether anything in the product still evaluates an outcome
 * beside the adapter. This gate reads the source: `adaptOutcome` is called
 * from exactly the two canonical adapters' modules and nowhere else, every
 * caller of the coding evaluator or the usage evaluator therefore inherits the
 * adapter's `adapterId` and `adapter:<id>` provenance, and the registry still
 * refuses an identity that was not allowlisted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CODING_OUTCOME_ADAPTER, evaluateCodingOutcome, GATE_LADDER } from '../src/value/gates.ts';
import { NON_CODING_OUTCOME_ADAPTER } from '../src/value/usage.ts';
import { createOutcomeAdapterRegistry } from '../src/outcomes/registry.ts';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

function sourceFiles(dir = join(ROOT, 'src')): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('adaptOutcome is called only from the two canonical adapter modules; no product path evaluates an outcome beside them', () => {
  const callers = sourceFiles()
    .filter((file) => /\badaptOutcome\(/.test(readFileSync(file, 'utf8')))
    .map((file) => relative(ROOT, file).replaceAll('\\', '/'))
    .sort();
  assert.deepEqual(callers, ['src/outcomes/work-unit.ts', 'src/value/gates.ts', 'src/value/usage.ts']);
  assert.notEqual(CODING_OUTCOME_ADAPTER.id, NON_CODING_OUTCOME_ADAPTER.id);
});

test('a coding evaluation carries the adapter identity it was judged by', () => {
  const verdicts = Object.fromEntries(
    GATE_LADDER.map((gate) => [gate, { gate, polarity: 'unknown', verdict: 'unknown', detail: 'no evidence' }]),
  ) as Parameters<typeof evaluateCodingOutcome>[0];
  const outcome = evaluateCodingOutcome(verdicts);
  assert.equal(outcome.status, 'unresolved');
  assert.equal(outcome.adapterId, CODING_OUTCOME_ADAPTER.id);
  assert.equal(outcome.contractId, CODING_OUTCOME_ADAPTER.contract.id);
});

test('the durable registry refuses an adapter identity that was not allowlisted', () => {
  const registry = createOutcomeAdapterRegistry([CODING_OUTCOME_ADAPTER.id]);
  registry.register(CODING_OUTCOME_ADAPTER);
  assert.throws(() => registry.register(NON_CODING_OUTCOME_ADAPTER), /not allowlisted/);
  assert.equal(registry.get(NON_CODING_OUTCOME_ADAPTER.id), undefined);
});
