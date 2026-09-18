/**
 * The decision adapter's claims must sit within the evidence they cite (D-221).
 *
 * Found by the first product consumer, not by reasoning: the budget advisor
 * binds its daily spend series as `integrity: 'unknown'` evidence -- the same
 * `unknown` the metered claim carries, because nothing digests the request
 * ledger -- and `issueDecisionToKernel` threw
 *
 *   claim claim:decision:utility:… declares integrity verified, above the
 *   unknown of the weakest evidence it cites
 *
 * from inside the ledger's own bound. Every earlier test bound `verified`
 * evidence, so the adapter's hard-coded `integrity: 'verified'`,
 * `authenticity: 'self_asserted'` and `coverage: 'complete'` on BOTH claims had
 * never met evidence weaker than themselves. The ledger was right to refuse.
 * What was wrong is that `buildDecisionKernelIssuance` -- the PREVIEW half --
 * built records the COMMIT half could not persist, which breaks
 * preview-then-commit at the one boundary that persists a decision.
 *
 * The fix is the ledger's rule applied where the records are built: each of
 * the three evidence-bounded axes on the adapter's claims is the WEAKEST across
 * every cited evidence, the adapter's own included. Nothing is raised; a
 * `verified` source still yields `verified` claims, which the guard-rail test
 * pins so the fix cannot be a blanket downgrade.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { certifyDecision } from '../src/decision/engine.ts';
import { EpistemicLedger } from '../src/epistemic/ledger.ts';
import { buildDecisionKernelIssuance, issueDecisionToKernel } from '../src/decision/epistemic.ts';
import type { Evidence } from '../src/epistemic/evidence.ts';
import { grain } from '../src/epistemic/grain.ts';
import { scope } from '../src/epistemic/scope.ts';

const issuedAt = '2026-09-03T12:00:00.000Z';
const dominant = [
  { action: 'keep', low: 12, high: 18 },
  { action: 'route', low: 2, high: 10 },
] as const;

function source(overrides: Partial<Pick<Evidence, 'integrity' | 'authenticity'>> & { coverage?: Evidence['completeness']['status'] } = {}): Evidence {
  const time = { from: '2026-09-01T00:00:00.000Z', to: '2026-09-03T00:00:00.000Z' };
  return {
    id: 'evidence:decision:source', evidenceType: 'decision.utility.input', sourceIdentity: 'test', sourceClass: 'test', payload: { id: 'source' },
    scope: scope({ ledger: 'test', decision: 'decision-1' }), grain: grain(['decision']),
    occurredAt: time.from, validTime: time, observedAt: issuedAt, recordedAt: issuedAt, assertedAt: issuedAt, finalizedAt: null,
    integrity: overrides.integrity ?? 'verified',
    authenticity: overrides.authenticity ?? 'self_asserted',
    completeness: { status: overrides.coverage ?? 'complete', method: 'test', coveredEventTypes: [], coveredScope: null, coveredTime: null },
    measurementModelRef: null, monetaryBasis: null, assumptions: [], supersedes: [], supersededBy: null, revocation: null,
    schemaVersion: 1, sensitivity: 'internal', redaction: 'none',
  };
}

function ledger(): EpistemicLedger { return new EpistemicLedger(new DatabaseSync(':memory:')); }

test('a claim built over unknown-integrity evidence declares unknown integrity, and the commit accepts what the preview built', () => {
  const input = {
    decisionId: 'decision-1', certificate: certifyDecision(dominant), intervals: dominant,
    evidence: [{ id: 'evidence:decision:source', record: source({ integrity: 'unknown', coverage: 'partial' }) }], issuedAt,
  } as const;
  const preview = buildDecisionKernelIssuance(input);
  assert.equal(preview.observation.profile.integrity, 'unknown');
  assert.equal(preview.observation.profile.coverage, 'partial');
  assert.equal(preview.decision?.profile.integrity, 'unknown');
  assert.equal(preview.decision?.profile.coverage, 'partial');
  // The axis this adapter exists to issue is untouched by the ceiling.
  assert.equal(preview.decision?.profile.decisionFitness, 'sufficient');
  const committed = issueDecisionToKernel(ledger(), input);
  assert.deepEqual(committed.observation.profile, preview.observation.profile);
});

test('the weakest cited evidence sets each axis independently; nothing is averaged and nothing is raised', () => {
  const input = {
    decisionId: 'decision-1', certificate: certifyDecision(dominant), intervals: dominant,
    evidence: [{ id: 'evidence:decision:source', record: source({ authenticity: 'unknown' }) }], issuedAt,
  } as const;
  const preview = buildDecisionKernelIssuance(input);
  assert.equal(preview.observation.profile.authenticity, 'unknown');
  assert.equal(preview.observation.profile.integrity, 'verified', 'integrity was not lowered by an authenticity gap');
  assert.equal(preview.observation.profile.coverage, 'complete');
  issueDecisionToKernel(ledger(), input);
});

test('guard rail: verified, complete, self-asserted evidence still yields exactly the profile it always did', () => {
  const preview = buildDecisionKernelIssuance({
    decisionId: 'decision-1', certificate: certifyDecision(dominant), intervals: dominant,
    evidence: [{ id: 'evidence:decision:source', record: source() }], issuedAt,
  });
  assert.equal(preview.observation.profile.integrity, 'verified');
  assert.equal(preview.observation.profile.authenticity, 'self_asserted');
  assert.equal(preview.observation.profile.coverage, 'complete');
  assert.equal(preview.decision?.profile.integrity, 'verified');
});
