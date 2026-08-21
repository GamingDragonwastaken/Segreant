/**
 * Team-tier rollup: a signed, numeric-only, cross-project snapshot of ONE
 * developer's local ledger, pushed to an enterprise-run, bring-your-own team
 * server. See docs/TEAM-TIER-DESIGN.md §2 — "this isn't a new crypto
 * subsystem; it's the existing 'verifiable claim without trusting the source'
 * pattern... pointed at a new payload shape." Reuses value/receipt.ts's
 * `canonical`/`keyIdForPem`/`loadOrCreateKeyPair`/`KeyPair` directly rather
 * than reimplementing them — canonicalization in particular MUST be
 * byte-identical between whoever signs a rollup and whoever verifies it, so
 * importing the one true implementation is a correctness requirement here,
 * not just a style preference.
 *
 * Zero new runtime dependencies (node:crypto only), so this file is safe for
 * the (separate, optional, BYO-Postgres) team-server package to import by
 * relative path for verification — see team-server/'s own README for why that
 * package is allowed a `pg` dependency the main CLI/proxy never carries.
 *
 * A SEPARATE keypair from `receipt-key.json` on purpose: a commit receipt's
 * key may be distributed per-commit to whoever reviews that commit; a
 * team-rollup key is a longer-lived "this is developer X's machine" identity
 * registered once with a team server. Different trust domains, same
 * separation-of-concerns reasoning as the judge feature's dedicated
 * FISCUS_JUDGE_API_KEY (docs/LIFT-AI-SIDE-JUDGE-DESIGN.md §2).
 */

import { sign as cryptoSign, verify as cryptoVerify, createHash, createPublicKey, type KeyObject } from 'node:crypto';
import { canonical, keyIdForPem, type KeyPair } from '../value/receipt.ts';
import type { ProjectValue, ProjectTaskStratum } from '../value/realization.ts';

export interface RollupBody {
  v: 1;
  keyId: string; // the pushing developer's team-rollup key fingerprint
  generatedAt: string;
  period: { from: string; to: string };
  // Numeric-only per docs/TEAM-TIER-DESIGN.md §2: no prompt/response content,
  // no raw request log — the same aggregate shape already shown to a
  // single-machine budget owner (value/realization.ts's projectValueBreakdown).
  projects: ProjectValue[];
  // Optional (additive — absent from rollups pushed by older clients): the
  // same numbers one grain finer, per project × task-type, so the server can
  // hold a task basket FIXED and compare developers/periods like with like
  // instead of letting task-mix differences drive the ranking (Simpson's
  // paradox — see src/team/standardize.ts). Same disclosure class as
  // `projects`: counts and dollars only.
  strata?: ProjectTaskStratum[];
}

export interface SignedRollup {
  body: RollupBody;
  bodyHash: string; // sha256 of canonical body, hex
  keyId: string;
  publicKey: string; // PEM (spki)
  signature: string; // base64
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function buildRollupBody(
  keys: KeyPair,
  projects: ProjectValue[],
  period: { from: string; to: string },
  strata?: ProjectTaskStratum[],
): RollupBody {
  const body: RollupBody = { v: 1, keyId: keys.keyId, generatedAt: new Date().toISOString(), period, projects };
  // Only attach the key when there is something to say — an absent field and an
  // empty array canonicalize differently, and absent is the older-client shape.
  if (strata && strata.length > 0) body.strata = strata;
  return body;
}

export function signRollup(body: RollupBody, keys: KeyPair): SignedRollup {
  const c = canonical(body);
  const signature = cryptoSign(null, Buffer.from(c), keys.privateKey).toString('base64');
  return { body, bodyHash: sha256Hex(c), keyId: keys.keyId, publicKey: keys.publicPem, signature };
}

/** An out-of-band trust anchor: which registered developer key the team server expects. */
export interface RollupVerifyOptions {
  trustedKeyId?: string;
  trustedPublicKeyPem?: string;
}

export interface RollupVerifyResult {
  valid: boolean;
  reason: string;
  keyId: string; // fingerprint recomputed from the embedded key, never the claimed field
  pinned: boolean;
}

function normalizePem(pem: string): string {
  return pem.replace(/\s+/g, '');
}

/**
 * Verify a rollup. Mirrors receipt.ts's verifyReceipt exactly (same two-tier
 * integrity-then-authenticity guarantee, same "recompute the fingerprint from
 * the embedded key, never trust the claimed field" discipline) — kept as a
 * parallel implementation rather than a generic shared function so neither
 * receipt verification nor rollup verification can regress the other by a
 * change made for just one of them.
 */
export function verifyRollup(rollup: SignedRollup, opts: RollupVerifyOptions = {}): RollupVerifyResult {
  const c = canonical(rollup.body);

  let embeddedKeyId: string;
  try {
    embeddedKeyId = keyIdForPem(rollup.publicKey);
  } catch {
    return { valid: false, reason: 'unreadable public key', keyId: '', pinned: false };
  }

  if (sha256Hex(c) !== rollup.bodyHash) {
    return { valid: false, reason: 'body hash mismatch', keyId: embeddedKeyId, pinned: false };
  }
  if (rollup.keyId !== embeddedKeyId) {
    return { valid: false, reason: 'keyId does not match the embedded public key', keyId: embeddedKeyId, pinned: false };
  }

  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(rollup.publicKey);
  } catch {
    return { valid: false, reason: 'unreadable public key', keyId: embeddedKeyId, pinned: false };
  }
  const ok = cryptoVerify(null, Buffer.from(c), publicKey, Buffer.from(rollup.signature, 'base64'));
  if (!ok) return { valid: false, reason: 'signature mismatch', keyId: embeddedKeyId, pinned: false };

  let pinned = false;
  if (opts.trustedPublicKeyPem !== undefined) {
    if (normalizePem(opts.trustedPublicKeyPem) !== normalizePem(rollup.publicKey)) {
      return { valid: false, reason: 'signed by an untrusted key (public key does not match the pinned key)', keyId: embeddedKeyId, pinned: false };
    }
    pinned = true;
  }
  if (opts.trustedKeyId !== undefined) {
    if (opts.trustedKeyId.toLowerCase() !== embeddedKeyId.toLowerCase()) {
      return {
        valid: false,
        reason: `signed by an untrusted key (keyId ${embeddedKeyId} does not match pinned ${opts.trustedKeyId})`,
        keyId: embeddedKeyId,
        pinned: false,
      };
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
