import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto';
import { createFiscusPackEnvelope, createFiscusPackManifest } from './manifest.ts';
import type { FiscusPackEnvelope, FiscusPackSignatureMetadata } from './types.ts';

export type FiscusPackKeyInput = KeyObject | string | Uint8Array;

function isKeyObject(input: FiscusPackKeyInput): input is KeyObject {
  return typeof input === 'object'
    && input !== null
    && 'type' in input
    && 'asymmetricKeyType' in input;
}

function asPrivateKey(input: FiscusPackKeyInput): KeyObject {
  const key = isKeyObject(input)
    ? input
    : createPrivateKey(typeof input === 'string' ? input : Buffer.from(input));
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') throw new Error('Fiscus pack signing requires an Ed25519 private key');
  return key;
}

export function asPublicKey(input: FiscusPackKeyInput): KeyObject {
  const key = isKeyObject(input)
    ? input
    : createPublicKey(typeof input === 'string' ? input : Buffer.from(input));
  const publicKey = key.type === 'private' ? createPublicKey(key) : key;
  if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Fiscus pack verification requires an Ed25519 public key');
  return publicKey;
}

export function publicKeyBytes(input: FiscusPackKeyInput): Buffer {
  return asPublicKey(input).export({ type: 'spki', format: 'der' }) as Buffer;
}

/** Full SHA-256 fingerprint of the canonical SPKI public-key bytes. */
export function keyIdForPublicKey(input: FiscusPackKeyInput): string {
  return `sha256:${createHash('sha256').update(publicKeyBytes(input)).digest('hex')}`;
}

export function publicKeyBase64(input: FiscusPackKeyInput): string {
  return publicKeyBytes(input).toString('base64');
}

export function generateFiscusPackKeyPair(): {
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly keyId: string;
  readonly publicKeyBase64: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return Object.freeze({
    privateKey,
    publicKey,
    keyId: keyIdForPublicKey(publicKey),
    publicKeyBase64: publicKeyBase64(publicKey),
  });
}

function unsignedManifest(pack: FiscusPackEnvelope) {
  const {
    schema: _schema,
    version: _version,
    signature: _signature,
    ...input
  } = pack.manifest;
  return createFiscusPackManifest(input);
}

/**
 * Sign the canonical manifest digest with Ed25519. The public key is embedded
 * only so an independent verifier can establish byte integrity; authenticity is
 * reported only when the verifier also supplies an out-of-band trust anchor.
 */
export function signFiscusPack(pack: FiscusPackEnvelope, privateKeyInput: FiscusPackKeyInput): FiscusPackEnvelope {
  const privateKey = asPrivateKey(privateKeyInput);
  const manifest = unsignedManifest(pack);
  const unsigned = createFiscusPackEnvelope(manifest, pack.attachments ?? []);
  const signedDigest = unsigned.manifestDigest;
  const signature = cryptoSign(null, Buffer.from(signedDigest, 'utf8'), privateKey).toString('base64');
  const signatureMetadata: FiscusPackSignatureMetadata = {
    algorithm: 'ed25519',
    keyId: keyIdForPublicKey(privateKey),
    publicKey: publicKeyBase64(privateKey),
    signature,
    signedDigest,
  };
  const signedManifest = createFiscusPackManifest({ ...manifest, signature: signatureMetadata });
  return createFiscusPackEnvelope(signedManifest, pack.attachments ?? []);
}
