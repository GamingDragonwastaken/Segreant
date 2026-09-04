import { RESOURCE_LIMITS } from '../util/resource-limits.ts';

export const FISCUS_PACK_SCHEMA = 'fiscuspack' as const;
export const FISCUS_PACK_VERSION = 1 as const;
export const FISCUS_PACK_MANIFEST_SCHEMA = 'fiscuspack.manifest' as const;
export const FISCUS_PACK_MANIFEST_VERSION = 1 as const;

export type FiscusPackDigest = string;
export type FiscusPackRecordKind = string;

export interface FiscusPackRecordReference {
  readonly kind: FiscusPackRecordKind;
  readonly id: string;
  readonly digest: FiscusPackDigest;
}

export interface FiscusPackOmission {
  readonly kind: FiscusPackRecordKind;
  readonly count: number;
  readonly ids: readonly string[];
  readonly reason: string;
}

export interface FiscusPackRedaction {
  readonly kind: FiscusPackRecordKind;
  readonly ids: readonly string[];
  readonly fields: readonly string[];
  readonly reason: string;
}

export interface FiscusPackExternalReference {
  readonly id: string;
  readonly kind: string;
  readonly digest: FiscusPackDigest;
  /** Metadata only. Verification never dereferences this locator. */
  readonly uri: string;
}

export interface FiscusPackAttachment {
  /** Pack-relative POSIX path; no filesystem resolution is performed by verification. */
  readonly path: string;
  readonly mediaType: string;
  readonly sizeBytes: number;
  readonly digest: FiscusPackDigest;
}

export interface FiscusPackSignatureMetadata {
  readonly algorithm: string;
  readonly keyId: string;
  readonly signature: string;
  /** Digest of the manifest content excluding this metadata object. */
  readonly signedDigest: FiscusPackDigest;
}

export interface FiscusPackManifestInput {
  readonly packId: string;
  readonly createdAt: string;
  readonly includedRecords: readonly FiscusPackRecordReference[];
  readonly omissions: readonly FiscusPackOmission[];
  readonly redactions: readonly FiscusPackRedaction[];
  readonly externalReferences: readonly FiscusPackExternalReference[];
  readonly attachments: readonly FiscusPackAttachment[];
  readonly signature?: FiscusPackSignatureMetadata;
}

export interface FiscusPackManifest extends FiscusPackManifestInput {
  readonly schema: typeof FISCUS_PACK_MANIFEST_SCHEMA;
  readonly version: typeof FISCUS_PACK_MANIFEST_VERSION;
}

export interface FiscusPackEnvelope {
  readonly schema: typeof FISCUS_PACK_SCHEMA;
  readonly version: typeof FISCUS_PACK_VERSION;
  readonly manifest: FiscusPackManifest;
  readonly manifestDigest: FiscusPackDigest;
}

/**
 * Limits are deliberately part of the verifier contract. They bound both raw
 * input parsing and the declared collections inside a pack; they are not
 * claims about the completeness or correctness of the records named by it.
 */
export interface FiscusPackLimits {
  readonly maxEnvelopeBytes: number;
  readonly maxManifestBytes: number;
  readonly maxIncludedRecords: number;
  readonly maxOmissions: number;
  readonly maxRedactions: number;
  readonly maxExternalReferences: number;
  readonly maxAttachments: number;
  readonly maxCanonicalNodes: number;
  readonly maxCanonicalDepth: number;
  readonly maxCanonicalStringBytes: number;
  readonly maxIdentifierChars: number;
  readonly maxReasonChars: number;
  readonly maxFieldChars: number;
  readonly maxExternalUriChars: number;
  readonly maxSignatureChars: number;
  readonly maxAttachmentPathChars: number;
  readonly maxAttachmentSizeBytes: number;
  readonly maxAttachmentBytes: number;
}

export type FiscusPackLimitsOverride = Partial<FiscusPackLimits>;

