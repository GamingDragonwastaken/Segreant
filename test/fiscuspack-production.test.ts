import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import {
  createFiscusPackEnvelope,
  createFiscusPackManifest,
  serializeFiscusPack,
  signFiscusPack,
  verifyFiscusPack,
  type FiscusPackAttachmentData,
  type FiscusPackManifestInput,
} from '../src/pack/index.ts';

function digestBytes(value: Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function manifestInput(attachment: FiscusPackAttachmentData): FiscusPackManifestInput {
  const bytes = Buffer.from(attachment.data, 'base64');
  return {
    packId: 'pack:production-fixture',
    createdAt: '2026-09-05T00:00:00.000Z',
    includedRecords: [
      { kind: 'claim', id: 'claim:fixture', digest: `sha256:${'a'.repeat(64)}` },
    ],
    omissions: [],
    redactions: [],
    externalReferences: [],
    attachments: [{
      path: attachment.path,
      mediaType: 'application/json',
      sizeBytes: bytes.byteLength,
      digest: digestBytes(bytes),
    }],
  };
}

function productionFixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const attachment: FiscusPackAttachmentData = {
    path: 'evidence/claim.json',
    data: Buffer.from('{"claim":"selected"}', 'utf8').toString('base64'),
  };
  const unsigned = createFiscusPackEnvelope(createFiscusPackManifest(manifestInput(attachment)), [attachment]);
  return { unsigned, signed: signFiscusPack(unsigned, privateKey), publicKey };
}

test('production signing verifies bytes but only a pinned key establishes authenticity', () => {
  const { signed, publicKey } = productionFixture();
  const encoded = serializeFiscusPack(signed);
  const unpinned = verifyFiscusPack(encoded);
  assert.equal(unpinned.ok, true);
  assert.equal(unpinned.integrity, 'verified');
  assert.equal(unpinned.signature.status, 'valid');
  assert.equal(unpinned.authenticity, 'not_established');
  assert.equal(unpinned.truth, 'not_evaluated');

  const pinned = verifyFiscusPack(encoded, { trustedPublicKey: publicKey });
  assert.equal(pinned.ok, true);
  assert.equal(pinned.signature.cryptographicVerification, 'verified');
  assert.equal(pinned.signature.pinned, true);
  assert.equal(pinned.authenticity, 'verified');
  assert.equal(pinned.truth, 'not_evaluated');
});

test('tampering with attachment bytes or signature fails closed', () => {
  const { signed } = productionFixture();
  const changedAttachment = structuredClone(signed) as any;
  changedAttachment.attachments[0].data = Buffer.from('{"claim":"tampered"}', 'utf8').toString('base64');
  const attachmentResult = verifyFiscusPack(changedAttachment);
  assert.equal(attachmentResult.ok, false);
  assert.match(attachmentResult.errors.join('\n'), /attachment.*digest|digest/i);

  const changedSignature = structuredClone(signed) as any;
  const signature = changedSignature.manifest.signature.signature as string;
  changedSignature.manifest.signature.signature = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
  const signatureResult = verifyFiscusPack(changedSignature);
  assert.equal(signatureResult.ok, false);
  assert.match(signatureResult.errors.join('\n'), /signature/i);
});

test('an explicit wrong trust anchor fails closed without establishing authenticity', () => {
  const { signed } = productionFixture();
  const { publicKey: wrongPublicKey } = generateKeyPairSync('ed25519');
  const result = verifyFiscusPack(signed, { trustedPublicKey: wrongPublicKey });
  assert.equal(result.ok, false);
  assert.equal(result.signature.cryptographicVerification, 'verified');
  assert.equal(result.signature.pinned, false);
  assert.equal(result.authenticity, 'not_established');
  assert.match(result.errors.join('\n'), /not trusted/i);
});

test('changing the embedded key identifier invalidates the cryptographic relationship', () => {
  const { signed } = productionFixture();
  const altered = structuredClone(signed) as any;
  altered.manifest.signature.keyId = `sha256:${'0'.repeat(64)}`;
  const result = verifyFiscusPack(altered);
  assert.equal(result.ok, false);
  assert.equal(result.signature.status, 'invalid');
  assert.match(result.errors.join('\n'), /key id/i);
});

test('metadata-only signatures never become authenticity and partial attachments stay explicit', () => {
  const attachment: FiscusPackAttachmentData = {
    path: 'evidence/claim.json',
    data: Buffer.from('{}', 'utf8').toString('base64'),
  };
  const unsignedManifest = createFiscusPackManifest(manifestInput(attachment));
  const metadataOnly = createFiscusPackEnvelope(createFiscusPackManifest({
    ...manifestInput(attachment),
    signature: {
      algorithm: 'ed25519',
      keyId: 'key:untrusted-metadata',
      signature: 'opaque-metadata',
      signedDigest: `sha256:${'0'.repeat(64)}`,
    },
  }));
  const result = verifyFiscusPack(metadataOnly);
  assert.equal(result.ok, false);
  assert.equal(result.authenticity, 'not_established');
  assert.match(result.errors.join('\n'), /signed digest/i);

  const unsignedPack = createFiscusPackEnvelope(unsignedManifest);
  const partial = verifyFiscusPack(unsignedPack);
  assert.equal(partial.ok, true);
  assert.equal(partial.authenticity, 'not_established');
  assert.equal(partial.attachments.status, 'partial');
});

test('attachment resources and traversal paths are bounded before decoding', () => {
  const attachment: FiscusPackAttachmentData = {
    path: '../outside.json',
    data: Buffer.from('x', 'utf8').toString('base64'),
  };
  assert.throws(
    () => createFiscusPackEnvelope(createFiscusPackManifest(manifestInput(attachment)), [attachment]),
    /safe relative attachment path/i,
  );

  const { signed } = productionFixture();
  const bounded = verifyFiscusPack(signed, { limits: { maxAttachmentBytes: 1 } });
  assert.equal(bounded.ok, false);
  assert.match(bounded.errors.join('\n'), /attachment.*limit|resource/i);
});
