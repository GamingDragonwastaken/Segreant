/**
 * A claim may not be more verified than the evidence it cites (WP-R05).
 *
 * THE DEFECT. `appendDerivationWithinTransaction` consults
 * `assessDerivationLegality`, which refuses a derivation that strengthens a
 * claim on any profile axis without the matching witness — the comment above it
 * records that the assessment was correct, tested, and had no caller until the
 * ledger called it. `appendClaimWithinTransaction` checks that every cited
 * evidence id exists and is an evidence node, and then stores whatever profile
 * the claim declares.
 *
 * So the direct path is unguarded. Probed before diagnosis: one piece of
 * evidence with `integrity: unknown`, `authenticity: self_asserted`,
 * `completeness: unknown`, `sourceClass: user_report` — and a claim citing only
 * that, declaring `integrity: verified`, `authenticity: provider_authenticated`,
 * `finality: final`. Both appended, and the claim reads back exactly as
 * declared. Nothing verified anything, and the record says verified.
 *
 * THE CEILING IS THE WEAKEST CITED EVIDENCE, NOT THE STRONGEST. Every cited
 * evidence is a PREREQUISITE — that is what the dependency edge means, and
 * D-098 settled it for `minimalSupportingSets` after the same question was
 * answered two ways in one file. A claim that depends on a verified invoice and
 * an unverified note is only as verified as the note, because withdrawing the
 * note withdraws the claim. Taking the maximum would let one strong citation
 * launder an arbitrary number of weak ones.
 *
 * TWO AXES, AND DELIBERATELY NOT A THIRD. `integrity` and `authenticity` are
 * declared ladders in `profile.ts`, and `evidence.ts` imports the very same
 * constants, so "above" is defined and shared. `monetaryBasis` is NOT a ladder:
 * `mergeClaimProfiles` refuses to rank `billed` against `allocated` because they
 * are different economic semantics rather than two rungs of one quantity, and
 * `admissibility.ts` rejects an `atLeast` requirement on it at construction. A
 * claim whose basis differs from its evidence is often a legitimate derivation —
 * allocation is exactly that — and refusing it here would need the derivation
 * registry, not a comparison. Recorded at D-104.
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

type Integrity = 'unknown' | 'unverifiable' | 'verified';
type Authenticity = 'unknown' | 'self_asserted' | 'pinned' | 'provider_authenticated';

function evidenceInput(id: string, integrity: Integrity, authenticity: Authenticity, completeness: 'partial' | 'complete' = 'complete'): EvidenceInput {
  return {
    id,
    evidenceType: 'provider.invoice',
    sourceIdentity: 'provider:openai:account-1',
    sourceClass: 'provider_statement',
    payload: { amount: '12.34' },
    scope: scope({ account: 'acct-1' }),
    grain: grain(['day']),
    occurredAt: '2026-08-01T00:00:00.000Z',
    validTime: interval('2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z'),
    observedAt: '2026-08-02T03:00:00.000Z',
    recordedAt: '2026-08-02T03:00:01.000Z',
    integrity,
    authenticity,
    completeness: { status: completeness, method: 'provider_export' },
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

function claimInput(
  id: string,
  evidenceIds: readonly string[],
  integrity: Integrity,
  authenticity: Authenticity,
  coverage: 'partial' | 'complete' = 'complete',
): ClaimInput {
  return {
    id,
    proposition: { predicate: 'cost.reconciled', value: { amount: '12.34', currency: 'USD' } },
    subject: 'project:api',
    scope: scope({ account: 'acct-1' }),
    grain: grain(['day']),
    time: {
      validTime: interval('2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z'),
      asOf: '2026-08-02T03:00:02.000Z',
    },
    epistemic: 'supported',
    profile: claimProfile({
      epistemic: 'supported',
      integrity,
      authenticity,
      scope: 'established',
      coverage,
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

test('a claim cannot declare its integrity verified on evidence nobody verified', () => {
  const kernel = ledger();
  kernel.appendEvidence(evidence(evidenceInput('evidence:unverified:1', 'unknown', 'provider_authenticated')));
  assert.throws(
    () => kernel.appendClaim(claim(claimInput('claim:overreach:1', ['evidence:unverified:1'], 'verified', 'provider_authenticated'))),
    /integrity/,
  );
});

test('a claim cannot declare provider authentication on evidence that only asserted itself', () => {
  // The sibling axis. A rule written for one ladder and not the other would be
  // the shape this round has found six times.
  const kernel = ledger();
  kernel.appendEvidence(evidence(evidenceInput('evidence:selfsaid:1', 'verified', 'self_asserted')));
  assert.throws(
    () => kernel.appendClaim(claim(claimInput('claim:overreach:2', ['evidence:selfsaid:1'], 'verified', 'provider_authenticated'))),
    /authenticity/,
  );
});

test('a claim cannot declare complete coverage on evidence that only covers part of its scope', () => {
  const kernel = ledger();
  kernel.appendEvidence(evidence(evidenceInput('evidence:partial:1', 'verified', 'provider_authenticated', 'partial')));
  assert.throws(
    () => kernel.appendClaim(claim(claimInput('claim:overreach:coverage', ['evidence:partial:1'], 'verified', 'provider_authenticated', 'complete'))),
    /coverage/,
  );
});

test('the ceiling is the WEAKEST cited evidence, so one strong citation cannot launder a weak one', () => {
  // Every cited evidence is a prerequisite — the reading D-098 settled — so
  // withdrawing the weak one withdraws the claim. Taking the maximum would let a
  // single verified invoice carry any number of unverified notes.
  const kernel = ledger();
  kernel.appendEvidence(evidence(evidenceInput('evidence:strong:1', 'verified', 'provider_authenticated')));
  kernel.appendEvidence(evidence(evidenceInput('evidence:weak:1', 'unverifiable', 'pinned')));
  assert.throws(
    () => kernel.appendClaim(claim(claimInput('claim:mixed:1', ['evidence:strong:1', 'evidence:weak:1'], 'verified', 'provider_authenticated'))),
    /integrity/,
  );
  assert.equal(
    kernel.appendClaim(claim(claimInput('claim:mixed:2', ['evidence:strong:1', 'evidence:weak:1'], 'unverifiable', 'pinned'))),
    'inserted',
    'the weakest rung is admissible, and that is the point of a ceiling rather than a match',
  );
});

test('a claim at or below its evidence is stored unchanged', () => {
  // THE GUARD-RAIL. A rule that refused every claim, or demanded an exact
  // match, would satisfy the refusals above and make the kernel unusable: a
  // claim is allowed to be weaker than what supports it.
  const kernel = ledger();
  kernel.appendEvidence(evidence(evidenceInput('evidence:good:1', 'verified', 'provider_authenticated')));
  assert.equal(
    kernel.appendClaim(claim(claimInput('claim:equal:1', ['evidence:good:1'], 'verified', 'provider_authenticated'))),
    'inserted',
  );
  assert.equal(
    kernel.appendClaim(claim(claimInput('claim:weaker:1', ['evidence:good:1'], 'unknown', 'unknown'))),
    'inserted',
  );
  const stored = kernel.readClaim('claim:equal:1');
  assert.equal(stored?.profile.integrity, 'verified');
  assert.equal(stored?.profile.authenticity, 'provider_authenticated');
});

test('replaying an identical claim stays idempotent rather than failing the second time', () => {
  // The check runs on the append path, and the append path is also how a replay
  // arrives. A guard that threw on the duplicate would turn a retry into a
  // failure.
  const kernel = ledger();
  kernel.appendEvidence(evidence(evidenceInput('evidence:good:1', 'verified', 'provider_authenticated')));
  const item = claim(claimInput('claim:equal:1', ['evidence:good:1'], 'verified', 'provider_authenticated'));
  assert.equal(kernel.appendClaim(item), 'inserted');
  assert.equal(kernel.appendClaim(item), 'duplicate');
});
