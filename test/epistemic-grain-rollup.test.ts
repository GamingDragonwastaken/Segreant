/**
 * The domain witness `grainRelation` says it needs, supplied (WP-R03).
 *
 * WHERE THIS PACKET GOT STUCK. `grainRelation` compares two grains by dimension
 * SET containment and returns `incomparable` when neither contains the other.
 * Its own comment says why that is not the end of the story: "Incomparable
 * grains cannot be ordered without a domain witness." No witness existed, so two
 * readings were tried at the claim-persistence boundary and each was wrong in
 * its own direction:
 *
 *   - REFUSE `incomparable`. Catches the real defect — a claim naming a
 *     dimension no cited evidence ever had — and also refuses the product's two
 *     honest roll-ups, `[billing_record]` → `[billing_period]` and
 *     `[provider_project_day_line_item]` → `[provider_project_period]`, which
 *     land on the identical verdict. Patched with an `explicitAggregate`
 *     exception naming those dimensions inline; it covered the billing pair and
 *     not the OpenAI Costs pair, and left the suite red.
 *   - ALLOW `incomparable`. Green, and honest about what it could not see, but
 *     it permits a claim at `[model]` on evidence at `[day]`: a dimension
 *     invented outright, which is the thing the packet exists to stop.
 *
 * Neither is a rule. The first is a list of exceptions and the second is a
 * declared blind spot, and both exist because the model carries no statement
 * about how dimensions relate. So this supplies the statement.
 *
 * WHAT A DECLARATION MEANS, AND WHY IT IS NOT THE EXCEPTION LIST AGAIN. The
 * exception tested WHO was calling — `derivationRule.startsWith('billing.')` —
 * which is a rule about a caller wearing the shape of a rule about evidence.
 * `DIMENSION_ROLLUPS` states a fact about the world instead: every
 * `billing_record` falls inside exactly one `billing_period`, so a figure
 * reported per period is an aggregation of records and never an invention. That
 * claim is either true or false of the domain, it is auditable as data, and any
 * caller aggregating those dimensions is covered by it — including callers that
 * do not exist yet.
 *
 * THE RELATION IS DIRECTED, AND THE GUARD-RAIL BELOW IS THE REASON. A
 * declaration that `billing_record` rolls up into `billing_period` must NOT
 * license the reverse: a claim per record, citing a period total, is exactly the
 * laundering this packet is named for. Recorded at D-108.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EpistemicLedger } from '../src/epistemic/ledger.ts';
import { evidence, type EvidenceInput } from '../src/epistemic/evidence.ts';
import { claim, type ClaimInput } from '../src/epistemic/claim.ts';
import { claimProfile } from '../src/epistemic/profile.ts';
import { grain, grainRollsUpInto, DIMENSION_ROLLUPS } from '../src/epistemic/grain.ts';
import { interval } from '../src/epistemic/time.ts';
import { scope } from '../src/epistemic/scope.ts';

function evidenceInput(id: string, dimensions: readonly string[]): EvidenceInput {
  return {
    id,
    evidenceType: 'provider.invoice',
    sourceIdentity: 'provider:openai:account-1',
    sourceClass: 'provider_statement',
    payload: { amount: '12.34' },
    scope: scope({ account: 'acct-1' }),
    grain: grain([...dimensions]),
    occurredAt: '2026-08-01T00:00:00.000Z',
    validTime: interval('2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z'),
    observedAt: '2026-08-02T03:00:00.000Z',
    recordedAt: '2026-08-02T03:00:01.000Z',
    integrity: 'verified',
    authenticity: 'provider_authenticated',
    completeness: { status: 'complete', method: 'provider_export' },
    measurementModelRef: 'measurement:provider-cost:v1',
    monetaryBasis: 'billed',
    assumptions: [],
    supersedes: [],
    supersededBy: null,
    revocation: null,
    schemaVersion: 1,
    sensitivity: 'internal',
    redaction: 'none',
  };
}

function claimInput(id: string, evidenceIds: readonly string[], dimensions: readonly string[]): ClaimInput {
  return {
    id,
    proposition: { predicate: 'cost.reconciled', value: { amount: '12.34', currency: 'USD' } },
    subject: 'project:api',
    scope: scope({ account: 'acct-1' }),
    grain: grain([...dimensions]),
    time: {
      validTime: interval('2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z'),
      asOf: '2026-08-02T03:00:02.000Z',
    },
    epistemic: 'supported',
    profile: claimProfile({
      epistemic: 'supported',
      integrity: 'verified',
      authenticity: 'provider_authenticated',
      scope: 'established',
      coverage: 'complete',
      measurement: 'validated',
      causality: 'observational',
      monetaryBasis: 'billed',
      finality: 'provisional',
      decisionFitness: 'sufficient',
    }),
    measurementModelRef: 'measurement:provider-cost:v1',
    evidenceIds: [...evidenceIds],
    // Deliberately not a `billing.` rule: the repair must not depend on who calls.
    derivationRule: 'anything.at.all.v1',
    derivationVersion: 1,
    assumptions: [],
    uncertainty: { kind: 'interval', lower: 12.34, upper: 12.34 },
    causalStatus: 'observational',
    issuedAt: '2026-08-02T03:00:02.000Z',
    supersedes: [],
    supersededBy: null,
    revocation: null,
    decisionCertificateIds: [],
    schemaVersion: 1,
  };
}

function ledger(): EpistemicLedger {
  return new EpistemicLedger(new DatabaseSync(':memory:'));
}

/** Accepted iff the ledger stores it; the persistence boundary is the one that matters. */
function accepts(claimGrain: readonly string[], evidenceGrain: readonly string[]): boolean {
  const kernel = ledger();
  kernel.appendEvidence(evidence(evidenceInput('evidence:1', evidenceGrain)));
  try {
    kernel.appendClaim(claim(claimInput('claim:1', ['evidence:1'], claimGrain)));
    return true;
  } catch {
    return false;
  }
}

