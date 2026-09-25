/**
 * `.segreantpack` has a producer: the epistemic ledger, through `segreant pack`.
 *
 * WP-G05 left "CLI/API integration" open with the module reachable from no
 * product path. `exportLedgerPack` (D-229) binds every ledger node by digest,
 * carries the payloads as one attachment, states omissions and redactions in
 * the manifest instead of dropping records, and signs on request; `segreant
 * pack export|verify|inspect` is the operator face.
 *
 * Checked here: a round trip through the in-tree verifier AND the standalone
 * verifier (`standalone/segreantpack-verifier.mjs`, no producer import); every
 * included reference digest matches the record as stored; confidential
 * evidence travels without its payload and the redaction names it; a byte
 * budget turns the tail of the ledger into a stated omission rather than a
 * truncated attachment; authenticity is `verified` only with the trust anchor.
 * Shown able to fail: with the digest prefix dropped the standalone verifier
 * rejected the manifest (4/4 red); with the redaction removed the confidential
 * payload assertion failed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { EpistemicLedger } from '../src/epistemic/ledger.ts';
import { evidence, type EvidenceInput } from '../src/epistemic/evidence.ts';
import { claim } from '../src/epistemic/claim.ts';
import { claimProfile } from '../src/epistemic/profile.ts';
import { grain } from '../src/epistemic/grain.ts';
import { scope } from '../src/epistemic/scope.ts';
import { canonicalJson } from '../src/epistemic/serialization.ts';
import { exportLedgerPack, LEDGER_PACK_RECORDS_PATH } from '../src/pack/export.ts';
import { generateSegreantPackKeyPair, serializeSegreantPack, verifySegreantPack } from '../src/pack/index.ts';

const T0 = '2026-08-01T00:00:00.000Z';
const T1 = '2026-08-02T00:00:00.000Z';
const SCOPE = scope({ account: 'acct-1' });
const GRAIN = grain(['day', 'project']);

function record(id: string, sensitivity: EvidenceInput['sensitivity'], value: string) {
  return evidence({
    id, evidenceType: 'ops.feed', sourceIdentity: 'segreant:local', sourceClass: 'segreant_local_records',
    payload: { value }, scope: SCOPE, grain: GRAIN, occurredAt: T0, observedAt: T0, finalizedAt: null,
    integrity: 'verified', authenticity: 'pinned', completeness: { status: 'complete', method: 'local_scan' },
    measurementModelRef: null, monetaryBasis: null, schemaVersion: 1, sensitivity, redaction: 'none',
  });
}

function ledgerWith(count: number): EpistemicLedger {
  const ledger = new EpistemicLedger(new DatabaseSync(':memory:'));
  for (let i = 0; i < count; i += 1) {
    ledger.appendEvidence(record(`evidence:${String(i).padStart(3, '0')}`, i === 1 ? 'confidential' : 'internal', `v${i}`));
  }
  ledger.appendClaim(claim({
    id: 'claim:count', proposition: { predicate: 'ops.count', value: { count } }, subject: 'project:api', scope: SCOPE, grain: GRAIN,
    time: { validTime: { from: T0, to: T1 }, asOf: T1 }, epistemic: 'supported',
    profile: claimProfile({ epistemic: 'supported', integrity: 'verified', authenticity: 'pinned', scope: 'conditional', coverage: 'complete', measurement: 'proxy_unvalidated', causality: 'none', monetaryBasis: 'none', finality: 'provisional', decisionFitness: 'not_assessed' }),
    measurementModelRef: null, evidenceIds: ['evidence:000'], derivationRule: 'ops.count.v1', derivationVersion: 1, causalStatus: 'none', issuedAt: T1, schemaVersion: 1,
  }));
  return ledger;
}

function decodeRecords(pack: ReturnType<typeof exportLedgerPack>['pack']): Array<{ kind: string; payload: Record<string, unknown> }> {
  const attachment = pack.attachments?.find((item) => item.path === LEDGER_PACK_RECORDS_PATH);
  assert.ok(attachment, 'the records attachment must travel in the envelope');
  return JSON.parse(Buffer.from(attachment.data, 'base64').toString('utf8'));
}

test('the exported pack verifies in-tree and with the standalone verifier, and every reference digest is the stored record', () => {
  const ledger = ledgerWith(3);
  const { pack, summary } = exportLedgerPack({ ledger, packId: 'pack:test', createdAt: T1 });
  assert.equal(summary.included, 4, 'three evidence nodes and one claim');
  assert.equal(summary.omitted, 0);

  const encoded = serializeSegreantPack(pack);
  const local = verifySegreantPack(encoded);
  assert.equal(local.ok, true, local.errors.join('; '));
  assert.equal(local.integrity, 'verified');
  assert.equal(local.authenticity, 'not_established');
  assert.equal(local.truth, 'not_evaluated');
  assert.equal(local.attachments.status, 'complete');

  const dir = mkdtempSync(join(tmpdir(), 'segreantpack-ledger-'));
  const file = join(dir, 'ledger.segreantpack.json');
  writeFileSync(file, encoded);
  const standalone = JSON.parse(execFileSync(process.execPath, [join(import.meta.dirname, '..', 'standalone', 'segreantpack-verifier.mjs'), file], { encoding: 'utf8' }));
  assert.equal(standalone.ok, true, JSON.stringify(standalone.errors));

  for (const reference of pack.manifest.includedRecords) {
    const stored = reference.kind === 'claim' ? ledger.readClaim(reference.id) : ledger.readEvidence(reference.id);
    assert.ok(stored, `${reference.id} must still be readable`);
    assert.equal(reference.digest, `sha256:${createHash('sha256').update(canonicalJson(stored), 'utf8').digest('hex')}`);
  }
});

test('confidential evidence travels without its payload and the manifest says so', () => {
  const { pack, summary } = exportLedgerPack({ ledger: ledgerWith(3), packId: 'pack:test', createdAt: T1 });
  assert.equal(summary.redacted, 1);
  assert.deepEqual(pack.manifest.redactions.map((r) => ({ kind: r.kind, ids: [...r.ids], fields: [...r.fields] })), [{ kind: 'evidence', ids: ['evidence:001'], fields: ['payload'] }]);
  const carried = decodeRecords(pack);
  const confidential = carried.find((entry) => entry.payload.id === 'evidence:001');
  assert.ok(confidential);
  assert.equal(confidential.payload.payload, null, 'the payload must not travel');
  assert.equal(confidential.payload.sensitivity, 'confidential', 'the class that caused the redaction still travels');
  const internal = carried.find((entry) => entry.payload.id === 'evidence:000');
  assert.deepEqual(internal?.payload.payload, { value: 'v0' });
});

test('a byte budget turns the tail of the ledger into a stated omission, and the pack still verifies', () => {
  const { pack, summary } = exportLedgerPack({ ledger: ledgerWith(6), packId: 'pack:test', createdAt: T1, attachmentByteBudget: 1_400 });
  assert.ok(summary.omitted > 0, 'the budget must bite for this test to say anything');
  assert.equal(summary.included + summary.omitted, 7);
  const omittedIds = pack.manifest.omissions.flatMap((o) => [...o.ids]);
  assert.equal(omittedIds.length, summary.omitted);
  for (const id of omittedIds) assert.ok(!pack.manifest.includedRecords.some((r) => r.id === id), `${id} is omitted and must not also be included`);
  assert.match(pack.manifest.omissions[0]!.reason, /byte budget/);
  assert.equal(verifySegreantPack(serializeSegreantPack(pack)).ok, true);
});

test('a signed pack is integrity-verified with the embedded key and authentic only with the trust anchor', () => {
  const keys = generateSegreantPackKeyPair();
  const { pack, summary } = exportLedgerPack({ ledger: ledgerWith(2), packId: 'pack:test', createdAt: T1, signingKey: keys.privateKey });
  assert.equal(summary.signed, true);
  const encoded = serializeSegreantPack(pack);
  const embeddedOnly = verifySegreantPack(encoded);
  assert.equal(embeddedOnly.ok, true);
  assert.equal(embeddedOnly.signature.status, 'valid');
  assert.equal(embeddedOnly.authenticity, 'not_established');
  const pinned = verifySegreantPack(encoded, { trustedPublicKey: keys.publicKey });
  assert.equal(pinned.authenticity, 'verified');
  const wrong = verifySegreantPack(encoded, { trustedPublicKey: generateSegreantPackKeyPair().publicKey });
  assert.equal(wrong.authenticity, 'not_established');
  assert.equal(wrong.ok, false);
});
