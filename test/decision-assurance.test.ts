/**
 * WP-F05 — Decision Assurance Levels.
 *
 * The counterexample these tests encode was measured, not argued. `computeFrontier`
 * on 8/8 candidate vs 2/40 incumbent units returns
 * `confidence: 'observational_separation'` with no confounders; its per-unit saving
 * fed to `certifyDecision` returns `proven_dominant` for `switch_default_model`;
 * and `issueDecisionToKernel` persisted `claim:decision:fitness:switch-default-model`
 * with `decisionFitness: 'sufficient'` and `causality: 'none'` without refusing.
 * Models were never assigned. Nothing on that path asked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { certifyDecision, type ActionUtilityInterval } from '../src/decision/engine.ts';
import { buildDecisionKernelIssuance, issueDecisionToKernel } from '../src/decision/epistemic.ts';
import { EpistemicLedger } from '../src/epistemic/ledger.ts';
import { claimProfile, type ClaimProfile } from '../src/epistemic/profile.ts';
import { scope } from '../src/epistemic/scope.ts';
import { grain } from '../src/epistemic/grain.ts';
import type { Evidence } from '../src/epistemic/evidence.ts';

const issuedAt = '2026-09-07T12:00:00.000Z';
const validTime = { from: '2026-09-01T00:00:00.000Z', to: '2026-09-05T00:00:00.000Z' };

/** The action set from the measured counterexample: switching the default model changes spend. */
const spendChangingIntervals: readonly ActionUtilityInterval[] = [
  { action: 'switch_default_model', low: 2.7, high: 3.3 },
  { action: 'keep_incumbent_model', low: 0, high: 0 },
];

function sourceEvidence(id = 'evidence:frontier:observational-separation'): Evidence {
  return {
    id,
    evidenceType: 'value.model_switch_recommendation',
    sourceIdentity: 'fiscus:frontier',
    sourceClass: 'fiscus_local_observational_comparison',
    payload: { confidence: 'observational_separation' },
    scope: scope({ ledger: 'test', decision: 'switch-default-model' }),
    grain: grain(['decision']),
    occurredAt: validTime.from,
    validTime,
    observedAt: issuedAt,
    recordedAt: issuedAt,
    assertedAt: issuedAt,
    finalizedAt: null,
    integrity: 'verified',
    authenticity: 'self_asserted',
    completeness: { status: 'complete', method: 'observational_comparison', coveredEventTypes: [], coveredScope: null, coveredTime: null },
    measurementModelRef: null,
    monetaryBasis: null,
    assumptions: [],
    supersedes: [],
    supersededBy: null,
    revocation: null,
    schemaVersion: 1,
    sensitivity: 'internal',
    redaction: 'none',
  };
}

function ledger(): EpistemicLedger { return new EpistemicLedger(new DatabaseSync(':memory:')); }

/**
 * What `computeFrontier` actually produced: an anytime-valid separation on
 * observed usage, priced from each model's own attributed spend. Models were not
 * assigned, so `causality` is `observational` and the dollars are a local list-price
 * estimate, not what a provider billed.
 */
const observationalSeparationProfile: ClaimProfile = claimProfile({
  epistemic: 'supported',
  integrity: 'verified',
  authenticity: 'self_asserted',
  scope: 'conditional',
  coverage: 'complete',
  measurement: 'proxy_validated',
  causality: 'observational',
  monetaryBasis: 'estimated',
  finality: 'provisional',
  decisionFitness: 'not_assessed',
});

test('an observational separation is refused as the basis of a spend-changing decision', () => {
  const certificate = certifyDecision(spendChangingIntervals);
  assert.equal(certificate.status, 'proven_dominant');
  assert.equal(certificate.action, 'switch_default_model');

  assert.throws(
    () => issueDecisionToKernel(ledger(), {
      decisionId: 'switch-default-model',
      certificate,
      intervals: spendChangingIntervals,
      evidence: [{ id: 'evidence:frontier:observational-separation', record: sourceEvidence() }],
      issuedAt,
      assurance: {
        consequence: 'changes_spend',
        inputs: [{ id: 'claim:value:model_switch:feature', profile: observationalSeparationProfile }],
      },
    }),
    /assurance/i,
    'an observational separation must not become the evidence for changing what Fiscus spends',
  );
});

