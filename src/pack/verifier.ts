import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import {
  DEFAULT_FISCUS_PACK_LIMITS,
  isSafeRelativeAttachmentPath,
  resolveFiscusPackLimits,
  validateFiscusPackEnvelope,
  validateFiscusPackLimits,
  validateFiscusPackManifest,
  type FiscusPackEnvelope,
  type FiscusPackLimits,
  type FiscusPackLimitsOverride,
  type FiscusPackSignatureMetadata,
} from './types.ts';
import { manifestDigest, serializeFiscusPack } from './manifest.ts';
import { asPublicKey, keyIdForPublicKey, type FiscusPackKeyInput } from './signature.ts';

export interface FiscusPackSignatureVerification {
  readonly status: 'absent' | 'metadata_only' | 'valid' | 'invalid';
  readonly cryptographicVerification: 'not_performed' | 'verified' | 'failed';
  readonly pinned: boolean;
  readonly keyId: string | null;
  readonly signedDigest: string | null;
}

export interface FiscusPackAttachmentVerification {
  readonly status: 'none' | 'partial' | 'complete';
  readonly declared: number;
  readonly present: number;
}

export interface FiscusPackVerificationResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly manifestDigest: string | null;
  readonly canonical: 'verified' | 'not_verified';
  readonly integrity: 'verified' | 'not_verified';
  readonly authenticity: 'verified' | 'not_established';
  readonly truth: 'not_evaluated';
  readonly signature: FiscusPackSignatureVerification;
  readonly attachments: FiscusPackAttachmentVerification;
  readonly limits: FiscusPackLimits;
}

