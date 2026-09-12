/**
 * A scoped rollup and a whole snapshot are the same bytes.
 *
 * THE COUNTEREXAMPLE, MEASURED. `fiscus team push --project api` filters the
 * breakdown to one project and mints a body over the remainder. Nothing in that
 * body says it was filtered. A body carrying every project on the machine and a
 * body carrying one of them differ only in how many rows the `projects` array
 * happens to hold — which is exactly what a snapshot of a one-project machine
 * looks like. The receiver cannot tell the two apart, and `aggregateProjects`
 * keeps only `latest_rollup_per_dev` and reads whichever it holds as that
 * developer's complete window.
 *
 * WHY THE CLIENT REFUSAL IS NOT THE FIX. D-101 stopped the scoped push in
 * `src/cli/teamCmd.ts`, and that refusal is currently the ONLY thing standing
 * between a scoped rollup and a team total that silently drops a developer's
 * other projects. Its own docblock says so: "Putting the coverage in the signed
 * body is the honest repair... Until it exists, the only sound position is that
 * a rollup no receiver can consume correctly must not be sent." A guard in one
 * reader is not a property of the payload: `--dry-run --project` still mints
 * and prints a scoped body today, a second client need not implement the
 * refusal, and a rollup that reaches a server by any other route arrives
 * indistinguishable from a whole snapshot.
 *
 * WHAT THIS FILE ASSERTS. Only that the claim travels: every newly built body
 * states what it covers, the statement defaults to the WEAKEST value rather
 * than the most confident one, and a scoped mint says which project it was
 * scoped to. It asserts nothing about whether the numbers inside are right —
 * that is the ledger check next door, and integrity is not truth.
 *
 * DELIBERATELY WRITTEN THROUGH PROPERTY ACCESS rather than through the new
 * named exports, so these assertions fail on their own merits against the
 * unfixed tree instead of taking the whole file down with a module link error.
 *
 * Recorded at D-199.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateKeyPair } from '../src/value/receipt.ts';
import { buildRollupBody, signRollup, validateRollupBody, verifyRollup } from '../src/team/rollup.ts';
import type { ProjectValue } from '../src/value/realization.ts';

const PERIOD = { from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T00:00:00.000Z' };

const keyDir = mkdtempSync(join(tmpdir(), 'fiscus-rollup-scope-'));
process.on('exit', () => rmSync(keyDir, { recursive: true, force: true }));

function keys() {
  return loadOrCreateKeyPair(join(keyDir, 'key.json'));
}

function project(name: string): ProjectValue {
  return {
    project: name,
    units: 10,
    costUsd: 100,
    realizationRate: 0.4,
    spendOnRealizedUnitsUsd: 40,
    acceptanceWeightedSpendUsd: 20,
    roiIndex: 1.2,
    sources: ['claude-code'],
  };
}

/** Read the wire field without importing the type, so an absent field reads as absent. */
function wireScope(body: unknown): { kind?: unknown; project?: unknown } | undefined {
  return (body as { scope?: { kind?: unknown; project?: unknown } }).scope;
}

test('every newly built body states what it covers', () => {
  const body = buildRollupBody(keys(), [project('api')], PERIOD);
  assert.equal(
    Object.prototype.hasOwnProperty.call(body, 'scope'),
    true,
    'a rollup that cannot say what it covers must not be mintable without saying so',
  );
});

test('the default scope is the weakest value the field can take, not the most confident', () => {
  // The lesson of D-181, one field over: `coverage` defaulted to `complete` and
  // both call sites omitted it, so an unwired default published the strongest
  // possible claim. A builder handed a list of projects and no scope cannot
  // know whether that list is the whole machine.
  const body = buildRollupBody(keys(), [project('api')], PERIOD);
  assert.equal(wireScope(body)?.kind, 'unknown');
});

test('a scoped mint is self-describing, so a receiver that checks nothing still cannot read it as a snapshot', () => {
  const body = buildRollupBody(keys(), [project('api')], PERIOD, undefined, 'complete', {
    scope: { kind: 'project', project: 'api' },
  } as never);
  assert.equal(wireScope(body)?.kind, 'project');
  assert.equal(wireScope(body)?.project, 'api');
});

test('a whole-snapshot mint and a scoped mint over the same projects are different bytes', () => {
  const pair = keys();
  const whole = buildRollupBody(pair, [project('api')], PERIOD, undefined, 'complete', {
    scope: { kind: 'all-projects' },
  } as never);
  const scoped = buildRollupBody(pair, [project('api')], PERIOD, undefined, 'complete', {
    scope: { kind: 'project', project: 'api' },
  } as never);
  assert.notDeepEqual(wireScope(whole), wireScope(scoped), 'the two claims must not canonicalize identically');
});

test('the scope claim survives signing and verification without being strengthened', () => {
  const pair = keys();
  const body = buildRollupBody(pair, [project('api')], PERIOD, undefined, 'complete', {
    scope: { kind: 'project', project: 'api' },
  } as never);
  const signed = signRollup(body, pair);
  const result = verifyRollup(signed) as unknown as { valid: boolean; scope?: { kind?: string } };
  assert.equal(result.valid, true);
  assert.equal(result.scope?.kind, 'project', 'a valid signature must not upgrade a scoped rollup to a snapshot');
});

test('a legacy body without a scope field verifies, and its absence is never read as a snapshot', () => {
  const pair = keys();
  const legacy = buildRollupBody(pair, [project('api')], PERIOD);
  delete (legacy as unknown as { scope?: unknown }).scope;
  const signed = signRollup(legacy, pair);
  const result = verifyRollup(signed) as unknown as { valid: boolean; scope?: { kind?: string } };
  assert.equal(result.valid, true, 'an older client\'s bytes must keep verifying');
  assert.equal(Object.prototype.hasOwnProperty.call(signed.body, 'scope'), false, 'verification must not mutate signed legacy bytes');
  assert.equal(result.scope?.kind, 'unknown', 'legacy absence is unknown, and unknown is never all-projects');
});

test('an unrecognized scope claim is refused by the shared validator', () => {
  const candidate = buildRollupBody(keys(), [project('api')], PERIOD);
  (candidate as unknown as { scope: unknown }).scope = { kind: 'everything' };
  assert.match(validateRollupBody(candidate) ?? '', /scope/);
});

test('a project scope without a project name is refused, because a scope that names nothing scopes nothing', () => {
  const candidate = buildRollupBody(keys(), [project('api')], PERIOD);
  (candidate as unknown as { scope: unknown }).scope = { kind: 'project' };
  assert.match(validateRollupBody(candidate) ?? '', /scope/);
});
