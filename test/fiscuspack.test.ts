import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createFiscusPackEnvelope,
  createFiscusPackManifest,
  isSafeRelativeAttachmentPath,
  manifestDigest,
  serializeFiscusPack,
  type FiscusPackManifestInput,
} from '../src/pack/manifest.ts';
import { verifyFiscusPack } from '../src/pack/verifier.ts';

function fixture(overrides: Partial<FiscusPackManifestInput> = {}): FiscusPackManifestInput {
  return {
    packId: 'pack:fixture-1',
    createdAt: '2026-09-04T00:00:00.000Z',
    includedRecords: [
      { kind: 'evidence', id: 'evidence:one', digest: 'sha256:' + 'a'.repeat(64) },
      { kind: 'claim', id: 'claim:one', digest: 'sha256:' + 'b'.repeat(64) },
    ],
    omissions: [],
    redactions: [],
    externalReferences: [],
    attachments: [],
    ...overrides,
  };
}

function envelope(overrides: Partial<FiscusPackManifestInput> = {}) {
  return createFiscusPackEnvelope(createFiscusPackManifest(fixture(overrides)));
}

test('builds a versioned manifest and verifies its canonical content digest', () => {
  const pack = envelope();
  assert.equal(pack.schema, 'fiscuspack');
  assert.equal(pack.version, 1);
  assert.equal(pack.manifest.schema, 'fiscuspack.manifest');
  assert.equal(pack.manifest.version, 1);
  assert.deepEqual(pack.manifest.includedRecords.map((record) => [record.kind, record.id, record.digest]), [
    ['evidence', 'evidence:one', 'sha256:' + 'a'.repeat(64)],
    ['claim', 'claim:one', 'sha256:' + 'b'.repeat(64)],
  ]);
  assert.match(pack.manifestDigest, /^sha256:[a-f0-9]{64}$/);

  const serialized = serializeFiscusPack(pack);
  assert.equal(verifyFiscusPack(serialized).ok, true);
  assert.equal(verifyFiscusPack(pack).manifestDigest, pack.manifestDigest);

  const reordered = createFiscusPackManifest({
    attachments: [],
    externalReferences: [],
    redactions: [],
    omissions: [],
    includedRecords: fixture().includedRecords,
    createdAt: fixture().createdAt,
    packId: fixture().packId,
  });
  assert.equal(manifestDigest(reordered), manifestDigest(pack.manifest));
});

test('manifest records omissions, redactions, external references, and non-truth-bearing signature metadata', () => {
  const unsigned = createFiscusPackManifest(fixture({
    omissions: [{ kind: 'transcript', count: 4, ids: [], reason: 'operator excluded raw prompts' }],
    redactions: [{ kind: 'evidence', ids: ['evidence:one'], fields: ['payload.secret'], reason: 'credential minimization' }],
    externalReferences: [{
      id: 'ref:provider-report',
      kind: 'provider.billing.export',
      digest: 'sha256:' + 'c'.repeat(64),
      uri: 'https://example.invalid/provider/report.json',
    }],
  }));
  const signedMetadata = {
    algorithm: 'ed25519',
    keyId: 'key:operator-1',
    signature: 'opaque-signature-metadata',
    signedDigest: manifestDigest(unsigned),
  };
  const signed = createFiscusPackEnvelope(createFiscusPackManifest(fixture({
    omissions: unsigned.omissions,
    redactions: unsigned.redactions,
    externalReferences: unsigned.externalReferences,
    signature: signedMetadata,
  })));

  const result = verifyFiscusPack(signed);
  assert.equal(result.ok, true);
  assert.equal(result.signature.status, 'metadata_only');
  assert.equal(result.signature.cryptographicVerification, 'not_performed');
  assert.equal(result.signature.keyId, 'key:operator-1');
  assert.equal(result.signature.signedDigest, signed.manifestDigest);
  assert.equal(signed.manifest.includedRecords.length, 2);
  assert.equal(signed.manifest.omissions[0]!.count, 4);
  assert.equal(signed.manifest.redactions[0]!.fields[0], 'payload.secret');
  assert.equal(signed.manifest.externalReferences[0]!.uri, 'https://example.invalid/provider/report.json');
});