export interface VerifyFiscusPackOptions {
  readonly limits?: FiscusPackLimitsOverride;
  /** An out-of-band trust anchor; embedded keys alone never establish authenticity. */
  readonly trustedPublicKey?: FiscusPackKeyInput;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function parseInput(input: unknown, limits: FiscusPackLimits): { value: unknown; errors: string[] } {
  if (typeof input === 'string') {
    if (byteLength(input) > limits.maxEnvelopeBytes) {
      return { value: null, errors: [`pack envelope exceeds resource limit (${limits.maxEnvelopeBytes} bytes)`] };
    }
    try {
      return { value: JSON.parse(input) as unknown, errors: [] };
    } catch {
      return { value: null, errors: ['pack envelope is invalid JSON'] };
    }
  }
  if (input instanceof Uint8Array) {
    if (input.byteLength > limits.maxEnvelopeBytes) {
      return { value: null, errors: [`pack envelope exceeds resource limit (${limits.maxEnvelopeBytes} bytes)`] };
    }
    try {
      return parseInput(new TextDecoder().decode(input), limits);
    } catch {
      return { value: null, errors: ['pack envelope is not valid UTF-8 JSON'] };
    }
  }
  return { value: input, errors: [] };
}

function canonicalJson(value: unknown, limits: FiscusPackLimits): string {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const visit = (current: unknown, path: string, depth: number): string => {
    if (depth > limits.maxCanonicalDepth) throw new Error(`${path} exceeds canonical depth limit`);
    nodes += 1;
    if (nodes > limits.maxCanonicalNodes) throw new Error(`${path} exceeds canonical node limit`);
    if (current === null) return 'null';
    if (typeof current === 'string') {
      if (byteLength(current) > limits.maxCanonicalStringBytes) throw new Error(`${path} exceeds canonical string limit`);
      return JSON.stringify(current);
    }
    if (typeof current === 'boolean') return current ? 'true' : 'false';
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new Error(`${path} contains a non-finite number`);
      return Object.is(current, -0) ? '0' : JSON.stringify(current);
    }
    if (typeof current !== 'object') throw new Error(`${path} contains a non-JSON value`);
    if (seen.has(current)) throw new Error(`${path} contains a cycle`);
    seen.add(current);
    let result: string;
    if (Array.isArray(current)) {
      const items: string[] = [];
      for (let index = 0; index < current.length; index += 1) items.push(visit(current[index], `${path}[${index}]`, depth + 1));
      result = `[${items.join(',')}]`;
    } else {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} is not a plain object`);
      const items: string[] = [];
      for (const key of Object.keys(current).sort((a, b) => a.localeCompare(b))) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error(`${path}.${key} is forbidden`);
        items.push(`${JSON.stringify(key)}:${visit((current as Record<string, unknown>)[key], `${path}.${key}`, depth + 1)}`);
      }
      result = `{${items.join(',')}}`;
    }
    seen.delete(current);
    if (byteLength(result) > limits.maxManifestBytes) throw new Error(`${path} exceeds canonical byte limit`);
    return result;
  };
  return visit(value, 'value', 0);
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function emptySignature(): FiscusPackSignatureVerification {
  return { status: 'absent', cryptographicVerification: 'not_performed', pinned: false, keyId: null, signedDigest: null };
}

function emptyAttachments(): FiscusPackAttachmentVerification {
  return { status: 'none', declared: 0, present: 0 };
}

function invalidResult(errors: string[], limits: FiscusPackLimits): FiscusPackVerificationResult {
  return {
    ok: false,
    errors,
    manifestDigest: null,
    canonical: 'not_verified',
    integrity: 'not_verified',
    authenticity: 'not_established',
    truth: 'not_evaluated',
    signature: emptySignature(),
    attachments: emptyAttachments(),
    limits,
  };
}

function decodeCanonicalBase64(value: string): Buffer | null {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? decoded : null;
}

function cryptographicSignature(
  signature: FiscusPackSignatureMetadata | undefined,
  signedDigest: string | null,
  trustedPublicKey: FiscusPackKeyInput | undefined,
  errors: string[],
): FiscusPackSignatureVerification {
  if (signature === undefined) return emptySignature();
  const metadataOnly: FiscusPackSignatureVerification = {
    status: 'metadata_only',
    cryptographicVerification: 'not_performed',
    pinned: false,
    keyId: signature.keyId,
    signedDigest: signature.signedDigest,
  };
  if (signature.publicKey === undefined || signedDigest === null) return metadataOnly;

  const publicKeyBytes = decodeCanonicalBase64(signature.publicKey);
  const signatureBytes = decodeCanonicalBase64(signature.signature);
  if (publicKeyBytes === null || signatureBytes === null) {
    errors.push('signature cryptographic material is not valid canonical base64');
    return { ...metadataOnly, status: 'invalid', cryptographicVerification: 'failed' };
  }

  let embeddedKey: KeyObject;
  try {
    embeddedKey = createPublicKey({ key: publicKeyBytes, format: 'der', type: 'spki' });
    if (embeddedKey.asymmetricKeyType !== 'ed25519') throw new Error('not an Ed25519 public key');
  } catch {
    errors.push('signature public key is not a valid Ed25519 SPKI key');
    return { ...metadataOnly, status: 'invalid', cryptographicVerification: 'failed' };
  }

  const embeddedKeyId = keyIdForPublicKey(embeddedKey);
  if (embeddedKeyId !== signature.keyId) {
    errors.push('signature key id does not match public key');
    return { ...metadataOnly, status: 'invalid', cryptographicVerification: 'failed' };
  }
  let valid = false;
  try {
    valid = cryptoVerify(null, Buffer.from(signature.signedDigest, 'utf8'), embeddedKey, signatureBytes);
  } catch {
    valid = false;
  }
  if (!valid) {
    errors.push('signature verification failed');
    return { ...metadataOnly, status: 'invalid', cryptographicVerification: 'failed' };
  }

  let pinned = false;
  if (trustedPublicKey !== undefined) {
    try {
      pinned = keyIdForPublicKey(asPublicKey(trustedPublicKey)) === embeddedKeyId;
    } catch {
      errors.push('trusted public key is invalid');
      return { ...metadataOnly, status: 'valid', cryptographicVerification: 'verified' };
    }
    if (!pinned) errors.push('signature public key is not trusted by supplied key');
  }
  return {
    status: 'valid',
    cryptographicVerification: 'verified',
    pinned,
    keyId: signature.keyId,
    signedDigest: signature.signedDigest,
  };
}

/**
 * Verify a pack envelope without persistence, generation, filesystem, or network calls.
 * A successful result means only that the bounded envelope is structurally
 * valid and its canonical manifest digest matches; it does not validate record
 * semantics, external references, signatures, truth, or completeness.
 */
export function verifyFiscusPack(input: unknown, options: VerifyFiscusPackOptions = {}): FiscusPackVerificationResult {
  const limits = resolveFiscusPackLimits(options.limits);
  const limitErrors = validateFiscusPackLimits(limits);
  if (limitErrors.length > 0) {
    return invalidResult(limitErrors, limits);
  }

  const parsed = parseInput(input, limits);
  if (parsed.errors.length > 0) {
    return invalidResult(parsed.errors, limits);
  }

  const errors = validateFiscusPackEnvelope(parsed.value, limits);
  const value = parsed.value;
  if (isRecord(value) && typeof value.manifestDigest === 'string' && isRecord(value.manifest)) {
    try {
      const encodedManifest = canonicalJson(value.manifest, limits);
      if (byteLength(encodedManifest) > limits.maxManifestBytes) errors.push(`manifest exceeds resource limit (${limits.maxManifestBytes} bytes)`);
      const actualDigest = digest(canonicalJson({
        schema: value.manifest.schema,
        version: value.manifest.version,
        packId: value.manifest.packId,
        createdAt: value.manifest.createdAt,
        includedRecords: value.manifest.includedRecords,
        omissions: value.manifest.omissions,
        redactions: value.manifest.redactions,
        externalReferences: value.manifest.externalReferences,
        attachments: value.manifest.attachments,
      }, limits));
      if (actualDigest !== value.manifestDigest) errors.push('manifest digest verification failed');
      if (value.manifest.signature !== undefined && isRecord(value.manifest.signature)
        && value.manifest.signature.signedDigest !== actualDigest) {
        errors.push('signature signed digest does not match manifest digest');
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const computedDigest = isRecord(value) && isRecord(value.manifest) && typeof value.manifestDigest === 'string'
    ? (() => {
        try {
          const encoded = canonicalJson({
            schema: value.manifest.schema,
            version: value.manifest.version,
            packId: value.manifest.packId,
            createdAt: value.manifest.createdAt,
            includedRecords: value.manifest.includedRecords,
            omissions: value.manifest.omissions,
            redactions: value.manifest.redactions,
            externalReferences: value.manifest.externalReferences,
            attachments: value.manifest.attachments,
          }, limits);
          return digest(encoded) === value.manifestDigest ? value.manifestDigest : null;
        } catch {
          return null;
        }
      })()
    : null;
  const signature = isRecord(value) && isRecord(value.manifest) && isRecord(value.manifest.signature)
    ? cryptographicSignature(
        value.manifest.signature as unknown as FiscusPackSignatureMetadata,
        computedDigest,
        options.trustedPublicKey,
        errors,
      )
    : emptySignature();
  const declaredAttachments = isRecord(value) && isRecord(value.manifest) && Array.isArray(value.manifest.attachments)
    ? value.manifest.attachments.length
    : 0;
  const presentAttachments = isRecord(value) && Array.isArray(value.attachments) ? value.attachments.length : 0;
  const attachments: FiscusPackAttachmentVerification = {
    status: declaredAttachments === 0 ? 'none' : presentAttachments === declaredAttachments ? 'complete' : 'partial',
    declared: declaredAttachments,
    present: presentAttachments,
  };
  const ok = errors.length === 0;
  return {
    ok,
    errors,
    manifestDigest: computedDigest,
    canonical: ok ? 'verified' : 'not_verified',
    integrity: ok ? 'verified' : 'not_verified',
    authenticity: signature.pinned && signature.cryptographicVerification === 'verified' ? 'verified' : 'not_established',
    truth: 'not_evaluated',
    signature,
    attachments,
    limits,
  };
}

export { isSafeRelativeAttachmentPath, serializeFiscusPack, manifestDigest };