test('a spend-changing decision with no declared inputs is refused rather than defaulted', () => {
  const certificate = certifyDecision(spendChangingIntervals);
  assert.throws(
    () => buildDecisionKernelIssuance({
      decisionId: 'switch-default-model',
      certificate,
      intervals: spendChangingIntervals,
      evidence: [{ id: 'evidence:frontier:observational-separation', record: sourceEvidence() }],
      issuedAt,
      assurance: { consequence: 'changes_spend', inputs: [] },
    }),
    /assurance/i,
    'absence of a declared input is not a passing assurance level',
  );
});

// ---------------------------------------------------------------------------
// GUARD RAILS. A gate that refused everything would satisfy both tests above
// while making the surface useless, and would be its own epistemic failure:
// withholding a decision the evidence actually earned. These three pin
// properties rather than drive a repair, and they were green when written —
// which is the correct result for assertions whose job is to stop a later
// change from turning the gate into a blanket refusal.
// ---------------------------------------------------------------------------

/** Assigned, directly measured, completely covered, priced on observed money. */
const randomizedProfile: ClaimProfile = claimProfile({
  epistemic: 'supported',
  integrity: 'verified',
  authenticity: 'pinned',
  scope: 'established',
  coverage: 'complete',
  measurement: 'validated',
  causality: 'randomized',
  monetaryBasis: 'provider_observed',
  finality: 'provisional',
  decisionFitness: 'not_assessed',
});

test('a randomized, directly measured, completely covered input reaches DAL-3 and issues', () => {
  const certificate = certifyDecision(spendChangingIntervals);
  const result = issueDecisionToKernel(ledger(), {
    decisionId: 'switch-default-model',
    certificate,
    intervals: spendChangingIntervals,
    evidence: [{ id: 'evidence:frontier:observational-separation', record: sourceEvidence() }],
    issuedAt,
    assurance: {
      consequence: 'changes_spend',
      inputs: [{ id: 'claim:causal:model_switch:randomized', profile: randomizedProfile }],
    },
  });

  assert.notEqual(result.assurance, null);
  assert.equal(result.assurance?.assessment.level, 'DAL-3');
  assert.equal(result.assurance?.meetsRequirement, true);
  assert.equal(result.assurance?.refusal, null);
  // Meeting an evidence requirement is never permission to act, and the gate
  // says so in its own shape rather than in prose a caller can skip.
  assert.equal(result.assurance?.authorizesAction, false);
  assert.equal(result.decision?.id, 'claim:decision:fitness:switch-default-model');
});

test('an issuance that declares no consequence reports NOT ASSESSED, never assessed-and-fine', () => {
  const certificate = certifyDecision(spendChangingIntervals);
  const result = buildDecisionKernelIssuance({
    decisionId: 'switch-default-model',
    certificate,
    intervals: spendChangingIntervals,
    evidence: [{ id: 'evidence:frontier:observational-separation', record: sourceEvidence() }],
    issuedAt,
  });
  // The absence of a gate is visible on the result. It is not a pass, and this
  // is the honest reach of the packet: the discipline is available at this
  // boundary and is not imposed on a caller that declares nothing.
  assert.equal(result.assurance, null);
});

test('a claim cannot raise the level that governs it by asserting its own decision fitness', () => {
  const selfCertifying: ClaimProfile = claimProfile({
    ...observationalSeparationProfile,
    decisionFitness: 'sufficient',
  });
  const certificate = certifyDecision(spendChangingIntervals);
  assert.throws(
    () => buildDecisionKernelIssuance({
      decisionId: 'switch-default-model',
      certificate,
      intervals: spendChangingIntervals,
      evidence: [{ id: 'evidence:frontier:observational-separation', record: sourceEvidence() }],
      issuedAt,
      assurance: {
        consequence: 'changes_spend',
        inputs: [{ id: 'claim:value:model_switch:feature', profile: selfCertifying }],
      },
    }),
    /assurance/i,
    'decisionFitness is the axis being assessed and is excluded from the ladder',
  );
});
