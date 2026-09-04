import { createHash } from 'node:crypto';
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

export interface FiscusPackSignatureVerification {
  readonly status: 'absent' | 'metadata_only';
  readonly cryptographicVerification: 'not_performed';
  readonly keyId: string | null;
  readonly signedDigest: string | null;
}

export interface FiscusPackVerificationResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly manifestDigest: string | null;
  readonly canonical: 'verified' | 'not_verified';
  readonly signature: FiscusPackSignatureVerification;
  readonly limits: FiscusPackLimits;
}

export interface VerifyFiscusPackOptions {
  readonly limits?: FiscusPackLimitsOverride;
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

function signatureResult(signature: FiscusPackSignatureMetadata | undefined): FiscusPackSignatureVerification {
  return signature === undefined
    ? { status: 'absent', cryptographicVerification: 'not_performed', keyId: null, signedDigest: null }
    : { status: 'metadata_only', cryptographicVerification: 'not_performed', keyId: signature.keyId, signedDigest: signature.signedDigest };
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
    return {
      ok: false,
      errors: limitErrors,
      manifestDigest: null,
      canonical: 'not_verified',
      signature: { status: 'absent', cryptographicVerification: 'not_performed', keyId: null, signedDigest: null },
      limits,
    };
  }

  const parsed = parseInput(input, limits);
  if (parsed.errors.length > 0) {
    return {
      ok: false,
      errors: parsed.errors,
      manifestDigest: null,
      canonical: 'not_verified',
      signature: { status: 'absent', cryptographicVerification: 'not_performed', keyId: null, signedDigest: null },
      limits,
    };
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

  const signature = isRecord(value) && isRecord(value.manifest) && isRecord(value.manifest.signature)
    ? signatureResult(value.manifest.signature as unknown as FiscusPackSignatureMetadata)
    : { status: 'absent' as const, cryptographicVerification: 'not_performed' as const, keyId: null, signedDigest: null };
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
  return {
    ok: errors.length === 0,
    errors,
    manifestDigest: computedDigest,
    canonical: errors.length === 0 ? 'verified' : 'not_verified',
    signature,
    limits,
  };
}

export { isSafeRelativeAttachmentPath, serializeFiscusPack, manifestDigest };
