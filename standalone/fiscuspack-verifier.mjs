#!/usr/bin/env node
/**
 * A dependency-free FiscusPack verifier.
 *
 * This file intentionally does not import the Fiscus producer, store, or
 * runtime.  It is a small executable reference for consumers that receive a
 * pack as bytes or already-parsed JSON.  The only imported modules are
 * Node's standard-library crypto and (for the command-line adapter) read-only
 * file/URL helpers.
 */
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FISCUS_PACK_SCHEMA = 'fiscuspack';
export const FISCUS_PACK_VERSION = 1;
export const FISCUS_PACK_MANIFEST_SCHEMA = 'fiscuspack.manifest';
export const FISCUS_PACK_MANIFEST_VERSION = 1;

// These are explicit values rather than imports from the application.  The
// limits are part of the wire verifier contract and are deliberately bounded
// independently of any producer configuration.
export const DEFAULT_FISCUS_PACK_LIMITS = Object.freeze({
  maxEnvelopeBytes: 1 * 1024 * 1024,
  maxManifestBytes: 1 * 1024 * 1024,
  maxIncludedRecords: 100_000,
  maxOmissions: 10_000,
  maxRedactions: 10_000,
  maxExternalReferences: 10_000,
  maxAttachments: 10_000,
  maxCanonicalNodes: 200_000,
  maxCanonicalDepth: 128,
  maxCanonicalStringBytes: 2 * 1024 * 1024,
  maxIdentifierChars: 160,
  maxReasonChars: 256,
  maxFieldChars: 256,
  maxExternalUriChars: 2_048,
  maxSignatureChars: 16_384,
  maxAttachmentPathChars: 1_024,
  maxAttachmentSizeBytes: 64 * 1024 * 1024,
  maxAttachmentBytes: 256 * 1024 * 1024,
});

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER_RE = /^[A-Za-z0-9._:-]+$/;
const KIND_RE = /^[A-Za-z][A-Za-z0-9._:-]*$/;
const TOP_LEVEL_KEYS = ['schema', 'version', 'manifest', 'manifestDigest', 'attachments'];
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
];

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function rejectUnexpectedKeys(value, allowed, label, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${label} contains unsupported field: ${key}`);
  }
}

function requireKeys(value, required, label, errors) {
  for (const key of required) {
    if (!hasOwn(value, key)) errors.push(`${label} is missing field: ${key}`);
  }
}

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function validBoundedString(value, maxChars) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxChars
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validIdentifier(value, maxChars) {
  return validBoundedString(value, maxChars) && IDENTIFIER_RE.test(value);
}

function validKind(value, maxChars) {
  return validBoundedString(value, maxChars) && KIND_RE.test(value);
}

function validDigest(value) {
  return typeof value === 'string' && DIGEST_RE.test(value);
}

function validIsoTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function validArray(value, maxItems, label, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return false;
  }
  if (value.length > maxItems) {
    const human = label.replaceAll('.', ' ').replace('includedRecords', 'included records');
    errors.push(`${human} exceeds resource limit (${maxItems})`);
  }
  return true;
}

export function isSafeRelativeAttachmentPath(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.includes('\\') || value.includes(':') || value.includes('\u0000') || value.startsWith('/')) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  const parts = value.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function decodeCanonicalBase64(value) {
  if (typeof value !== 'string'
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value ? decoded : null;
}

function validateRecordReferences(value, limits, errors) {
  if (!validArray(value, limits.maxIncludedRecords, 'manifest.includedRecords', errors)) return;
  const seen = new Set();
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

function validateOmissions(value, limits, errors) {
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
    if (!Number.isSafeInteger(item.count) || item.count <= 0) errors.push(`${label}.count must be a positive safe integer`);
    if (validArray(item.ids, limits.maxIncludedRecords, `${label}.ids`, errors)) {
      const ids = new Set();
      for (let idIndex = 0; idIndex < item.ids.length; idIndex += 1) {
        const id = item.ids[idIndex];
        if (!validIdentifier(id, limits.maxIdentifierChars)) errors.push(`${label}.ids[${idIndex}] is invalid`);
        if (typeof id === 'string') {
          if (ids.has(id)) errors.push(`${label}.ids contains a duplicate id`);
          ids.add(id);
        }
      }
      if (Number.isSafeInteger(item.count) && item.ids.length > item.count) errors.push(`${label}.ids exceeds declared count`);
    }
    if (!validBoundedString(item.reason, limits.maxReasonChars)) errors.push(`${label}.reason is invalid`);
  }
}

function validateRedactions(value, limits, errors) {
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
      const ids = new Set();
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
    const fields = new Set();
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

function validateExternalReferences(value, limits, errors) {
  if (!validArray(value, limits.maxExternalReferences, 'manifest.externalReferences', errors)) return;
  const seen = new Set();
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

function validateAttachments(value, limits, errors) {
  if (!validArray(value, limits.maxAttachments, 'manifest.attachments', errors)) return;
  const seen = new Set();
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
    if (!Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 0) {
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

function validateSignature(value, limits, errors) {
  if (value === undefined) return;
  const label = 'manifest.signature';
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return;
  }
  rejectUnexpectedKeys(value, ['algorithm', 'keyId', 'signature', 'signedDigest', 'publicKey'], label, errors);
  requireKeys(value, ['algorithm', 'keyId', 'signature', 'signedDigest'], label, errors);
  if (!validBoundedString(value.algorithm, limits.maxIdentifierChars)) errors.push(`${label}.algorithm is invalid`);
  if (!validIdentifier(value.keyId, limits.maxIdentifierChars)) errors.push(`${label}.keyId is invalid`);
  if (!validBoundedString(value.signature, limits.maxSignatureChars)) errors.push(`${label}.signature is invalid`);
  if (!validDigest(value.signedDigest)) errors.push(`${label}.signedDigest is invalid`);
  if (value.publicKey !== undefined) {
    if (value.algorithm !== 'ed25519') errors.push(`${label}.algorithm must be ed25519 for a cryptographic signature`);
    const publicKey = decodeCanonicalBase64(value.publicKey);
    if (publicKey === null || publicKey.byteLength === 0) errors.push(`${label}.publicKey must be canonical base64`);
    const signature = decodeCanonicalBase64(value.signature);
    if (signature === null || signature.byteLength !== 64) errors.push(`${label}.signature must be a 64-byte Ed25519 signature`);
  }
}

function validateManifest(value, limits, errors) {
  if (!isRecord(value)) {
    errors.push('manifest must be an object');
    return;
  }
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
}

function validateInlineAttachments(value, manifestAttachments, limits, errors) {
  if (value === undefined) return;
  if (!validArray(value, limits.maxAttachments, 'pack.attachments', errors)) return;
  const declared = new Map();
  if (Array.isArray(manifestAttachments)) {
    for (const item of manifestAttachments) {
      if (isRecord(item) && typeof item.path === 'string' && Number.isSafeInteger(item.sizeBytes) && typeof item.digest === 'string') {
        declared.set(item.path, { sizeBytes: item.sizeBytes, digest: item.digest });
      }
    }
  }
  const seen = new Set();
  let totalBytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    const label = `pack.attachments[${index}]`;
    if (!isRecord(item)) {
      errors.push(`${label} must be an object`);
      continue;
    }
    rejectUnexpectedKeys(item, ['path', 'data'], label, errors);
    requireKeys(item, ['path', 'data'], label, errors);
    if (!isSafeRelativeAttachmentPath(item.path) || item.path.length > limits.maxAttachmentPathChars) {
      errors.push(`${label}.path is not a safe relative attachment path`);
    }
    if (typeof item.path === 'string') {
      if (seen.has(item.path)) errors.push(`${label} duplicates an attachment path`);
      seen.add(item.path);
      if (!declared.has(item.path)) errors.push(`${label}.path is not declared by the manifest`);
    }
    const decoded = decodeCanonicalBase64(item.data);
    if (decoded === null) {
      errors.push(`${label}.data must be canonical base64`);
      continue;
    }
    if (decoded.byteLength > limits.maxAttachmentSizeBytes) {
      errors.push(`${label}.data exceeds resource limit (${limits.maxAttachmentSizeBytes})`);
    } else if (totalBytes <= limits.maxAttachmentBytes - decoded.byteLength) {
      totalBytes += decoded.byteLength;
    } else {
      errors.push(`pack.attachments decoded bytes exceed resource limit (${limits.maxAttachmentBytes})`);
    }
    const declaration = typeof item.path === 'string' ? declared.get(item.path) : undefined;
    if (declaration !== undefined) {
      const digest = `sha256:${createHash('sha256').update(decoded).digest('hex')}`;
      if (declaration.sizeBytes !== decoded.byteLength) errors.push(`${label}.data size does not match manifest`);
      if (declaration.digest !== digest) errors.push(`${label}.data digest does not match manifest`);
    }
  }
}

function validateEnvelope(value, limits, errors) {
  if (!isRecord(value)) {
    errors.push('pack envelope must be an object');
    return;
  }
  rejectUnexpectedKeys(value, TOP_LEVEL_KEYS, 'pack envelope', errors);
  requireKeys(value, ['schema', 'version', 'manifest', 'manifestDigest'], 'pack envelope', errors);
  if (value.schema !== FISCUS_PACK_SCHEMA) errors.push(`pack envelope.schema must be ${FISCUS_PACK_SCHEMA}`);
  if (value.version !== FISCUS_PACK_VERSION) errors.push(`pack envelope.version must be ${FISCUS_PACK_VERSION}`);
  if (!validDigest(value.manifestDigest)) errors.push('pack envelope.manifestDigest is invalid');
  validateManifest(value.manifest, limits, errors);
  if (isRecord(value.manifest)) validateInlineAttachments(value.attachments, value.manifest.attachments, limits, errors);
}

function canonicalJson(value, limits, maxBytes) {
  const seen = new WeakSet();
  let nodes = 0;
  const visit = (current, path, depth) => {
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
    let result;
    if (Array.isArray(current)) {
      result = `[${current.map((item, index) => visit(item, `${path}[${index}]`, depth + 1)).join(',')}]`;
    } else {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} is not a plain object`);
      result = `{${Object.keys(current).sort((a, b) => a.localeCompare(b)).map((key) => {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error(`${path}.${key} is forbidden`);
        return `${JSON.stringify(key)}:${visit(current[key], `${path}.${key}`, depth + 1)}`;
      }).join(',')}}`;
    }
    seen.delete(current);
    if (byteLength(result) > maxBytes) throw new Error(`${path} exceeds canonical byte limit (${maxBytes})`);
    return result;
  };
  return visit(value, 'value', 0);
}

