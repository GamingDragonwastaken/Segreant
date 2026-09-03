/**
 * A claim may not be finer-grained than the evidence it cites (WP-R03).
 *
 * THE DEFECT. `grainRelation` is a complete, tested answer to how two grains
 * compare — `equal`, `finer`, `coarser`, or an explicit `incomparable` when
 * neither dimension set contains the other. It has exactly one caller in `src/`:
 * `requiredCoordinateWitnesses` in `derivation.ts`, which demands a
 * `grain_refinement`, `grain_aggregation` or `grain_bridge` witness for a
 * derivation that changes grain. `appendClaimWithinTransaction` never asks.
 *
 * So the direct path launders granularity. Probed before diagnosis: one piece of
 * evidence at grain `[day]` — a daily provider total — and a claim citing only
 * that, stored at grain `[day, project, request]`. Per-request resolution
 * invented from a daily total, and the record carries it as observed. A claim at
 * the incomparable grain `[model]` was accepted too, which is worse in the same
 * direction: it names a dimension the evidence never had.
 *
 * THE SAME SHAPE AS D-104, ONE AXIS OVER. There the derivation path consulted
 * `assessDerivationLegality` and the direct path stored whatever profile a claim
 * declared; here the derivation path consults `grainRelation` and the direct
 * path stores whatever grain a claim declares. The kernel keeps proving it holds
 * the rule and that the persistence boundary does not ask for it.
 *
 * COARSENING IS NOT LAUNDERING, AND IS STILL PERMITTED. Aggregating a day's
 * per-request rows into a daily figure discards resolution rather than inventing
 * it, and it is what nearly every claim does to its evidence. Refusing every
 * grain change would make the kernel unusable.
 *
 * THE RULE IS NARROWER THAN THE OBVIOUS ONE, AND THE PRODUCT IS WHY. "Equal or
 * coarser than EVERY cited evidence" was implemented first and eleven tests
 * across four real issuance paths refuted it. Two reasons, both about
 * information the model does not carry:
 *
 *   - `[billing_record]` → `[billing_period]` and
 *     `[provider_project_day_line_item]` → `[provider_project_period]` are
 *     honest roll-ups that `grainRelation` calls `incomparable`, because a
 *     `Grain` is a flat dimension SET with no hierarchy: nothing declares that a
 *     record sits inside a period. So `incomparable` cannot be refused without
 *     refusing the honest case with it.
 *   - A decision-fitness claim at `[decision, action]` cites the interval
 *     evidence supplying the action detail AND caller evidence at `[decision]`
 *     supplying context. Citations carry no ROLES here, so "every citation must
 *     independently support the full resolution" describes a different graph.
 *
 * WHAT SURVIVES, AND IT IS THE OPPOSITE QUANTIFIER FROM D-104. A claim is
 * refused when some citation is strictly `finer` — positive evidence that the
 * claim added dimensions — and NO citation is `equal` or `coarser`, so nothing
 * cited supplies them. Trust takes the WEAKEST citation because weakness
 * propagates: withdrawing any cited evidence withdraws the claim. Resolution is
 * SUPPLIED rather than propagated, and citing a daily total beside a per-request
 * log does not erase the log's detail.
 *
 * AND THE CEILING HAS NO HOLE UNDER IT. D-104 recorded the evidence-free claim
 * as an unbounded case for its own ceiling. It is not: `claim()` refuses an
 * empty `evidenceIds` outright, so no such claim can be constructed, let alone
 * persisted. That limitation was overstated and the record is corrected here.
 * Recorded at D-106.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EpistemicLedger } from '../src/epistemic/ledger.ts';
import { evidence, type EvidenceInput } from '../src/epistemic/evidence.ts';
import { claim, type ClaimInput } from '../src/epistemic/claim.ts';
import { claimProfile } from '../src/epistemic/profile.ts';
import { grain } from '../src/epistemic/grain.ts';
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
    derivationRule: 'billing.reconcile.v1',
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

test('a claim cannot report per-request detail that its daily-total evidence never had', () => {
  const kernel = ledger();
  kernel.appendEvidence(evidence(evidenceInput('evidence:daily:1', ['day'])));
  assert.throws(
    () => kernel.appendClaim(claim(claimInput('claim:invented:1', ['evidence:daily:1'], ['day', 'project', 'request']))),
    /grain/,
  );
});

test('an incomparable grain is refused when no cited evidence supplies its dimensions', () => {
  // WHAT THIS RULE CANNOT SEE, ASSERTED SO IT CANNOT BE MISTAKEN FOR SAFETY.
  // `[model]` against `[day]` shares no dimension, and by the letter of the
  // model that is an invented axis. But `Grain` is a flat dimension SET with no
  // hierarchy, so `grainRelation` returns the identical `incomparable` verdict
  // for `[billing_record]` -> `[billing_period]`, an honest roll-up that real
  // issuance performs. Refusing `incomparable` broke eleven tests across four
  // product paths, and the first attempt to keep the refusal — a hardcoded
  // exception for `billing.` derivation rules naming those two dimensions —
  // covered neither the OpenAI Costs roll-up nor, as it turned out, the billing
  // path it was written for. A kernel rule that needs a list of product
  // exceptions to be true is not the rule; it is a description of the
  // exceptions.
  //
  // Product-specific rollups need their own explicit typed bridge.
  const kernel = ledger();
  kernel.appendEvidence(evidence(evidenceInput('evidence:daily:1', ['day'])));
  assert.throws(
    () => kernel.appendClaim(claim(claimInput('claim:bridged:1', ['evidence:daily:1'], ['model']))),
    /grain/,
  );
});

test('one citation that carries the dimensions is enough, even beside a coarser one', () => {
  // THE OPPOSITE QUANTIFIER FROM THE TRUST CEILING, AND DELIBERATELY SO. Trust
  // takes the WEAKEST citation because weakness propagates: withdrawing any
  // cited evidence withdraws the claim. Resolution is SUPPLIED rather than
  // propagated — citing a daily total beside a per-request log does not erase
  // the log's detail — so a claim at `[day, project]` is supported by the
  // per-request log whatever else it cites.
  //
  // The stricter reading was tried and a real path refuted it: a decision
  // fitness claim at `[decision, action]` cites the interval evidence that
  // supplies the action detail AND caller evidence at `[decision]` that supplies
  // context. Citations carry no roles in this graph, so "every citation must
  // independently support the full resolution" is a rule about a different one.
  const kernel = ledger();
  kernel.appendEvidence(evidence(evidenceInput('evidence:fine:1', ['day', 'project', 'request'])));
  kernel.appendEvidence(evidence(evidenceInput('evidence:daily:1', ['day'])));
  assert.equal(
    kernel.appendClaim(claim(claimInput('claim:mixed:1', ['evidence:fine:1', 'evidence:daily:1'], ['day', 'project']))),
    'inserted',
  );
});

test('refinement over one citation is still refused when NO citation carries the dimensions', () => {
  // The refusal that survives. Two coarse citations, neither containing the
  // claim's dimensions, and a claim that adds `project` and `request` to both:
  // nothing cited could have supplied them.
  const kernel = ledger();
  kernel.appendEvidence(evidence(evidenceInput('evidence:daily:1', ['day'])));
  kernel.appendEvidence(evidence(evidenceInput('evidence:daily:2', ['day'])));
  assert.throws(
    () => kernel.appendClaim(claim(claimInput('claim:invented:2', ['evidence:daily:1', 'evidence:daily:2'], ['day', 'project', 'request']))),
    /refines .* and no cited evidence carries those dimensions/,
  );
});

test('aggregating to a coarser grain is permitted, and so is reporting at the same one', () => {
  // THE GUARD-RAIL. Refusing every grain change would satisfy the tests above
  // and break the ordinary case: nearly every claim aggregates its evidence.
  const kernel = ledger();
  kernel.appendEvidence(evidence(evidenceInput('evidence:fine:1', ['day', 'project', 'request'])));
  assert.equal(
    kernel.appendClaim(claim(claimInput('claim:same:1', ['evidence:fine:1'], ['day', 'project', 'request']))),
    'inserted',
  );
  assert.equal(
    kernel.appendClaim(claim(claimInput('claim:rolled:1', ['evidence:fine:1'], ['day']))),
    'inserted',
  );
  assert.deepEqual(kernel.readClaim('claim:rolled:1')?.grain.dimensions, ['day']);
});

test('there is no evidence-free claim to launder with, because one cannot be built', () => {
  // WHY THE CEILING HAS NO HOLE UNDER IT. Both this rule and D-104's trust
  // ceiling compare a claim against its cited evidence, which invites the
  // question of what bounds a claim that cites none. The answer is that the
  // canonical constructor refuses to make one: `evidenceIds` must contain at
  // least one entry, checked in `claim()` before the ledger ever sees it. So
  // every claim reaching either ceiling has something to be measured against.
  //
  // This is asserted rather than assumed. D-104's record stated the
  // evidence-free case as an open gap; it is not one, and the record was
  // corrected rather than left standing.
  assert.throws(
    () => claim(claimInput('claim:unmoored:1', [], ['day', 'project', 'request'])),
    /evidenceIds must contain at least one entry/,
  );
});