test('tampering with manifest content or its envelope digest fails closed', () => {
  const pack = envelope();
  const alteredManifest = structuredClone(pack) as unknown as {
    manifest: { includedRecords: Array<{ kind: string; id: string; digest: string }> };
    manifestDigest: string;
  };
  const originalRecord = alteredManifest.manifest.includedRecords[0]!;
  alteredManifest.manifest.includedRecords[0] = {
    kind: originalRecord.kind,
    id: 'evidence:altered',
    digest: originalRecord.digest,
  };
  const alteredResult = verifyFiscusPack(alteredManifest);
  assert.equal(alteredResult.ok, false);
  assert.match(alteredResult.errors.join('\n'), /manifest digest/i);

  const alteredDigest = structuredClone(pack) as unknown as { manifestDigest: string };
  alteredDigest.manifestDigest = 'sha256:' + '0'.repeat(64);
  const digestResult = verifyFiscusPack(alteredDigest);
  assert.equal(digestResult.ok, false);
  assert.match(digestResult.errors.join('\n'), /digest/i);
});

test('resource limits bound raw parsing and manifest collections', () => {
  const oversized = verifyFiscusPack('x'.repeat(129), { limits: { maxEnvelopeBytes: 128 } });
  assert.equal(oversized.ok, false);
  assert.match(oversized.errors.join('\n'), /envelope.*limit/i);

  const tooManyRecords = verifyFiscusPack(envelope(), { limits: { maxIncludedRecords: 1 } });
  assert.equal(tooManyRecords.ok, false);
  assert.match(tooManyRecords.errors.join('\n'), /included record/i);

  const tooDeep = verifyFiscusPack(envelope({
    redactions: [{ kind: 'evidence', ids: ['evidence:one'], fields: ['payload'], reason: 'x' }],
  }), { limits: { maxCanonicalDepth: 2 } });
  assert.equal(tooDeep.ok, false);
  assert.match(tooDeep.errors.join('\n'), /depth/i);
});

test('attachment paths are relative and traversal-safe without filesystem access', () => {
  for (const safe of ['evidence/one.json', 'nested/.metadata', 'a-file_1.txt']) {
    assert.equal(isSafeRelativeAttachmentPath(safe), true, safe);
  }
  for (const unsafe of ['../secret.txt', '/absolute.txt', 'C:\\secret.txt', 'nested\\file.txt', 'a/./b', 'a/../b', 'C:relative']) {
    assert.equal(isSafeRelativeAttachmentPath(unsafe), false, unsafe);
  }

  const pack = envelope({
    attachments: [{
      path: 'evidence/one.json',
      mediaType: 'application/json',
      sizeBytes: 17,
      digest: 'sha256:' + 'd'.repeat(64),
    }],
  });
  assert.equal(verifyFiscusPack(pack).ok, true);

  const source = readFileSync(join(import.meta.dirname, '..', 'src', 'pack', 'verifier.ts'), 'utf8');
  assert.doesNotMatch(source, /\b(?:Store|producer)\b/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
});

test('unsupported versions, unknown envelope fields, invalid digests, and mismatched signatures are rejected', () => {
  const pack = envelope();
  const badVersion = { ...pack, version: 2 };
  const versionResult = verifyFiscusPack(badVersion);
  assert.equal(versionResult.ok, false);
  assert.match(versionResult.errors.join('\n'), /version/i);

  const extraField = { ...pack, unexpected: true };
  const extraResult = verifyFiscusPack(extraField);
  assert.equal(extraResult.ok, false);
  assert.match(extraResult.errors.join('\n'), /unknown|unsupported/i);

  const invalidRecord = structuredClone(pack) as unknown as {
    manifest: { includedRecords: Array<{ kind: string; id: string; digest: string }> };
  };
  invalidRecord.manifest.includedRecords[0]!.digest = 'not-a-sha256';
  const invalidResult = verifyFiscusPack(invalidRecord);
  assert.equal(invalidResult.ok, false);
  assert.match(invalidResult.errors.join('\n'), /digest/i);

  const unsigned = createFiscusPackManifest(fixture());
  const mismatchedSignature = createFiscusPackEnvelope(createFiscusPackManifest(fixture({
    signature: {
      algorithm: 'ed25519',
      keyId: 'key:operator-1',
      signature: 'opaque-signature-metadata',
      signedDigest: 'sha256:' + 'f'.repeat(64),
    },
  })));
  assert.equal(manifestDigest(unsigned), mismatchedSignature.manifestDigest);
  const signatureResult = verifyFiscusPack(mismatchedSignature);
  assert.equal(signatureResult.ok, false);
  assert.match(signatureResult.errors.join('\n'), /signature.*digest|signed digest/i);
});