function digest(value) {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function resolveLimits(overrides = {}) {
  return Object.freeze({ ...DEFAULT_FISCUS_PACK_LIMITS, ...(isRecord(overrides) ? overrides : {}) });
}

function validateLimits(value) {
  const errors = [];
  const positiveKeys = [
    'maxEnvelopeBytes', 'maxManifestBytes', 'maxCanonicalNodes', 'maxCanonicalDepth',
    'maxCanonicalStringBytes', 'maxIdentifierChars', 'maxReasonChars', 'maxFieldChars',
    'maxExternalUriChars', 'maxSignatureChars', 'maxAttachmentPathChars',
    'maxAttachmentSizeBytes', 'maxAttachmentBytes',
  ];
  const countKeys = ['maxIncludedRecords', 'maxOmissions', 'maxRedactions', 'maxExternalReferences', 'maxAttachments'];
  for (const key of positiveKeys) {
    if (!Number.isSafeInteger(value[key]) || value[key] <= 0) errors.push(`limits.${key} must be a positive safe integer`);
  }
  for (const key of countKeys) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) errors.push(`limits.${key} must be a nonnegative safe integer`);
  }
  return errors;
}

function parseInput(input, limits) {
  if (typeof input === 'string') {
    if (byteLength(input) > limits.maxEnvelopeBytes) return { value: null, errors: [`pack envelope exceeds resource limit (${limits.maxEnvelopeBytes} bytes)`] };
    try {
      return { value: JSON.parse(input), errors: [] };
    } catch {
      return { value: null, errors: ['pack envelope is invalid JSON'] };
    }
  }
  if (input instanceof Uint8Array) {
    if (input.byteLength > limits.maxEnvelopeBytes) return { value: null, errors: [`pack envelope exceeds resource limit (${limits.maxEnvelopeBytes} bytes)`] };
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(input);
      return parseInput(text, limits);
    } catch {
      return { value: null, errors: ['pack envelope is not valid UTF-8 JSON'] };
    }
  }
  return { value: input, errors: [] };
}

