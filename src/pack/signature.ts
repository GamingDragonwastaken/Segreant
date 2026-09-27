import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  type KeyObject,
} from 'node:crypto';
import { createSegreantPackEnvelope, createSegreantPackManifest } from './manifest.ts';
import type { SegreantPackEnvelope, SegreantPackSignatureMetadata } from './types.ts';

export type SegreantPackKeyInput = KeyObject | string | Uint8Array;

function isKeyObject(input: SegreantPackKeyInput): input is KeyObject {
  return typeof input === 'object'
    && input !== null
    && 'type' in input
    && 'asymmetricKeyType' in input;
}

function asPrivateKey(input: SegreantPackKeyInput): KeyObject {
  const key = isKeyObject(input)
    ? input
    : createPrivateKey(typeof input === 'string' ? input : Buffer.from(input));
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') throw new Error('Segreant pack signing requires an Ed25519 private key');
  return key;
}

export function asPublicKey(input: SegreantPackKeyInput): KeyObject {
  const key = isKeyObject(input)
    ? input
    : createPublicKey(typeof input === 'string' ? input : Buffer.from(input));
  const publicKey = key.type === 'private' ? createPublicKey(key) : key;
  if (publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Segreant pack verification requires an Ed25519 public key');
  return publicKey;
}

export function publicKeyBytes(input: SegreantPackKeyInput): Buffer {
  return asPublicKey(input).export({ type: 'spki', format: 'der' }) as Buffer;
}

/** Full SHA-256 fingerprint of the canonical SPKI public-key bytes. */
export function keyIdForPublicKey(input: SegreantPackKeyInput): string {
  return `sha256:${createHash('sha256').update(publicKeyBytes(input)).digest('hex')}`;
}

export function publicKeyBase64(input: SegreantPackKeyInput): string {
  return publicKeyBytes(input).toString('base64');
}

export function generateSegreantPackKeyPair(): {
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

function unsignedManifest(pack: SegreantPackEnvelope) {
  const {
    schema: _schema,
    version: _version,
    signature: _signature,
    ...input
  } = pack.manifest;
  return createSegreantPackManifest(input);
}

/**
 * Sign the canonical manifest digest with Ed25519. The public key is embedded
 * only so an independent verifier can establish byte integrity; authenticity is
 * reported only when the verifier also supplies an out-of-band trust anchor.
 */
export function signSegreantPack(pack: SegreantPackEnvelope, privateKeyInput: SegreantPackKeyInput): SegreantPackEnvelope {
  const privateKey = asPrivateKey(privateKeyInput);
  const manifest = unsignedManifest(pack);
  const unsigned = createSegreantPackEnvelope(manifest, pack.attachments ?? []);
  const signedDigest = unsigned.manifestDigest;
  const signature = cryptoSign(null, Buffer.from(signedDigest, 'utf8'), privateKey).toString('base64');
  const signatureMetadata: SegreantPackSignatureMetadata = {
    algorithm: 'ed25519',
    keyId: keyIdForPublicKey(privateKey),
    publicKey: publicKeyBase64(privateKey),
    signature,
    signedDigest,
  };
  const signedManifest = createSegreantPackManifest({ ...manifest, signature: signatureMetadata });
  return createSegreantPackEnvelope(signedManifest, pack.attachments ?? []);
}
