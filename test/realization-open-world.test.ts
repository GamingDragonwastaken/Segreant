import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GATE_LADDER,
  scoreFunnel,
  terminalRealizationBounds,
  type Gate,
  type GateResult,
  type Verdict,
} from '../src/value/gates.ts';

function verdicts(map: Partial<Record<Gate, Verdict>>): Record<Gate, GateResult> {
  const out = {} as Record<Gate, GateResult>;
  for (const gate of GATE_LADDER) {
    out[gate] = { gate, verdict: map[gate] ?? 'unknown', detail: '' };
  }
  return out;
}

test('legacy realization lower bound does not count unknown required gates as confirmed', () => {
  const outcome = scoreFunnel(verdicts({
    proposed: 'pass',
    accepted: 'pass',
    committed: 'pass',
    survived: 'pass',
    clean: 'pass',
  }));

  assert.equal(outcome.results.find((result) => result.gate === 'tested')?.verdict, 'unknown');
  assert.equal(outcome.results.find((result) => result.gate === 'merged')?.verdict, 'unknown');
  assert.equal(outcome.results.find((result) => result.gate === 'shipped')?.verdict, 'unknown');
  assert.equal(outcome.realized, false, 'unknown required gates are unresolved, not implicit pass');
  assert.deepEqual(terminalRealizationBounds([outcome]), { lower: 0, upper: 1, n: 1 });
});

test('legacy realization is confirmed only when every gate in its declared contract passes', () => {
  const allPass = Object.fromEntries(
    GATE_LADDER.map((gate) => [gate, 'pass' as const]),
  ) as Record<Gate, Verdict>;

  const outcome = scoreFunnel(verdicts(allPass));
  assert.equal(outcome.realized, true);
  assert.deepEqual(terminalRealizationBounds([outcome]), { lower: 1, upper: 1, n: 1 });
});
