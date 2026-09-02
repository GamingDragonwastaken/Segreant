/**
 * The observational-to-causal boundary, checked against the kernel that is
 * supposed to govern it.
 *
 * `src/epistemic/issuance-map.ts` classified `causal.qualification` and
 * `causal.estimate` as `unmigrated_authority`: the largest claim strengthening
 * in the product decided outside the Trusted Epistemic Kernel. The modules
 * themselves are conservative and nothing they compute is false — the defect is
 * that the conclusion was bound to nothing. **Revoking the randomization
 * evidence changed no downstream record, because there was no downstream record
 * to change.** That is what these tests are about, and it is why they use a real
 * `EpistemicLedger` over a real database rather than asserting on the shape of
 * the records the adapter returns.
 *
 * The load-bearing assertion is the negative one: the SAME derivation, with its
 * `causal_identification` witness removed, must be refused by the ledger. If it
 * is accepted, the split into an observational claim and a randomized one is
 * decoration and this file is testing nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  buildCausalStudyKernelIssuance,
  causalClaimIsEarned,
} from '../src/causal/epistemic.ts';
import { estimateCausalStudy } from '../src/causal/estimate.ts';
import { EpistemicLedger } from '../src/epistemic/ledger.ts';
import { instant } from '../src/epistemic/time.ts';
import { ISSUANCE_MAP } from '../src/epistemic/issuance-map.ts';
import { completedData, repeatedCostQualityData } from './support/causalStudyFixture.ts';
import type { CausalStudyData } from '../src/causal/types.ts';

const ISSUED_AT_MS = 1_700_100_000_000;

function ledger(): EpistemicLedger {
  // The kernel creates its own tables. Running the full store schema here would
  // drag the causal-v2 migration guard into a test that has nothing to do with
  // it, and that guard is right to refuse an in-memory database with no backup.
  return new EpistemicLedger(new DatabaseSync(':memory:'));
}

/**
 * A study that actually earns a claim.
 *
 * Both pre-registered endpoints have to clear their joint-level bound, which
 * the four-unit fixture cannot do at any effect size — the interval is wider
 * than the outcome range. 500 units per arm with a 0.15 quality difference and
 * a 98-dollar cost difference clears both, and the numbers are checked below
 * rather than assumed, because a fixture that silently stopped being supported
 * would turn every assertion here into a vacuous one.
 */
function supportedStudy(): CausalStudyData {
  return repeatedCostQualityData(0.95, 0.8);
}

function persist(store: EpistemicLedger, issuance: ReturnType<typeof buildCausalStudyKernelIssuance>): void {
  store.appendEvidence(issuance.assignmentEvidence);
  store.appendEvidence(issuance.outcomeEvidence);
  store.appendClaim(issuance.armDifference);
  if (issuance.identification === null || issuance.effect === null || issuance.derivation === null) return;
  store.appendWitness(issuance.identification);
  store.appendClaim(issuance.effect);
  store.appendDerivation(issuance.derivation);
}

test('the fixture this file rests on really does earn a causal claim', () => {
  const estimate = estimateCausalStudy(supportedStudy());
  assert.equal(estimate.qualification.state, 'qualified', estimate.qualification.reasons.slice(0, 3).join('; '));
  assert.equal(estimate.lowerCostPassed, true);
  assert.equal(estimate.qualityNonInferiorityPassed, true);
  assert.equal(estimate.allowedClaim, 'comparative_cost_quality_supported');
  assert.equal(causalClaimIsEarned(estimate), true);
});

test('a supported causal effect is issued as a derivation from the observed arm difference', () => {
  const data = supportedStudy();
  const estimate = estimateCausalStudy(data);
  const issuance = buildCausalStudyKernelIssuance(data, estimate, ISSUED_AT_MS);

  // The split is the mechanism, so it is asserted directly: the measured
  // difference is observational, and only the derived claim is randomized.
  assert.equal(issuance.armDifference.profile.causality, 'observational');
  assert.equal(issuance.effect?.profile.causality, 'randomized');
  assert.equal(issuance.identification?.kind, 'causal_identification');
  assert.deepEqual(
    [...(issuance.identification?.evidenceIds ?? [])],
    [issuance.assignmentEvidence.id],
    'the identification witness must be grounded in the randomization record and nothing else',
  );

  // Nothing else may move. Any other strengthened axis would be a claim this
  // module has no witness for, smuggled in beside the one it does.
  const source = issuance.armDifference.profile as unknown as Record<string, unknown>;
  const output = issuance.effect!.profile as unknown as Record<string, unknown>;
  const differing = Object.keys(source).filter((key) => JSON.stringify(source[key]) !== JSON.stringify(output[key]));
  assert.deepEqual(differing, ['causality'], `only the causality axis may differ; got ${differing.join(', ')}`);

  const store = ledger();
  persist(store, issuance);
  assert.equal(store.readClaim(issuance.effect!.id)?.id, issuance.effect!.id, 'the kernel must hold the causal claim');
});

test('the kernel refuses the same derivation once its identification witness is removed', () => {
  // THE ASSERTION THE REST OF THE FILE RESTS ON. If this passes without the
  // witness, the observational/randomized split is decoration: the kernel would
  // be storing a causal conclusion with nothing binding it to the randomization,
  // which is the exact `unmigrated_authority` state this packet closes.
  const data = supportedStudy();
  const estimate = estimateCausalStudy(data);
  const issuance = buildCausalStudyKernelIssuance(data, estimate, ISSUED_AT_MS);

  const store = ledger();
  store.appendEvidence(issuance.assignmentEvidence);
  store.appendEvidence(issuance.outcomeEvidence);
  store.appendClaim(issuance.armDifference);
  store.appendClaim(issuance.effect!);

  assert.throws(
    () => store.appendDerivation({ ...issuance.derivation!, witnesses: [] }),
    /causal_identification/,
    'a derivation that strengthens observational into randomized must name the missing witness',
  );
});

