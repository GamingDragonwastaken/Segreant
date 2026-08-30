/**
 * Value Receipts — what turns a private metric into a verifiable standard.
 *
 * Each unit of work emits a canonical, ed25519-signed record of cost → gate
 * verdicts → outcome. Anyone with the public key can verify a receipt without
 * any access to the source code, so a buyer/auditor/another tool can trust the
 * claim without trusting us. See docs/THE-STANDARD.md §7.
 */

import {
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  createHash,
  createPublicKey,
  createPrivateKey,
  type KeyObject,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Gate, Verdict, FunnelOutcome } from './gates.ts';
import { economicAttributionView, type EconomicAttribution } from '../economics/attribution.ts';
import { ECONOMIC_BASES, formatMoneyAmount, moneyFromJson, type EconomicBasis } from '../economics/money.ts';

export interface ReceiptBodyV1 {
  v: 1;
  unit: string; // commit hash
  project: string;
  generatedAt: string;
  costUsd: number;
  acceptance: number | null;
  reached: Gate | null;
  diedAt: Gate | null;
  realized: boolean;
  realizationScore: number;
  gates: Array<{ gate: Gate; verdict: Verdict }>;
}

/** Exact-economics receipt. The v1 body remains valid for legacy/partial units. */
export interface ReceiptBodyV2 extends Omit<ReceiptBodyV1, 'v'> {
  v: 2;
  /** Complete effective request coverage; unresolved legacy rows are forbidden. */
  economic: EconomicAttribution;
}

export type ReceiptBody = ReceiptBodyV1 | ReceiptBodyV2;

export interface SignedReceipt {
  body: ReceiptBody;
  bodyHash: string; // sha256 of canonical body, hex
  keyId: string; // sha256 fingerprint of the public key, first 16 hex chars
  publicKey: string; // PEM (spki)
  signature: string; // base64
}