function emptySignature() {
  return { status: 'absent', cryptographicVerification: 'not_performed', pinned: false, keyId: null, signedDigest: null };
}

function emptyAttachments() {
  return { status: 'none', declared: 0, present: 0 };
}

function invalidResult(errors, limits) {
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

function keyIdForPublicKey(key) {
  const der = key.export({ type: 'spki', format: 'der' });
  return `sha256:${createHash('sha256').update(der).digest('hex')}`;
}

function asTrustedPublicKey(input) {
  let key;
  if (input instanceof Uint8Array) {
    key = createPublicKey({ key: Buffer.from(input), format: 'der', type: 'spki' });
  } else {
    if (typeof input !== 'string') throw new Error('trusted public key must be canonical base64 SPKI, PEM, or DER bytes');
    if (input.includes('BEGIN PUBLIC KEY')) key = createPublicKey(input);
    else {
      const bytes = decodeCanonicalBase64(input);
      if (bytes === null) throw new Error('trusted public key must be canonical base64 SPKI, PEM, or DER bytes');
      key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
    }
  }
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') {
    throw new Error('trusted public key must be an Ed25519 public key');
  }
  return key;
}

/**
 * Verify a FiscusPack envelope without persistence, generation, filesystem
 * access, network calls, or application imports.
 *
 * `trustedPublicKey` is optional and must be an out-of-band Ed25519 SPKI
 * public key (canonical base64, PEM, or DER bytes). An embedded public key
 * proves the signature's cryptographic relationship to the pack bytes; only
 * a matching supplied anchor can establish authenticity. Semantic truth and
 * completeness of named records are intentionally never evaluated here.
 */
