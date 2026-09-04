/**
 * ISSUANCE CLASS: integrity_only — see `src/epistemic/issuance-map.ts`. The
 * signature authenticates the sender and fixes the bytes. It adds nothing to
 * the strength of the values carried: an aggregate of compatibility-basis rows
 * is still compatibility-basis after signing.
 *
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
import { assertAgreesWithUsdCompatibility, canonicalEconomicAttribution, type EconomicAttribution } from '../economics/attribution.ts';

/**
 * Coverage is a non-authoritative statement about what the signer included in
 * this snapshot. It is not a statement that the included numbers are true,
 * provider-billed, or complete in any external system.
 */
export type RollupCoverage = 'complete' | 'partial' | 'unknown';

const ROLLUP_COVERAGE: readonly RollupCoverage[] = ['complete', 'partial', 'unknown'];

export interface RollupBodyV1 {
  v: 1;
  keyId: string; // the pushing developer's team-rollup key fingerprint
  generatedAt: string;
  period: { from: string; to: string };
  /**
   * Optional only for compatibility with bodies produced before this field
   * existed. A missing legacy value is normalized to `unknown` by consumers;
   * verification never writes it into the signed body.
   */
  coverage?: RollupCoverage;
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

export interface EconomicProjectValue extends ProjectValue {
  economic: {
    coverage: 'exact' | 'partial' | 'legacy_unknown';
    total: EconomicAttribution | null;
    realized: EconomicAttribution | null;
  };
}

/** Versioned team artifact that can carry exact project-level lineage. */
export interface RollupBodyV2 extends Omit<RollupBodyV1, 'v' | 'projects'> {
  v: 2;
  /** Untrusted callers are checked at the semantic boundary before use. */
  projects: ProjectValue[];
}

export type RollupBody = RollupBodyV1 | RollupBodyV2;

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
  coverage: RollupCoverage = 'complete',
): RollupBodyV1 {
  const body: RollupBodyV1 = { v: 1, keyId: keys.keyId, generatedAt: new Date().toISOString(), period, coverage, projects };
  // Only attach the key when there is something to say — an absent field and an
  // empty array canonicalize differently, and absent is the older-client shape.
  if (strata && strata.length > 0) body.strata = strata;
  return body;
}

function canonicalEconomicProject(project: EconomicProjectValue): EconomicProjectValue {
  if (project.economic === null || typeof project.economic !== 'object' || Array.isArray(project.economic)) {
    throw new Error(`economic team rollup project ${project.project} is missing economic coverage`);
  }
  const total = project.economic.total === null ? null : canonicalEconomicAttribution(project.economic.total);
  const realized = project.economic.realized === null ? null : canonicalEconomicAttribution(project.economic.realized);
  const coverage = project.economic.coverage;
  if (coverage !== 'exact' && coverage !== 'partial' && coverage !== 'legacy_unknown') throw new Error(`economic team rollup project ${project.project} has invalid coverage`);
  if (coverage === 'exact' && (total === null || realized === null || !total.complete || !realized.complete)) {
    throw new Error(`economic team rollup project ${project.project} requires complete exact coverage`);
  }
  if (total !== null) {
    assertAgreesWithUsdCompatibility(total, project.costUsd, `economic team rollup project ${project.project}`);
  }
  return Object.freeze({
    ...project,
    economic: Object.freeze({ coverage, total, realized }),
  });
}

/** Build a v2 team rollup when every project carries an exact attribution object. */
export function buildEconomicRollupBody(
  keys: KeyPair,
  projects: EconomicProjectValue[],
  period: { from: string; to: string },
  strata?: ProjectTaskStratum[],
  coverage: RollupCoverage = 'complete',
): RollupBodyV2 {
  if (!Array.isArray(projects) || projects.length === 0) throw new Error('economic team rollup projects must be a non-empty array');
  const canonicalProjects = projects.map(canonicalEconomicProject);
  const body: RollupBodyV2 = {
    v: 2,
    keyId: keys.keyId,
    generatedAt: new Date().toISOString(),
    period,
    coverage,
    projects: canonicalProjects,
  };
  if (strata && strata.length > 0) body.strata = strata;
  return Object.freeze(body);
}

function exceedsBound(value: number, bound: number): boolean {
  return value - bound > Math.max(Math.abs(bound), 1) * 1e-9;
}