/** Deterministic JSON: object keys sorted recursively. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export interface KeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
  keyId: string;
  publicPem: string;
}

/** Load the signing keypair from `keyPath`, generating one on first use. */
export function loadOrCreateKeyPair(keyPath: string): KeyPair {
  if (existsSync(keyPath)) {
    const stored = JSON.parse(readFileSync(keyPath, 'utf8')) as { privatePem: string; publicPem: string };
    const privateKey = createPrivateKey(stored.privatePem);
    const publicKey = createPublicKey(stored.publicPem);
    return { privateKey, publicKey, keyId: fingerprint(stored.publicPem), publicPem: stored.publicPem };
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const dir = dirname(keyPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(keyPath, JSON.stringify({ privatePem, publicPem }, null, 2), { mode: 0o600 });
  return { privateKey, publicKey, keyId: fingerprint(publicPem), publicPem };
}

function fingerprint(publicPem: string): string {
  return sha256Hex(publicPem).slice(0, 16);
}

/** Public keyId (fingerprint) for a PEM — what a vendor publishes so others can pin it. */
export function keyIdForPem(publicPem: string): string {
  return fingerprint(publicPem);
}

/** Collapse PEM whitespace/newline differences so two encodings of the same key compare equal. */
function normalizePem(pem: string): string {
  return pem.replace(/\s+/g, '');
}

export function buildReceiptBody(
  unit: string,
  project: string,
  costUsd: number,
  acceptance: number | null,
  funnel: FunnelOutcome,
): ReceiptBodyV1 {
  return {
    v: 1,
    unit,
    project,
    generatedAt: new Date().toISOString(),
    costUsd,
    acceptance,
    reached: funnel.reached,
    diedAt: funnel.diedAt,
    realized: funnel.realized,
    realizationScore: funnel.realizationScore,
    gates: funnel.results.map((r) => ({ gate: r.gate, verdict: r.verdict })),
  };
}

function canonicalEconomic(value: EconomicAttribution): EconomicAttribution {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('economic receipt coverage must be an object');
  const keys = Object.keys(value).sort();
  const expected = ['amount', 'amountText', 'complete', 'eventIds', 'requestCount', 'sourceBases', 'unresolvedRequests'].sort();
  if (keys.join('\u0000') !== expected.join('\u0000')) throw new Error('economic receipt coverage has unknown or missing fields');
  if (!Array.isArray(value.eventIds) || value.eventIds.some((id) => typeof id !== 'string' || id.length === 0)) throw new Error('economic receipt eventIds are invalid');
  if (new Set(value.eventIds).size !== value.eventIds.length || value.eventIds.some((id, index) => index > 0 && id < value.eventIds[index - 1]!)) {
    throw new Error('economic receipt eventIds must be unique and sorted');
  }
  if (!Array.isArray(value.sourceBases) || value.sourceBases.some((basis) => !(ECONOMIC_BASES as readonly string[]).includes(basis))) throw new Error('economic receipt sourceBases are invalid');
  if (new Set(value.sourceBases).size !== value.sourceBases.length || value.sourceBases.some((basis, index) => index > 0 && basis < value.sourceBases[index - 1]!)) {
    throw new Error('economic receipt sourceBases must be unique and sorted');
  }
  if (!Number.isSafeInteger(value.requestCount) || value.requestCount < 0 || !Number.isSafeInteger(value.unresolvedRequests) || value.unresolvedRequests < 0) {
    throw new Error('economic receipt request coverage counts are invalid');
  }
  const amount = moneyFromJson(value.amount);
  if (amount.basis !== 'effective' || value.amountText !== formatMoneyAmount(amount)) throw new Error('economic receipt amount is not canonical effective Money');
  const canonical = economicAttributionView({
    amount,
    eventIds: value.eventIds,
    sourceBases: value.sourceBases as EconomicBasis[],
    requestCount: value.requestCount,
    unresolvedRequests: value.unresolvedRequests,
  });
  if (canonical.complete !== value.complete || canonical.amountText !== value.amountText) throw new Error('economic receipt coverage is internally inconsistent');
  return canonical;
}

/** Build a strict v2 receipt for a WorkUnit with complete exact coverage. */
export function buildEconomicReceiptBody(
  unit: string,
  project: string,
  costUsd: number,
  acceptance: number | null,
  funnel: FunnelOutcome,
  economic: EconomicAttribution,
): ReceiptBodyV2 {
  const canonical = canonicalEconomic(economic);
  if (!canonical.complete || canonical.unresolvedRequests !== 0) throw new Error('economic receipt requires complete exact coverage');
  if (!Number.isFinite(costUsd) || costUsd < 0) throw new Error('economic receipt compatibility cost must be finite and non-negative');
  const projected = Number(canonical.amountText);
  if (!Number.isFinite(projected) || Math.abs(costUsd - projected) > Math.max(1e-12, Math.abs(projected) * 1e-12)) {
    throw new Error('economic receipt compatibility cost disagrees with exact amount');
  }
  const legacy = buildReceiptBody(unit, project, costUsd, acceptance, funnel);
  return Object.freeze({ ...legacy, v: 2, economic: canonical });
}

function receiptSemanticError(body: ReceiptBody): string | null {
  if (body.v !== 2) return null;
  try {
    const economic = canonicalEconomic(body.economic);
    if (!economic.complete || economic.unresolvedRequests !== 0) return 'economic receipt requires complete exact coverage';
    const projected = Number(economic.amountText);
    if (!Number.isFinite(body.costUsd) || body.costUsd < 0 || !Number.isFinite(projected)
        || Math.abs(body.costUsd - projected) > Math.max(1e-12, Math.abs(projected) * 1e-12)) {
      return 'economic receipt compatibility cost disagrees with exact amount';
    }
    return null;
  } catch (error) {
    return `economic receipt invalid: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function signReceipt(body: ReceiptBody, keys: KeyPair): SignedReceipt {
  const c = canonical(body);
  const signature = cryptoSign(null, Buffer.from(c), keys.privateKey).toString('base64');
  return {
    body,
    bodyHash: sha256Hex(c),
    keyId: keys.keyId,
    publicKey: keys.publicPem,
    signature,
  };
}

/** An out-of-band trust anchor: who the verifier expects signed the receipt. */
export interface VerifyOptions {
  trustedKeyId?: string; // receipt must be signed by this key fingerprint
  trustedPublicKeyPem?: string; // receipt's embedded key must equal this PEM
}

export interface VerifyResult {
  valid: boolean;
  reason: string;
  keyId: string; // fingerprint recomputed from the receipt's embedded key (not the claimed field)
  pinned: boolean; // a trust anchor was supplied AND matched → authentic, not just intact
}

/**
 * Verify a receipt. Two distinct guarantees:
 *  - INTEGRITY (always): the body wasn't altered after signing, the embedded
 *    signature is valid, and the claimed `keyId` honestly fingerprints the
 *    embedded key. This alone does NOT prove who signed it — a forger can sign
 *    fabricated claims with their own key and embed it.
 *  - AUTHENTICITY (when a trust anchor is given): the signer is the key the
 *    verifier pinned out-of-band. Pass `trustedKeyId` (the publisher's published
 *    fingerprint) or `trustedPublicKeyPem` to reject receipts from any other key.
 */
export function verifyReceipt(receipt: SignedReceipt, opts: VerifyOptions = {}): VerifyResult {
  const c = canonical(receipt.body);

  // Recompute the fingerprint from the embedded key — never trust the claimed field.
  let embeddedKeyId: string;
  try {
    embeddedKeyId = keyIdForPem(receipt.publicKey);
  } catch {
    return { valid: false, reason: 'unreadable public key', keyId: '', pinned: false };
  }

  if (sha256Hex(c) !== receipt.bodyHash) {
    return { valid: false, reason: 'body hash mismatch', keyId: embeddedKeyId, pinned: false };
  }
  if (receipt.keyId !== embeddedKeyId) {
    return { valid: false, reason: 'keyId does not match the embedded public key', keyId: embeddedKeyId, pinned: false };
  }

  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(receipt.publicKey);
  } catch {
    return { valid: false, reason: 'unreadable public key', keyId: embeddedKeyId, pinned: false };
  }
  const ok = cryptoVerify(null, Buffer.from(c), publicKey, Buffer.from(receipt.signature, 'base64'));
  if (!ok) return { valid: false, reason: 'signature mismatch', keyId: embeddedKeyId, pinned: false };

  const semanticError = receiptSemanticError(receipt.body);
  if (semanticError !== null) return { valid: false, reason: semanticError, keyId: embeddedKeyId, pinned: false };

  // Integrity holds. Now the authenticity / trust-anchor check.
  let pinned = false;
  if (opts.trustedPublicKeyPem !== undefined) {
    if (normalizePem(opts.trustedPublicKeyPem) !== normalizePem(receipt.publicKey)) {
      return { valid: false, reason: 'signed by an untrusted key (public key does not match the pinned key)', keyId: embeddedKeyId, pinned: false };
    }
    pinned = true;
  }
  if (opts.trustedKeyId !== undefined) {
    if (opts.trustedKeyId.toLowerCase() !== embeddedKeyId.toLowerCase()) {
      return { valid: false, reason: `signed by an untrusted key (keyId ${embeddedKeyId} does not match pinned ${opts.trustedKeyId})`, keyId: embeddedKeyId, pinned: false };
    }
    pinned = true;
  }

  return {
    valid: true,
    reason: pinned ? 'signature valid and signed by the pinned key' : 'signature valid (key not pinned)',
    keyId: embeddedKeyId,
    pinned,
  };
}