test('an inconclusive study issues its measurement and no causal claim at all', () => {
  // The four-unit study is structurally VALID — the protocol, the assignment
  // chain and the outcomes all pass. It simply has not earned claim language.
  // The refusal has to be an absent record rather than a flag on a present one,
  // because a flag is something a consumer can fail to read.
  const data = completedData();
  const estimate = estimateCausalStudy(data);
  assert.equal(estimate.qualification.state, 'qualified');
  assert.equal(estimate.allowedClaim, 'not_established');

  const issuance = buildCausalStudyKernelIssuance(data, estimate, ISSUED_AT_MS);
  assert.equal(issuance.effect, null, 'no causal claim may exist for a study that earned no claim language');
  assert.equal(issuance.identification, null, 'no identification witness may be minted for it either');
  assert.equal(issuance.derivation, null);
  // The measurement is still issued. Withholding it would hide the observation
  // rather than the conclusion, which is a different and worse failure.
  assert.equal(issuance.armDifference.profile.causality, 'observational');

  const store = ledger();
  persist(store, issuance);
  assert.equal(store.readClaim(`claim:causal:effect:${data.protocol.studyId}`), null);
});

test('a study whose assignment evidence fails verification issues no causal claim', () => {
  // Tamper with one decision's allocation hash. `qualifyCausalStudy` rejects
  // the record, the study stops being qualified, and the causal half must
  // disappear — this is the path by which corrupted randomization stops being
  // able to license a causal reading.
  const data = supportedStudy();
  const tampered: CausalStudyData = {
    ...data,
    decisions: data.decisions.map((decision, index) => (
      index === 0 ? { ...decision, assignedArmId: decision.assignedArmId === 'candidate' ? 'control' : 'candidate' } : decision
    )),
  };
  const estimate = estimateCausalStudy(tampered);
  assert.notEqual(estimate.qualification.state, 'qualified', 'a tampered assignment must not qualify');

  const issuance = buildCausalStudyKernelIssuance(tampered, estimate, ISSUED_AT_MS);
  assert.equal(issuance.effect, null);
  assert.equal(issuance.identification, null);
  assert.equal(
    issuance.outcomeEvidence.completeness.status,
    'partial',
    'an unqualified study must not report complete outcome coverage',
  );
});

test('revoking the randomization evidence carries the causal claim with it', () => {
  // The whole point of the migration. Before it, revoking the assignment record
  // changed nothing downstream, because nothing downstream existed. Now the
  // derivation's dependency edges put the effect claim in the closure.
  //
  // Asked through `revocationProjectionAsOf`, which is the surface a consumer
  // actually has. Calling `revocationClosure` on the raw edges instead looks
  // more direct and is wrong: the kernel de-duplicates parallel edges before
  // computing a closure, and a claim that both lists an evidence ID and is the
  // output of a derivation naming the same one produces exactly such a pair.
  const data = supportedStudy();
  const estimate = estimateCausalStudy(data);
  const issuance = buildCausalStudyKernelIssuance(data, estimate, ISSUED_AT_MS);

  const store = ledger();
  persist(store, issuance);
  const before = store.revocationProjectionAsOf(instant(new Date(ISSUED_AT_MS + 1_000).toISOString()));
  assert.deepEqual([...before.revokedIds], [], 'nothing is revoked before the event');

  store.appendRevocation({
    eventId: 'revocation:causal:assignment:1',
    targetId: issuance.assignmentEvidence.id,
    recordedAt: instant(new Date(ISSUED_AT_MS + 2_000).toISOString()),
    reason: 'randomization material was found to be reused across blocks',
  });

  const after = store.revocationProjectionAsOf(instant(new Date(ISSUED_AT_MS + 3_000).toISOString()));
  const revoked = new Set(after.revokedIds);
  assert.ok(revoked.has(issuance.effect!.id), 'the causal claim must be revoked with the randomization it rests on');
  assert.ok(revoked.has(issuance.armDifference.id), 'so must the observed difference, which is measured on the same units');
  assert.ok(revoked.has(issuance.identification!.id), 'and the witness, whose only grounding was that evidence');

  // The trace is what makes this auditable rather than merely correct: it has to
  // say WHICH revocation carried the causal claim away.
  const trace = after.trace.find((entry) => entry.nodeId === issuance.effect!.id);
  assert.equal(trace?.causedBy, issuance.assignmentEvidence.id);

  // And the independent half stays put: revoking the randomization does not
  // revoke the outcome records, which were observed regardless of how units
  // were assigned.
  assert.equal(revoked.has(issuance.outcomeEvidence.id), false);
});

test('the issuance map records the causal boundary as migrated', () => {
  // The map is the thing that says which paths may mint authority, so a
  // migration that does not reach it has not happened as far as the repository
  // is concerned. `test/issuance-map.test.ts` checks the map against the source;
  // this checks that the entry exists and carries the class it earned.
  const byId = new Map(ISSUANCE_MAP.map((boundary) => [boundary.id, boundary]));
  const issuance = byId.get('causal.issuance');
  assert.ok(issuance, 'the causal issuance adapter must appear on the map');
  assert.equal(issuance.issuanceClass, 'canonical');
  assert.equal(issuance.module, 'src/causal/epistemic.ts');

  for (const id of ['causal.qualification', 'causal.estimate']) {
    const boundary = byId.get(id);
    assert.ok(boundary, `${id} must remain on the map`);
    assert.notEqual(
      boundary.issuanceClass,
      'unmigrated_authority',
      `${id} decides inside the kernel now; leaving it labelled unmigrated hides a closed defect as an open one`,
    );
  }
});