test('the two roll-ups the product actually performs are both accepted', () => {
  // The OpenAI Costs pair is the one the inline exception missed, and it is why
  // the suite was red: `issueOpenAiCostsObservationToKernel` reports a period
  // total built from per-day line items.
  assert.equal(accepts(['billing_period'], ['billing_record']), true, 'billing roll-up');
  assert.equal(accepts(['provider_project_period'], ['provider_project_day_line_item']), true, 'OpenAI Costs roll-up');
});

test('an undeclared incomparable grain is still refused, which is the point of declaring', () => {
  // `[model]` against `[day]` is the invention the packet exists to stop, and
  // allowing `incomparable` wholesale was the price of the previous green.
  assert.equal(accepts(['model'], ['day']), false);
});

test('a roll-up declaration does NOT run backwards', () => {
  // THE GUARD-RAIL THAT MAKES THE DECLARATION SAFE. Reading the relation as
  // symmetric would license a per-record claim off a period total — one line of
  // code, and the exact laundering this packet is named for.
  assert.equal(accepts(['billing_record'], ['billing_period']), false);
  assert.equal(grainRollsUpInto('billing_record', 'billing_period'), true);
  assert.equal(grainRollsUpInto('billing_period', 'billing_record'), false);
});

test('one declared dimension does not carry an undeclared one beside it', () => {
  // A claim may aggregate `billing_record` into `billing_period` AND still be
  // inventing `model`. The rule is per dimension, not per claim.
  assert.equal(accepts(['billing_period', 'model'], ['billing_record']), false);
});

test('aggregating a dimension away entirely is still ordinary coarsening', () => {
  // `model` is dropped rather than invented, and `billing_period` is declared
  // over `billing_record`. Nothing here manufactures resolution.
  assert.equal(accepts(['billing_period'], ['billing_record', 'model']), true);
});

test('equal, coarser and finer verdicts are untouched by any of this', () => {
  // THE OTHER GUARD-RAIL. The declaration is additive: it must not change a
  // single verdict that plain set containment already answered.
  assert.equal(accepts(['day', 'project'], ['day', 'project']), true);
  assert.equal(accepts(['day'], ['day', 'project', 'request']), true);
  assert.equal(accepts(['day', 'project', 'request'], ['day']), false);
});

test('the declared relation is irreflexive and has no two-cycle', () => {
  // A dimension that rolled up into itself, or a pair that rolled up into each
  // other, would make the containment claim meaningless and would silently
  // re-open the reverse direction the guard-rail above closes. Asserted over the
  // table itself so a later entry cannot quietly break it.
  for (const [finer, coarser] of DIMENSION_ROLLUPS) {
    assert.notEqual(finer, coarser, `${finer} cannot roll up into itself`);
    assert.equal(grainRollsUpInto(finer, coarser), true);
    assert.equal(grainRollsUpInto(coarser, finer), false, `${coarser} must not roll up into ${finer}`);
  }
});
