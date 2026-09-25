/**
 * Export the local epistemic ledger as a `.segreantpack` envelope.
 *
 * The first production producer of a pack (D-229). What travels: every node
 * the ledger graph holds — evidence, claims, assumptions, witnesses,
 * derivations — each bound in `includedRecords` by the SHA-256 of its
 * canonical JSON, and the payloads themselves as one attachment,
 * `records.json`, whose bytes the manifest binds by digest. What does not
 * travel is said in the manifest rather than dropped: a node that would push
 * the envelope past the byte limit is an OMISSION with its ids and the reason;
 * evidence classed `confidential` or `restricted` travels with its `payload`
 * replaced by `null` and a REDACTION naming the ids and the field. A pack
 * with omissions or redactions is still a valid pack — it says less, and says
 * that it does.
 *
 * Truth is not evaluated here or by the verifier. A pack proves that these
 * bytes are the bytes the manifest bound and, with a trust anchor, that the
 * holder of a key signed them. Whether the claims inside hold is the kernel's
 * question, and the kernel is not in the pack.
 */

import { createHash } from 'node:crypto';
import type { EpistemicLedger } from '../epistemic/ledger.ts';
import { canonicalJson } from '../epistemic/serialization.ts';
import type { Instant } from '../epistemic/time.ts';
import { createSegreantPackEnvelope, createSegreantPackManifest } from './manifest.ts';
import { signSegreantPack, type SegreantPackKeyInput } from './signature.ts';
import { DEFAULT_SEGREANT_PACK_LIMITS, type SegreantPackEnvelope, type SegreantPackOmission, type SegreantPackRecordReference, type SegreantPackRedaction } from './types.ts';

export const LEDGER_PACK_RECORDS_PATH = 'records.json';
export const LEDGER_PACK_RECORDS_MEDIA_TYPE = 'application/json';

/** Evidence at or above this class travels with its payload redacted. */
const REDACTED_SENSITIVITY = new Set(['confidential', 'restricted']);

export interface LedgerPackExportInput {
  readonly ledger: EpistemicLedger;
  readonly packId: string;
  readonly createdAt: Instant;
  /** Sign the manifest; the public key is embedded so a verifier can check integrity. */
  readonly signingKey?: SegreantPackKeyInput;
  /**
   * Byte budget for the records attachment. Defaults to a share of the
   * envelope limit that leaves room for the manifest; nodes past it are
   * omitted, not truncated.
   */
  readonly attachmentByteBudget?: number;
}

export interface LedgerPackExportSummary {
  readonly included: number;
  readonly omitted: number;
  readonly redacted: number;
  readonly attachmentBytes: number;
  readonly signed: boolean;
}

export interface LedgerPackExport {
  readonly pack: SegreantPackEnvelope;
  readonly summary: LedgerPackExportSummary;
}

function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

function readNode(ledger: EpistemicLedger, kind: string, id: string): Record<string, unknown> | null {
  switch (kind) {
    case 'evidence': return ledger.readEvidence(id) as unknown as Record<string, unknown> | null;
    case 'claim': return ledger.readClaim(id) as unknown as Record<string, unknown> | null;
    case 'assumption': return ledger.readAssumption(id) as unknown as Record<string, unknown> | null;
    case 'witness': return ledger.readWitness(id) as unknown as Record<string, unknown> | null;
    case 'derivation': return ledger.readDerivation(id) as unknown as Record<string, unknown> | null;
    default: return null;
  }
}

export function exportLedgerPack(input: LedgerPackExportInput): LedgerPackExport {
  const budget = input.attachmentByteBudget ?? Math.floor(DEFAULT_SEGREANT_PACK_LIMITS.maxEnvelopeBytes * 0.6);
  if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error('attachment byte budget must be a positive integer');

  const graph = input.ledger.graph();
  const includedRecords: SegreantPackRecordReference[] = [];
  const records: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const omittedByKind = new Map<string, string[]>();
  const redactedIds: string[] = [];
  let attachmentBytes = 2; // the enclosing `[]`
  let full = false;

  for (const node of graph.nodes) {
    const payload = readNode(input.ledger, node.kind, node.id);
    if (payload === null) throw new Error(`stored ${node.kind} node ${node.id} has no payload`);
    // The reference digest binds the record AS STORED; a redacted copy in the
    // attachment is a different byte string and the redaction entry says so.
    const digest = sha256(canonicalJson(payload));
    let carried = payload;
    if (node.kind === 'evidence' && REDACTED_SENSITIVITY.has(String(payload.sensitivity))) {
      carried = { ...payload, payload: null };
      redactedIds.push(node.id);
    }
    const entry = { kind: node.kind, payload: carried };
    const entryBytes = Buffer.byteLength(canonicalJson(entry), 'utf8') + (records.length > 0 ? 1 : 0);
    if (full || attachmentBytes + entryBytes > budget) {
      full = true;
      const ids = omittedByKind.get(node.kind) ?? [];
      ids.push(node.id);
      omittedByKind.set(node.kind, ids);
      continue;
    }
    attachmentBytes += entryBytes;
    includedRecords.push({ kind: node.kind, id: node.id, digest });
    records.push(entry);
  }

  const omissions: SegreantPackOmission[] = [...omittedByKind.entries()].map(([kind, ids]) => ({
    kind,
    count: ids.length,
    ids,
    reason: `records attachment byte budget of ${budget} reached; nodes past it were omitted whole, not truncated`,
  }));
  const redactions: SegreantPackRedaction[] = redactedIds.length === 0 ? [] : [{
    kind: 'evidence',
    ids: redactedIds,
    fields: ['payload'],
    reason: 'evidence classed confidential or restricted travels without its payload',
  }];

  const attachmentText = canonicalJson(records);
  const attachmentData = Buffer.from(attachmentText, 'utf8');
  const manifest = createSegreantPackManifest({
    packId: input.packId,
    createdAt: input.createdAt,
    includedRecords,
    omissions,
    redactions,
    externalReferences: [],
    attachments: [{
      path: LEDGER_PACK_RECORDS_PATH,
      mediaType: LEDGER_PACK_RECORDS_MEDIA_TYPE,
      sizeBytes: attachmentData.byteLength,
      digest: `sha256:${createHash('sha256').update(attachmentData).digest('hex')}`,
    }],
  });
  let pack = createSegreantPackEnvelope(manifest, [{ path: LEDGER_PACK_RECORDS_PATH, data: attachmentData.toString('base64') }]);
  if (input.signingKey !== undefined) pack = signSegreantPack(pack, input.signingKey);

  return Object.freeze({
    pack,
    summary: Object.freeze({
      included: includedRecords.length,
      omitted: omissions.reduce((sum, omission) => sum + omission.count, 0),
      redacted: redactedIds.length,
      attachmentBytes: attachmentData.byteLength,
      signed: input.signingKey !== undefined,
    }),
  });
}
