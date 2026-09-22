/**
 * The team server refuses a rollup the builder is happy to mint and sign.
 *
 * THE DISAGREEMENT, MEASURED. `validateRollupBody` refuses a project whose
 * `spendOnRealizedUnitsUsd` exceeds its `costUsd` — you cannot have spent more
 * on the realized subset than on the whole — and `team-server/src/server.ts`
 * calls it on every arriving rollup and answers HTTP 400. `buildRollupBody` and
 * `buildEconomicRollupBody` call it on nothing. So the sequence
 *
 *   buildRollupBody(keys, [violating], period)  ->  signRollup(...)  ->  POST
 *
 * mints a signed artifact carrying a contradiction, sends it across the network,
 * and learns it was malformed from a remote 400. The bad body is signed with the
 * developer's own key before anyone checks it.
 *
 * WHY AT MINTING AND NOT AT SENDING. The obvious repair is a check in the CLI's
 * push path just before `signRollup`. That leaves `buildRollupBody` still able
 * to return a body no receiver will accept, so every future caller re-inherits
 * the hole and the guard has to be remembered again at each new call site.
 * Refusing at construction means the malformed body never exists to be signed,
 * and — the part that matters for a signed protocol — no signature is ever
 * produced over a payload whose own containment fails. A signature is a
 * commitment; committing to a contradiction and retracting it on a 400 is worse
 * than never committing.
 *
 * WHAT THIS IS NOT. It is not a claim that the numbers are RIGHT. Containment is
 * an internal-consistency floor: a body that passes still rests on whatever the
 * local ledger measured, and `coverage` remains the signer's own non-
 * authoritative claim, combined conservatively by `combineRollupCoverage`. This
 * test says only that Fiscus stops signing statements it can already tell are
 * self-contradictory.
 *
 * NOT REACHABLE FROM THE CLI TODAY, STATED RATHER THAN IMPLIED. `fiscus team
 * push` builds its projects from `src/value/realization.ts`, which derives
 * `spendOnRealizedUnitsUsd` as a subset of `costUsd`, so no user input reaches
 * the violating state through that path. The guard is against an internal
 * inconsistency, which is exactly the failure a signature would otherwise
 * launder into an authenticated one. That is why it is asserted here at the
 * builder rather than through the CLI harness: a CLI test would have had to
 * fabricate the state it claims to catch.
 *
 * Recorded at D-162.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateKeyPair } from '../src/value/receipt.ts';
import {
  buildEconomicRollupBody,
  buildRollupBody,
  validateRollupBody,
  type EconomicProjectValue,
} from '../src/team/rollup.ts';
import type { ProjectValue } from '../src/value/realization.ts';

const PERIOD = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T00:00:00.000Z' };

const keyDir = mkdtempSync(join(tmpdir(), 'fiscus-rollup-mint-'));
process.on('exit', () => rmSync(keyDir, { recursive: true, force: true }));

function keys() {
  return loadOrCreateKeyPair(join(keyDir, 'key.json'));
}

function sound(): ProjectValue {
  return {
    project: 'api',
    units: 10,
    costUsd: 100,
    realizationRate: 0.4,
    spendOnRealizedUnitsUsd: 40,
    acceptanceWeightedSpendUsd: 20,
    roiIndex: 1.2,
    sources: ['claude-code'],
  };
}

/** Realized spend above total spend: the exact predicate the server answers 400 on. */
function violating(): ProjectValue {
  return { ...sound(), spendOnRealizedUnitsUsd: 140 };
}

function economic(project: ProjectValue): EconomicProjectValue {
  return {
    ...project,
    economic: { coverage: 'legacy_unknown', total: null, realized: null },
  } as EconomicProjectValue;
}

test('the server would refuse this body, which is the premise and not the defect', () => {
  // Separated deliberately: if this ever stops holding, the tests below are
  // asserting a rule the receiver no longer enforces.
  const body = { v: 1 as const, keyId: 'k', generatedAt: PERIOD.to, period: PERIOD, coverage: 'complete' as const, projects: [violating()] };
  assert.match(
    validateRollupBody(body) ?? '',
    /spendOnRealizedUnitsUsd must not exceed/,
    'the shared validator must reject realized spend above total spend',
  );
});

test('a v1 rollup body carrying a containment violation is never minted', () => {
  // THE COUNTEREXAMPLE. Before this, the builder returned the body happily and
  // the developer signed it.
  assert.throws(
    () => buildRollupBody(keys(), [violating()], PERIOD),
    /spendOnRealizedUnitsUsd must not exceed/,
  );
});

test('a v2 economic rollup body is held to the same floor', () => {
  // The v2 builder already canonicalises each project's economic attribution
  // and refuses an invalid one, but it checked nothing about the containment
  // the receiver enforces, so the same contradiction passed through it.
  assert.throws(
    () => buildEconomicRollupBody(keys(), [economic(violating())], PERIOD),
    /spendOnRealizedUnitsUsd must not exceed/,
  );
});

test('a violation anywhere in the list stops the whole body, not just that project', () => {
  // A rollup is one signed statement. Minting it without the offending project
  // would silently change what the developer is attesting to.
  assert.throws(
    () => buildRollupBody(keys(), [sound(), violating()], PERIOD),
    /projects\[1\]/,
  );
});

test('a sound rollup is minted exactly as before, so the floor costs the honest caller nothing', () => {
  // The half a refuse-everything guard would break. Both builders must still
  // produce the same shape, and it must still satisfy the receiver's check.
  const pair = keys();
  const v1 = buildRollupBody(pair, [sound()], PERIOD);
  assert.equal(v1.v, 1);
  assert.equal(v1.coverage, 'complete');
  assert.equal(v1.projects.length, 1);
  assert.equal(validateRollupBody(v1), null);

  const v2 = buildEconomicRollupBody(pair, [economic(sound())], PERIOD);
  assert.equal(v2.v, 2);
  assert.equal(validateRollupBody(v2), null);
});

test('an explicitly partial rollup is still minted, because partial is a claim and not a defect', () => {
  // Containment is about self-contradiction. A signer declaring incomplete
  // coverage is telling the truth about a limit, which must never be refused as
  // though it were a malformed body.
  const body = buildRollupBody(keys(), [sound()], PERIOD, undefined, 'partial');
  assert.equal(body.coverage, 'partial');
  assert.equal(validateRollupBody(body), null);
});
