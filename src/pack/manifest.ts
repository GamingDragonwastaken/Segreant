import { createHash } from 'node:crypto';
import { canonicalPackJson } from './canonical.ts';
import {
  DEFAULT_SEGREANT_PACK_LIMITS,
  SEGREANT_PACK_MANIFEST_SCHEMA,
  SEGREANT_PACK_MANIFEST_VERSION,
  SEGREANT_PACK_SCHEMA,
  SEGREANT_PACK_VERSION,
  manifestDigestMaterial,
  resolveSegreantPackLimits,
  validateSegreantPackEnvelope,
  validateSegreantPackLimits,
  validateSegreantPackManifest,
  type SegreantPackEnvelope,
  type SegreantPackAttachmentData,
  type SegreantPackLimitsOverride,
  type SegreantPackManifest,
  type SegreantPackManifestInput,
} from './types.ts';

export type { SegreantPackManifestInput } from './types.ts';
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

function assertManifest(value: SegreantPackManifest, limits = DEFAULT_SEGREANT_PACK_LIMITS): void {
  const errors = validateSegreantPackManifest(value, limits);
  if (errors.length > 0) throw new Error(errors.join('; '));
}

export function manifestDigest(manifest: SegreantPackManifest, overrides: SegreantPackLimitsOverride = {}): string {
  const limits = resolveSegreantPackLimits(overrides);
  const limitErrors = validateSegreantPackLimits(limits);
  if (limitErrors.length > 0) throw new Error(limitErrors.join('; '));
  assertManifest(manifest, limits);
  return sha256(canonicalPackJson(manifestDigestMaterial(manifest), limits, limits.maxManifestBytes));
}

export function createSegreantPackManifest(input: SegreantPackManifestInput): SegreantPackManifest {
  const manifest: SegreantPackManifest = {
    schema: SEGREANT_PACK_MANIFEST_SCHEMA,
    version: SEGREANT_PACK_MANIFEST_VERSION,
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

export function createSegreantPackEnvelope(
  manifest: SegreantPackManifest,
  attachments: readonly SegreantPackAttachmentData[] = [],
): SegreantPackEnvelope {
  assertManifest(manifest);
  const pack: SegreantPackEnvelope = {
    schema: SEGREANT_PACK_SCHEMA,
    version: SEGREANT_PACK_VERSION,
    manifest,
    manifestDigest: manifestDigest(manifest),
    ...(attachments.length > 0 ? { attachments: clone(attachments) } : {}),
  };
  const errors = validateSegreantPackEnvelope(pack);
  if (errors.length > 0) throw new Error(errors.join('; '));
  return freezeDeep(pack);
}

/** Serialize only after validating the complete envelope; no pretty-printing is allowed. */
export function serializeSegreantPack(pack: SegreantPackEnvelope): string {
  const limits = resolveSegreantPackLimits();
  const errors = validateSegreantPackEnvelope(pack, limits);
  if (errors.length > 0) throw new Error(errors.join('; '));
  const encoded = canonicalPackJson(pack, limits, limits.maxEnvelopeBytes);
  if (Buffer.byteLength(encoded, 'utf8') > limits.maxEnvelopeBytes) throw new Error('pack envelope exceeds resource limit');
  return encoded;
}

export function canonicalSegreantPackManifest(manifest: SegreantPackManifest): string {
  const limits = resolveSegreantPackLimits();
  assertManifest(manifest, limits);
  return canonicalPackJson(manifestDigestMaterial(manifest), limits, limits.maxManifestBytes);
}