export function verifyFiscusPack(input, options = {}) {
  const limits = resolveLimits(options?.limits);
  const limitErrors = validateLimits(limits);
  if (limitErrors.length > 0) return invalidResult(limitErrors, limits);

  const parsed = parseInput(input, limits);
  if (parsed.errors.length > 0) return invalidResult(parsed.errors, limits);

  const errors = [];
  validateEnvelope(parsed.value, limits, errors);
  const value = parsed.value;
  const manifest = isRecord(value) && isRecord(value.manifest) ? value.manifest : null;
  let computedDigest = null;
  let canonicalVerified = false;
  if (manifest !== null && typeof value.manifestDigest === 'string') {
    try {
      const material = {
        schema: manifest.schema,
        version: manifest.version,
        packId: manifest.packId,
        createdAt: manifest.createdAt,
        includedRecords: manifest.includedRecords,
        omissions: manifest.omissions,
        redactions: manifest.redactions,
        externalReferences: manifest.externalReferences,
        attachments: manifest.attachments,
      };
      const encoded = canonicalJson(material, limits, limits.maxManifestBytes);
      computedDigest = digest(encoded);
      if (computedDigest !== value.manifestDigest) errors.push('manifest digest verification failed');
      else canonicalVerified = errors.length === 0;
      if (isRecord(manifest.signature) && manifest.signature.signedDigest !== computedDigest) {
        errors.push('signature signed digest does not match manifest digest');
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  // Structural validation and the content digest are the canonical/integrity
  // axis. A trust-anchor mismatch is intentionally tracked separately below:
  // it makes the requested verification fail but does not turn good bytes into
  // bad bytes.
  const structuralIntegrity = errors.length === 0 && computedDigest !== null && canonicalVerified;
  let signature = emptySignature();
  let signatureIntegrity = true;
  if (manifest !== null && isRecord(manifest.signature)) {
    const raw = manifest.signature;
    const metadataOnly = {
      status: 'metadata_only',
      cryptographicVerification: 'not_performed',
      pinned: false,
      keyId: typeof raw.keyId === 'string' ? raw.keyId : null,
      signedDigest: typeof raw.signedDigest === 'string' ? raw.signedDigest : null,
    };
    signature = metadataOnly;
    if (raw.publicKey !== undefined && computedDigest !== null) {
      const publicKeyBytes = decodeCanonicalBase64(raw.publicKey);
      const signatureBytes = decodeCanonicalBase64(raw.signature);
      if (publicKeyBytes === null || signatureBytes === null) {
        errors.push('signature cryptographic material is not valid canonical base64');
        signature = { ...metadataOnly, status: 'invalid', cryptographicVerification: 'failed' };
        signatureIntegrity = false;
      } else {
        try {
          const embeddedKey = createPublicKey({ key: publicKeyBytes, format: 'der', type: 'spki' });
          if (embeddedKey.asymmetricKeyType !== 'ed25519') throw new Error('not an Ed25519 public key');
          const embeddedKeyId = keyIdForPublicKey(embeddedKey);
          if (embeddedKeyId !== raw.keyId) {
            errors.push('signature key id does not match public key');
            signature = { ...metadataOnly, status: 'invalid', cryptographicVerification: 'failed' };
            signatureIntegrity = false;
          } else {
            let valid = false;
            try {
              valid = cryptoVerify(null, Buffer.from(raw.signedDigest, 'utf8'), embeddedKey, signatureBytes);
            } catch {
              valid = false;
            }
            if (!valid) {
              errors.push('signature verification failed');
              signature = { ...metadataOnly, status: 'invalid', cryptographicVerification: 'failed' };
              signatureIntegrity = false;
            } else {
              let pinned = false;
              if (options?.trustedPublicKey !== undefined) {
                try {
                  pinned = keyIdForPublicKey(asTrustedPublicKey(options.trustedPublicKey)) === embeddedKeyId;
                } catch {
                  errors.push('trusted public key is invalid');
                }
                if (!pinned && !errors.includes('trusted public key is invalid')) errors.push('signature public key is not trusted by supplied key');
              }
              signature = {
                status: 'valid',
                cryptographicVerification: 'verified',
                pinned,
                keyId: raw.keyId,
                signedDigest: raw.signedDigest,
              };
            }
          }
        } catch {
          errors.push('signature public key is not a valid Ed25519 SPKI key');
          signature = { ...metadataOnly, status: 'invalid', cryptographicVerification: 'failed' };
          signatureIntegrity = false;
        }
      }
    }
  }

  const declaredAttachments = manifest !== null && Array.isArray(manifest.attachments) ? manifest.attachments.length : 0;
  const presentAttachments = isRecord(value) && Array.isArray(value.attachments) ? value.attachments.length : 0;
  const attachments = {
    status: declaredAttachments === 0 ? 'none' : presentAttachments === declaredAttachments ? 'complete' : 'partial',
    declared: declaredAttachments,
    present: presentAttachments,
  };
  const integrity = structuralIntegrity && signatureIntegrity ? 'verified' : 'not_verified';
  const authenticity = signature.pinned && signature.cryptographicVerification === 'verified' ? 'verified' : 'not_established';
  return {
    ok: errors.length === 0,
    errors,
    manifestDigest: computedDigest,
    canonical: canonicalVerified ? 'verified' : 'not_verified',
    integrity,
    authenticity,
    truth: 'not_evaluated',
    signature,
    attachments,
    limits,
  };
}

function runCli() {
  const args = process.argv.slice(2);
  let inputPath = null;
  let trustedPublicKey;
  let limits;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--trusted-key' || arg === '--trusted-public-key') {
      trustedPublicKey = args[index + 1];
      index += 1;
    } else if (arg === '--limits') {
      try {
        limits = JSON.parse(args[index + 1] ?? '');
      } catch {
        process.stderr.write('fiscuspack verifier: --limits must be valid JSON\n');
        process.exitCode = 2;
        return;
      }
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write('Usage: fiscuspack-verify [PACK.json|-] [--trusted-key BASE64|PEM] [--limits JSON]\n');
      return;
    } else if (inputPath === null) {
      inputPath = arg;
    } else {
      process.stderr.write(`fiscuspack verifier: unexpected argument ${arg}\n`);
      process.exitCode = 2;
      return;
    }
  }
  let input;
  try {
    input = inputPath === null || inputPath === '-'
      ? readFileSync(0)
      : readFileSync(inputPath);
  } catch (error) {
    process.stderr.write(`fiscuspack verifier: cannot read input: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
    return;
  }
  const result = verifyFiscusPack(input, { ...(trustedPublicKey === undefined ? {} : { trustedPublicKey }), ...(limits === undefined ? {} : { limits }) });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) runCli();