export const DEFAULT_FISCUS_PACK_LIMITS: FiscusPackLimits = Object.freeze({
  maxEnvelopeBytes: RESOURCE_LIMITS.evidenceArtifactBytes,
  maxManifestBytes: RESOURCE_LIMITS.evidenceArtifactBytes,
  maxIncludedRecords: 100_000,
  maxOmissions: 10_000,
  maxRedactions: 10_000,
  maxExternalReferences: 10_000,
  maxAttachments: 10_000,
  maxCanonicalNodes: RESOURCE_LIMITS.canonicalNodes,
  maxCanonicalDepth: RESOURCE_LIMITS.canonicalDepth,
  maxCanonicalStringBytes: RESOURCE_LIMITS.canonicalStringBytes,
  maxIdentifierChars: 160,
  maxReasonChars: RESOURCE_LIMITS.metadataFieldChars,
  maxFieldChars: RESOURCE_LIMITS.metadataFieldChars,
  maxExternalUriChars: 2_048,
  maxSignatureChars: 16_384,
  maxAttachmentPathChars: 1_024,
  maxAttachmentSizeBytes: 64 * 1024 * 1024,
  maxAttachmentBytes: 256 * 1024 * 1024,
});

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER_RE = /^[A-Za-z0-9._:-]+$/;
const KIND_RE = /^[A-Za-z][A-Za-z0-9._:-]*$/;
const TOP_LEVEL_KEYS = ['schema', 'version', 'manifest', 'manifestDigest'] as const;
const MANIFEST_KEYS = [
  'schema',
  'version',
  'packId',
  'createdAt',
  'includedRecords',
  'omissions',
  'redactions',
  'externalReferences',
  'attachments',
  'signature',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function rejectUnexpectedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  errors: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${label} contains unsupported field: ${key}`);
  }
}

function requireKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string,
  errors: string[],
): void {
  for (const key of required) {
    if (!hasOwn(value, key)) errors.push(`${label} is missing field: ${key}`);
  }
}

function validBoundedString(value: unknown, maxChars: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxChars
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validIdentifier(value: unknown, maxChars: number): value is string {
  return validBoundedString(value, maxChars) && IDENTIFIER_RE.test(value);
}

function validKind(value: unknown, maxChars: number): value is string {
  return validBoundedString(value, maxChars) && KIND_RE.test(value);
}

function validDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST_RE.test(value);
}

function validIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function validArray(value: unknown, maxItems: number, label: string, errors: string[]): value is readonly unknown[] {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return false;
  }
  if (value.length > maxItems) errors.push(`${label.replaceAll('.', ' ').replace('includedRecords', 'included records')} exceeds resource limit (${maxItems})`);
  return true;
}

function validateRecordReferences(
  value: unknown,
  limits: FiscusPackLimits,
  errors: string[],
): void {
  if (!validArray(value, limits.maxIncludedRecords, 'manifest.includedRecords', errors)) return;
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    const label = `manifest.includedRecords[${index}]`;
    if (!isRecord(item)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    rejectUnexpectedKeys(item, ['kind', 'id', 'digest'], label, errors);
    requireKeys(item, ['kind', 'id', 'digest'], label, errors);
    if (!validKind(item.kind, limits.maxIdentifierChars)) errors.push(`${label}.kind is invalid`);
    if (!validIdentifier(item.id, limits.maxIdentifierChars)) errors.push(`${label}.id is invalid`);
    if (!validDigest(item.digest)) errors.push(`${label}.digest is invalid`);
    if (validKind(item.kind, limits.maxIdentifierChars) && validIdentifier(item.id, limits.maxIdentifierChars)) {
      const identity = `${item.kind}\u0000${item.id}`;
      if (seen.has(identity)) errors.push(`${label} duplicates an included record identity`);
      seen.add(identity);
    }
  }
}

function validateOmissions(value: unknown, limits: FiscusPackLimits, errors: string[]): void {
  if (!validArray(value, limits.maxOmissions, 'manifest.omissions', errors)) return;
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    const label = `manifest.omissions[${index}]`;
    if (!isRecord(item)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    rejectUnexpectedKeys(item, ['kind', 'count', 'ids', 'reason'], label, errors);
    requireKeys(item, ['kind', 'count', 'ids', 'reason'], label, errors);
    if (!validKind(item.kind, limits.maxIdentifierChars)) errors.push(`${label}.kind is invalid`);
    if (typeof item.count !== 'number' || !Number.isSafeInteger(item.count) || item.count <= 0) {
      errors.push(`${label}.count must be a positive safe integer`);
    }
    if (validArray(item.ids, limits.maxIncludedRecords, `${label}.ids`, errors)) {
      const ids = new Set<string>();
      for (let idIndex = 0; idIndex < item.ids.length; idIndex += 1) {
        const id = item.ids[idIndex];
        if (!validIdentifier(id, limits.maxIdentifierChars)) errors.push(`${label}.ids[${idIndex}] is invalid`);
        if (typeof id === 'string') {
          if (ids.has(id)) errors.push(`${label}.ids contains a duplicate id`);
          ids.add(id);
        }
      }
      if (typeof item.count === 'number' && item.ids.length > item.count) errors.push(`${label}.ids exceeds declared count`);
    }
    if (!validBoundedString(item.reason, limits.maxReasonChars)) errors.push(`${label}.reason is invalid`);
  }
}

function validateRedactions(value: unknown, limits: FiscusPackLimits, errors: string[]): void {
  if (!validArray(value, limits.maxRedactions, 'manifest.redactions', errors)) return;
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    const label = `manifest.redactions[${index}]`;
    if (!isRecord(item)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    rejectUnexpectedKeys(item, ['kind', 'ids', 'fields', 'reason'], label, errors);
    requireKeys(item, ['kind', 'ids', 'fields', 'reason'], label, errors);
    if (!validKind(item.kind, limits.maxIdentifierChars)) errors.push(`${label}.kind is invalid`);
    if (validArray(item.ids, limits.maxIncludedRecords, `${label}.ids`, errors)) {
      const ids = new Set<string>();
      for (let idIndex = 0; idIndex < item.ids.length; idIndex += 1) {
        const id = item.ids[idIndex];
        if (!validIdentifier(id, limits.maxIdentifierChars)) errors.push(`${label}.ids[${idIndex}] is invalid`);
        if (typeof id === 'string') {
          if (ids.has(id)) errors.push(`${label}.ids contains a duplicate id`);
          ids.add(id);
        }
      }
    }
    if (!validArray(item.fields, limits.maxIncludedRecords, `${label}.fields`, errors)) continue;
    if (item.fields.length === 0) errors.push(`${label}.fields must not be empty`);
    const fields = new Set<string>();
    for (let fieldIndex = 0; fieldIndex < item.fields.length; fieldIndex += 1) {
      const field = item.fields[fieldIndex];
      if (!validBoundedString(field, limits.maxFieldChars)) errors.push(`${label}.fields[${fieldIndex}] is invalid`);
      if (typeof field === 'string') {
        if (fields.has(field)) errors.push(`${label}.fields contains a duplicate field`);
        fields.add(field);
      }
    }
    if (!validBoundedString(item.reason, limits.maxReasonChars)) errors.push(`${label}.reason is invalid`);
  }
}

function validateExternalReferences(value: unknown, limits: FiscusPackLimits, errors: string[]): void {
  if (!validArray(value, limits.maxExternalReferences, 'manifest.externalReferences', errors)) return;
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    const label = `manifest.externalReferences[${index}]`;
    if (!isRecord(item)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    rejectUnexpectedKeys(item, ['id', 'kind', 'digest', 'uri'], label, errors);
    requireKeys(item, ['id', 'kind', 'digest', 'uri'], label, errors);
    if (!validIdentifier(item.id, limits.maxIdentifierChars)) errors.push(`${label}.id is invalid`);
    if (!validKind(item.kind, limits.maxIdentifierChars)) errors.push(`${label}.kind is invalid`);
    if (!validDigest(item.digest)) errors.push(`${label}.digest is invalid`);
    if (!validBoundedString(item.uri, limits.maxExternalUriChars)) errors.push(`${label}.uri is invalid`);
    if (typeof item.id === 'string') {
      if (seen.has(item.id)) errors.push(`${label} duplicates an external reference id`);
      seen.add(item.id);
    }
  }
}

export function isSafeRelativeAttachmentPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.includes('\\') || value.includes(':') || value.includes('\u0000') || value.startsWith('/')) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  const parts = value.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function validateAttachments(value: unknown, limits: FiscusPackLimits, errors: string[]): void {
  if (!validArray(value, limits.maxAttachments, 'manifest.attachments', errors)) return;
  const seen = new Set<string>();
  let totalBytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    const label = `manifest.attachments[${index}]`;
    if (!isRecord(item)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    rejectUnexpectedKeys(item, ['path', 'mediaType', 'sizeBytes', 'digest'], label, errors);
    requireKeys(item, ['path', 'mediaType', 'sizeBytes', 'digest'], label, errors);
    if (!isSafeRelativeAttachmentPath(item.path) || item.path.length > limits.maxAttachmentPathChars) {
      errors.push(`${label}.path is not a safe relative attachment path`);
    }
    if (!validBoundedString(item.mediaType, 127) || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(item.mediaType)) {
      errors.push(`${label}.mediaType is invalid`);
    }
    if (typeof item.sizeBytes !== 'number' || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0) {
      errors.push(`${label}.sizeBytes must be a nonnegative safe integer`);
    } else if (item.sizeBytes > limits.maxAttachmentSizeBytes) {
      errors.push(`${label}.sizeBytes exceeds resource limit (${limits.maxAttachmentSizeBytes})`);
    } else if (totalBytes <= limits.maxAttachmentBytes - item.sizeBytes) {
      totalBytes += item.sizeBytes;
    } else {
      errors.push(`manifest.attachments declared bytes exceed resource limit (${limits.maxAttachmentBytes})`);
    }
    if (!validDigest(item.digest)) errors.push(`${label}.digest is invalid`);
    if (typeof item.path === 'string') {
      if (seen.has(item.path)) errors.push(`${label} duplicates an attachment path`);
      seen.add(item.path);
    }
  }
}

function validateSignature(value: unknown, limits: FiscusPackLimits, errors: string[]): void {
  if (value === undefined) return;
  const label = 'manifest.signature';
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  rejectUnexpectedKeys(value, ['algorithm', 'keyId', 'signature', 'signedDigest'], label, errors);
  requireKeys(value, ['algorithm', 'keyId', 'signature', 'signedDigest'], label, errors);
  if (!validBoundedString(value.algorithm, limits.maxIdentifierChars)) errors.push(`${label}.algorithm is invalid`);
  if (!validIdentifier(value.keyId, limits.maxIdentifierChars)) errors.push(`${label}.keyId is invalid`);
  if (!validBoundedString(value.signature, limits.maxSignatureChars)) errors.push(`${label}.signature is invalid`);
  if (!validDigest(value.signedDigest)) errors.push(`${label}.signedDigest is invalid`);
}

export function validateFiscusPackLimits(value: FiscusPackLimits): string[] {
  const errors: string[] = [];
  const positiveKeys: readonly (keyof FiscusPackLimits)[] = [
    'maxEnvelopeBytes',
    'maxManifestBytes',
    'maxCanonicalNodes',
    'maxCanonicalDepth',
    'maxCanonicalStringBytes',
    'maxIdentifierChars',
    'maxReasonChars',
    'maxFieldChars',
    'maxExternalUriChars',
    'maxSignatureChars',
    'maxAttachmentPathChars',
    'maxAttachmentSizeBytes',
    'maxAttachmentBytes',
  ];
  const countKeys: readonly (keyof FiscusPackLimits)[] = [
    'maxIncludedRecords',
    'maxOmissions',
    'maxRedactions',
    'maxExternalReferences',
    'maxAttachments',
  ];
  for (const key of positiveKeys) {
    const current = value[key];
    if (!Number.isSafeInteger(current) || current <= 0) errors.push(`limits.${key} must be a positive safe integer`);
  }
  for (const key of countKeys) {
    const current = value[key];
    if (!Number.isSafeInteger(current) || current < 0) errors.push(`limits.${key} must be a nonnegative safe integer`);
  }
  return errors;
}

export function resolveFiscusPackLimits(overrides: FiscusPackLimitsOverride = {}): FiscusPackLimits {
  return Object.freeze({ ...DEFAULT_FISCUS_PACK_LIMITS, ...overrides });
}

export function manifestDigestMaterial(manifest: FiscusPackManifest): Record<string, unknown> {
  const { signature: _signature, ...material } = manifest;
  return material;
}

export function validateFiscusPackManifest(value: unknown, limits: FiscusPackLimits = DEFAULT_FISCUS_PACK_LIMITS): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ['manifest must be an object'];
  rejectUnexpectedKeys(value, MANIFEST_KEYS, 'manifest', errors);
  requireKeys(value, MANIFEST_KEYS.filter((key) => key !== 'signature'), 'manifest', errors);
  if (value.schema !== FISCUS_PACK_MANIFEST_SCHEMA) errors.push(`manifest.schema must be ${FISCUS_PACK_MANIFEST_SCHEMA}`);
  if (value.version !== FISCUS_PACK_MANIFEST_VERSION) errors.push(`manifest.version must be ${FISCUS_PACK_MANIFEST_VERSION}`);
  if (!validIdentifier(value.packId, limits.maxIdentifierChars)) errors.push('manifest.packId is invalid');
  if (!validIsoTimestamp(value.createdAt)) errors.push('manifest.createdAt must be an ISO-8601 UTC timestamp');
  validateRecordReferences(value.includedRecords, limits, errors);
  validateOmissions(value.omissions, limits, errors);
  validateRedactions(value.redactions, limits, errors);
  validateExternalReferences(value.externalReferences, limits, errors);
  validateAttachments(value.attachments, limits, errors);
  validateSignature(value.signature, limits, errors);
  return errors;
}

export function validateFiscusPackEnvelope(value: unknown, limits: FiscusPackLimits = DEFAULT_FISCUS_PACK_LIMITS): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ['pack envelope must be an object'];
  rejectUnexpectedKeys(value, TOP_LEVEL_KEYS, 'pack envelope', errors);
  requireKeys(value, TOP_LEVEL_KEYS, 'pack envelope', errors);
  if (value.schema !== FISCUS_PACK_SCHEMA) errors.push(`pack envelope.schema must be ${FISCUS_PACK_SCHEMA}`);
  if (value.version !== FISCUS_PACK_VERSION) errors.push(`pack envelope.version must be ${FISCUS_PACK_VERSION}`);
  if (!validDigest(value.manifestDigest)) errors.push('pack envelope.manifestDigest is invalid');
  errors.push(...validateFiscusPackManifest(value.manifest, limits));
  return errors;
}

export function isFiscusPackDigest(value: unknown): value is FiscusPackDigest {
  return validDigest(value);
}