function validateProjectContainment(project: ProjectValue, label: string): string | null {
  const cost = project.costUsd;
  const realizedSpend = project.spendOnRealizedUnitsUsd;
  const acceptanceSpend = project.acceptanceWeightedSpendUsd;
  if (exceedsBound(realizedSpend, cost)) return `${label}.spendOnRealizedUnitsUsd must not exceed ${label}.costUsd`;
  if (exceedsBound(acceptanceSpend, realizedSpend)) return `${label}.acceptanceWeightedSpendUsd must not exceed ${label}.spendOnRealizedUnitsUsd`;
  return null;
}

/**
 * Read the signer-declared coverage without upgrading legacy payloads. This
 * helper deliberately returns `unknown` for absence (and for an invalid value
 * on a payload that has not yet passed validation); `validateRollupBody` still
 * rejects an invalid explicit value.
 */
export function normalizeRollupCoverage(body: RollupBody): RollupCoverage {
  const value = (body as RollupBodyV1).coverage;
  return ROLLUP_COVERAGE.includes(value as RollupCoverage) ? value as RollupCoverage : 'unknown';
}

/** Combine signer claims conservatively; unknown must never become complete. */
export function combineRollupCoverage(statuses: readonly RollupCoverage[]): RollupCoverage {
  if (statuses.some((status) => status === 'unknown')) return 'unknown';
  if (statuses.some((status) => status === 'partial')) return 'partial';
  return statuses.length > 0 ? 'complete' : 'unknown';
}

function validateRollupCoverage(body: RollupBody): string | null {
  const value = (body as RollupBodyV1).coverage;
  if (value === undefined) return null;
  if (!ROLLUP_COVERAGE.includes(value as RollupCoverage)) {
    return 'team rollup coverage must be one of: complete, partial, unknown';
  }
  return null;
}

/** Validate v1/v2 project containment and v2 exact project lineage. */
export function validateRollupBody(body: RollupBody): string | null {
  if (body.v !== 1 && body.v !== 2) return 'economic team rollup body version is invalid';
  const coverageError = validateRollupCoverage(body);
  if (coverageError !== null) return coverageError;
  if (!Array.isArray(body.projects)) return 'economic team rollup projects must be an array';
  for (let index = 0; index < body.projects.length; index += 1) {
    const project = body.projects[index]!;
    const containmentError = validateProjectContainment(project, `body.projects[${index}]`);
    if (containmentError !== null) return containmentError;
    if (body.v === 2) {
      try {
        canonicalEconomicProject(project as EconomicProjectValue);
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }
  }
  return null;
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
  keyId: string; // fingerprint recomputed from the embedded public key, never the claimed field
  pinned: boolean;
  /** The signer's non-authoritative coverage claim; legacy absence is `unknown`. */
  coverage: RollupCoverage;
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
  const coverage = normalizeRollupCoverage(rollup.body);

  let embeddedKeyId: string;
  try {
    embeddedKeyId = keyIdForPem(rollup.publicKey);
  } catch {
    return { valid: false, reason: 'unreadable public key', keyId: '', pinned: false, coverage };
  }

  if (sha256Hex(c) !== rollup.bodyHash) {
    return { valid: false, reason: 'body hash mismatch', keyId: embeddedKeyId, pinned: false, coverage };
  }
  if (rollup.keyId !== embeddedKeyId) {
    return { valid: false, reason: 'keyId does not match the embedded public key', keyId: embeddedKeyId, pinned: false, coverage };
  }

  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(rollup.publicKey);
  } catch {
    return { valid: false, reason: 'unreadable public key', keyId: embeddedKeyId, pinned: false, coverage };
  }
  const ok = cryptoVerify(null, Buffer.from(c), publicKey, Buffer.from(rollup.signature, 'base64'));
  if (!ok) return { valid: false, reason: 'signature mismatch', keyId: embeddedKeyId, pinned: false, coverage };

  const semanticError = validateRollupBody(rollup.body);
  if (semanticError !== null) return { valid: false, reason: semanticError, keyId: embeddedKeyId, pinned: false, coverage };

  let pinned = false;
  if (opts.trustedPublicKeyPem !== undefined) {
    if (normalizePem(opts.trustedPublicKeyPem) !== normalizePem(rollup.publicKey)) {
      return { valid: false, reason: 'signed by an untrusted key (public key does not match the pinned key)', keyId: embeddedKeyId, pinned: false, coverage };
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
        coverage,
      };
    }
    pinned = true;
  }

  return {
    valid: true,
    reason: pinned ? 'signature valid and signed by the pinned key' : 'signature valid (key not pinned)',
    keyId: embeddedKeyId,
    pinned,
    coverage,
  };
}
