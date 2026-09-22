import { createHash } from 'node:crypto';
import { canonicalPackJson } from './canonical.ts';
import {
  DEFAULT_FISCUS_PACK_LIMITS,
  FISCUS_PACK_MANIFEST_SCHEMA,
  FISCUS_PACK_MANIFEST_VERSION,
  FISCUS_PACK_SCHEMA,
  FISCUS_PACK_VERSION,
  manifestDigestMaterial,
  resolveFiscusPackLimits,
  validateFiscusPackEnvelope,
  validateFiscusPackLimits,
  validateFiscusPackManifest,
  type FiscusPackEnvelope,
  type FiscusPackAttachmentData,
  type FiscusPackLimitsOverride,
  type FiscusPackManifest,
  type FiscusPackManifestInput,
} from './types.ts';

export type { FiscusPackManifestInput } from './types.ts';
export { isSafeRelativeAttachmentPath } from './types.ts';

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function assertManifest(value: FiscusPackManifest, limits = DEFAULT_FISCUS_PACK_LIMITS): void {
  const errors = validateFiscusPackManifest(value, limits);
  if (errors.length > 0) throw new Error(errors.join('; '));
}

export function manifestDigest(manifest: FiscusPackManifest, overrides: FiscusPackLimitsOverride = {}): string {
  const limits = resolveFiscusPackLimits(overrides);
  const limitErrors = validateFiscusPackLimits(limits);
  if (limitErrors.length > 0) throw new Error(limitErrors.join('; '));
  assertManifest(manifest, limits);
  return sha256(canonicalPackJson(manifestDigestMaterial(manifest), limits, limits.maxManifestBytes));
}

export function createFiscusPackManifest(input: FiscusPackManifestInput): FiscusPackManifest {
  const manifest: FiscusPackManifest = {
    schema: FISCUS_PACK_MANIFEST_SCHEMA,
    version: FISCUS_PACK_MANIFEST_VERSION,
    packId: input.packId,
    createdAt: input.createdAt,
    includedRecords: clone(input.includedRecords),
    omissions: clone(input.omissions),
    redactions: clone(input.redactions),
    externalReferences: clone(input.externalReferences),
    attachments: clone(input.attachments),
    ...(input.signature === undefined ? {} : { signature: clone(input.signature) }),
  };
  assertManifest(manifest);
  return freezeDeep(manifest);
}

export function createFiscusPackEnvelope(
  manifest: FiscusPackManifest,
  attachments: readonly FiscusPackAttachmentData[] = [],
): FiscusPackEnvelope {
  assertManifest(manifest);
  const pack: FiscusPackEnvelope = {
    schema: FISCUS_PACK_SCHEMA,
    version: FISCUS_PACK_VERSION,
    manifest,
    manifestDigest: manifestDigest(manifest),
    ...(attachments.length > 0 ? { attachments: clone(attachments) } : {}),
  };
  const errors = validateFiscusPackEnvelope(pack);
  if (errors.length > 0) throw new Error(errors.join('; '));
  return freezeDeep(pack);
}

/** Serialize only after validating the complete envelope; no pretty-printing is allowed. */
export function serializeFiscusPack(pack: FiscusPackEnvelope): string {
  const limits = resolveFiscusPackLimits();
  const errors = validateFiscusPackEnvelope(pack, limits);
  if (errors.length > 0) throw new Error(errors.join('; '));
  const encoded = canonicalPackJson(pack, limits, limits.maxEnvelopeBytes);
  if (Buffer.byteLength(encoded, 'utf8') > limits.maxEnvelopeBytes) throw new Error('pack envelope exceeds resource limit');
  return encoded;
}

export function canonicalFiscusPackManifest(manifest: FiscusPackManifest): string {
  const limits = resolveFiscusPackLimits();
  assertManifest(manifest, limits);
  return canonicalPackJson(manifestDigestMaterial(manifest), limits, limits.maxManifestBytes);
}
