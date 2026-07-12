/**
 * The team-tier rollup (src/team/rollup.ts): a signed, numeric-only snapshot
 * of one developer's project-value breakdown, pushed to a BYO team server.
 * Mirrors value.test.ts's receipt tests (same two-tier integrity/authenticity
 * guarantee, same "recompute the fingerprint from the embedded key" discipline)
 * since verifyRollup is a parallel implementation of verifyReceipt's contract
 * for a different payload shape — pins that the two never drift apart.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateKeyPair, keyIdForPem } from '../src/value/receipt.ts';
import { buildRollupBody, signRollup, verifyRollup } from '../src/team/rollup.ts';
import type { ProjectValue } from '../src/value/realization.ts';

function projects(): ProjectValue[] {
  return [
    {
      project: 'fiscus',
      units: 12,
      costUsd: 41.5,
      realizationRate: 0.8,
      realizedValueUsd: 300,
      netRealizedValueUsd: 258.5,
      roiIndex: 3.2,
      sources: ['claude-code'],
    },
  ];
}

const period = { from: '2026-06-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' };

test('team-rollup: buildRollupBody stamps the signer\'s own keyId and carries period/projects through unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-rollup-build-'));
  try {
    const keys = loadOrCreateKeyPair(join(dir, 'key.json'));
    const body = buildRollupBody(keys, projects(), period);
    assert.equal(body.v, 1);
    assert.equal(body.keyId, keys.keyId);
    assert.deepEqual(body.period, period);
    assert.deepEqual(body.projects, projects());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('team-rollup: sign then verify is valid; tampering a project\'s numbers invalidates (body hash mismatch)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-rollup-tamper-'));
  try {
    const keys = loadOrCreateKeyPair(join(dir, 'key.json'));
    const body = buildRollupBody(keys, projects(), period);
    const signed = signRollup(body, keys);
    assert.equal(verifyRollup(signed).valid, true);

    // An intermediary (or the team server itself) inflating a cost/RoI figure
    // in transit must be caught — this is the whole point of signing numbers.
    const tampered = { ...signed, body: { ...signed.body, projects: [{ ...signed.body.projects[0]!, costUsd: 999_999 }] } };
    const result = verifyRollup(tampered);
    assert.equal(result.valid, false);
    assert.match(result.reason, /body hash mismatch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('team-rollup: key pinning rejects a forgery signed by an untrusted key (authenticity, not just integrity)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-rollup-pin-'));
  try {
    const honest = loadOrCreateKeyPair(join(dir, 'honest.json'));
    const attacker = loadOrCreateKeyPair(join(dir, 'attacker.json'));
    const body = buildRollupBody(honest, projects(), period);

    // A forged rollup: internally consistent, but signed by the attacker's own key.
    const forged = signRollup(body, attacker);
    assert.equal(verifyRollup(forged).valid, true, 'integrity-only verify cannot catch a self-consistent forgery');
    assert.equal(verifyRollup(forged).pinned, false);

    // A team server pinning to the registered developer's keyId rejects it.
    const checked = verifyRollup(forged, { trustedKeyId: honest.keyId });
    assert.equal(checked.valid, false);
    assert.match(checked.reason, /untrusted key/);

    // The genuine rollup is BOTH intact and authentic under the same pin.
    const genuine = verifyRollup(signRollup(body, honest), { trustedKeyId: honest.keyId });
    assert.equal(genuine.valid, true);
    assert.equal(genuine.pinned, true);

    // Pinning by full PEM works too.
    assert.equal(verifyRollup(signRollup(body, honest), { trustedPublicKeyPem: honest.publicPem }).pinned, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('team-rollup: claiming a trusted keyId while signing with another key is detected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-rollup-lie-'));
  try {
    const attacker = loadOrCreateKeyPair(join(dir, 'a.json'));
    const body = buildRollupBody(attacker, projects(), period);
    const r = signRollup(body, attacker);
    // Attacker keeps their own key + signature but stamps a victim developer's fingerprint in the keyId field.
    const lied = { ...r, keyId: 'deadbeefdeadbeef' };
    const res = verifyRollup(lied);
    assert.equal(res.valid, false);
    assert.match(res.reason, /keyId does not match/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('team-rollup: a garbled public key fails verification cleanly instead of throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-rollup-garbled-'));
  try {
    const keys = loadOrCreateKeyPair(join(dir, 'key.json'));
    const signed = signRollup(buildRollupBody(keys, projects(), period), keys);
    // Swap in a non-PEM public key. keyId is a hash of the PEM string (never
    // throws), so it's re-stamped to match — otherwise the earlier "keyId does
    // not match" check would short-circuit before createPublicKey() ever runs.
    const garbledPem = 'not a pem at all';
    const garbled = { ...signed, publicKey: garbledPem, keyId: keyIdForPem(garbledPem) };
    const result = verifyRollup(garbled);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'unreadable public key');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
