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

/**
 * WHAT the signer summarised, as distinct from how completely they summarised
 * it. `coverage` answers "did retention cut into my window"; `scope` answers
 * "is this every project on my machine". They are different absences and one
 * field cannot carry both: a rollup can have intact spend rows for exactly one
 * of three projects, and every existing field would call that complete.
 *
 * `unknown` is the sentinel, and it is what a body produced before this field
 * existed reads as. It is never upgraded to `all-projects` from context — the
 * receiver's own aggregation is the context, and inferring from it is the exact
 * failure the sentinel exists to prevent.
 */
export type RollupScopeKind = 'all-projects' | 'project' | 'unknown';

export interface RollupScope {
  kind: RollupScopeKind;
  /** Present exactly when `kind` is `project`: a scope that names nothing scopes nothing. */
  project?: string;
}

const ROLLUP_SCOPE_KINDS: readonly RollupScopeKind[] = ['all-projects', 'project', 'unknown'];

/** The sentinel, as a value. Callers that cannot determine scope must use this rather than omit the field. */
export const UNKNOWN_ROLLUP_SCOPE: RollupScope = Object.freeze({ kind: 'unknown' });

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
  /**
   * What this rollup covers. Optional in the TYPE only for bodies produced
   * before the field existed; every body this module builds carries it
   * explicitly, and a missing legacy value is normalized to `unknown` by
   * consumers rather than inferred. Verification never writes it into the
   * signed body.
   */
  scope?: RollupScope;
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

/** One project as the LOCAL LEDGER holds it, independent of what a body claims about it. */
export interface RollupLedgerProject {
  project: string;
  units: number;
  costUsd: number;
  spendOnRealizedUnitsUsd: number;
  acceptanceWeightedSpendUsd: number;
}

/**
 * The ledger a rollup claims to summarise, read at emit.
 *
 * Deliberately a plain data shape and not a `Store`: this module is imported by
 * the separate team-server package by relative path, so it must not reach the
 * node:sqlite persistence layer. `src/team/ledger-evidence.ts` reads a real
 * ledger into this shape; the check below is pure and testable without one.
 */
export interface RollupLedgerEvidence {
  /** EVERY project the ledger holds for the window, unfiltered — the population a scope claim is checked against. */
  projects: readonly RollupLedgerProject[];
  /** The window the ledger was actually queried over. */
  window: { from: string; to: string };
  /** Does that window start strictly before a recorded deletion boundary? (`Store.windowCoverage`) */
  retentionTruncatesWindow: boolean;
  /** The boundary, or null for NO PRUNE ON RECORD — which is not "nothing was pruned". */
  retentionPrunedBeforeMs: number | null;
}

/** What a caller states about the body it is asking for. Supplying one at all requires stating the scope. */
export interface RollupBasis {
  scope: RollupScope;
  /** The ledger these totals came from. Present whenever the caller has one; the mint checks against it. */
  ledger?: RollupLedgerEvidence;
}

/**
 * Decimal places the compatibility dollar fields are compared at.
 *
 * Twelve is far below what IEEE-754 can distinguish for amounts of this size
 * and far above any amount a person could notice, so two honest sums that
 * differ only by summation order quantize to the same integer while a real
 * discrepancy of a millionth of a cent still does not.
 */
const COMPATIBILITY_SCALE = 12;

/**
 * The compatibility dollar fields as exact integers, for comparison only.
 *
 * NOT `Money`, DELIBERATELY. `Money` carries an `EconomicBasis` as part of its
 * runtime identity precisely so that billed dollars cannot be added to
 * allocated ones. `costUsd` and its siblings carry no basis at all — this
 * file's own header calls them compatibility-basis, which is not a member of
 * `ECONOMIC_BASES` — so wrapping them in `Money` would attach a basis the
 * number does not have, which is the collapse rule one of this project exists
 * to refuse. What is required of this comparison is exact arithmetic, and
 * fixed-scale integers give that without inventing a provenance. Exact `Money`
 * is used where an exact amount really travels: v2 bodies carry
 * `economic.total`, and `canonicalEconomicProject` already checks it.
 */
function exactMinorUnits(value: number, label: string): bigint {
  if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  const text = value.toFixed(COMPATIBILITY_SCALE);
  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const magnitude = BigInt(whole + fraction.padEnd(COMPATIBILITY_SCALE, '0'));
  return negative ? -magnitude : magnitude;
}

export function buildRollupBody(
  keys: KeyPair,
  projects: ProjectValue[],
  period: { from: string; to: string },
  strata?: ProjectTaskStratum[],
  coverage: RollupCoverage = 'complete',
  basis?: RollupBasis,
): RollupBodyV1 {
  const body: RollupBodyV1 = {
    v: 1,
    keyId: keys.keyId,
    generatedAt: new Date().toISOString(),
    period,
    coverage,
    // ALWAYS WRITTEN, and the default is the WEAKEST value the field can take.
    // `coverage` defaulted to `complete` while both call sites omitted it, and
    // that unwired default published the strongest possible claim over a
    // pruned ledger (D-181). A builder handed a list of projects and no scope
    // cannot know whether that list is the whole machine, so it says so.
    scope: canonicalRollupScope(basis?.scope ?? UNKNOWN_ROLLUP_SCOPE),
    projects,
  };
  // Only attach the key when there is something to say — an absent field and an
  // empty array canonicalize differently, and absent is the older-client shape.
  if (strata && strata.length > 0) body.strata = strata;
  assertMintable(body, basis?.ledger);
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
  basis?: RollupBasis,
): RollupBodyV2 {
  if (!Array.isArray(projects) || projects.length === 0) throw new Error('economic team rollup projects must be a non-empty array');
  const canonicalProjects = projects.map(canonicalEconomicProject);
  const body: RollupBodyV2 = {
    v: 2,
    keyId: keys.keyId,
    generatedAt: new Date().toISOString(),
    period,
    coverage,
    scope: canonicalRollupScope(basis?.scope ?? UNKNOWN_ROLLUP_SCOPE),
    projects: canonicalProjects,
  };
  if (strata && strata.length > 0) body.strata = strata;
  assertMintable(body, basis?.ledger);
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

/** A scope with exactly the fields its kind licenses, so two equal claims canonicalize identically. */
function canonicalRollupScope(scope: RollupScope): RollupScope {
  const error = rollupScopeError(scope);
  if (error !== null) throw new Error(error);
  return scope.kind === 'project' ? { kind: 'project', project: scope.project! } : { kind: scope.kind };
}

/**
 * Read the signer-declared scope without upgrading legacy payloads, exactly as
 * `normalizeRollupCoverage` does for the other axis: absence — and an invalid
 * value on a payload that has not yet passed validation — is `unknown`, and
 * `validateRollupBody` still rejects an invalid explicit value.
 */
export function normalizeRollupScope(body: RollupBody): RollupScope {
  const value = (body as RollupBodyV1).scope;
  if (rollupScopeError(value) !== null) return UNKNOWN_ROLLUP_SCOPE;
  return value!.kind === 'project' ? { kind: 'project', project: value!.project! } : { kind: value!.kind };
}

/** Validate a scope claim on its own. Exported so the team server can check untrusted input with the same rule. */
export function rollupScopeError(scope: unknown): string | null {
  if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) {
    return 'team rollup scope must be an object stating what the rollup covers';
  }
  const candidate = scope as { kind?: unknown; project?: unknown };
  if (!ROLLUP_SCOPE_KINDS.includes(candidate.kind as RollupScopeKind)) {
    return 'team rollup scope.kind must be one of: all-projects, project, unknown';
  }
  if (candidate.kind === 'project') {
    if (typeof candidate.project !== 'string' || candidate.project.length === 0) {
      return 'team rollup scope.kind "project" must name the project it is scoped to';
    }
  } else if (candidate.project !== undefined) {
    return 'team rollup scope names a project but is not scoped to one';
  }
  return null;
}

/** Say what a scope claim means, in one sentence a reader of a total can act on. */
export function describeRollupScope(scope: RollupScope): string {
  if (scope.kind === 'all-projects') return 'the signer declares this covers every project on their machine';
  if (scope.kind === 'project') return `the signer declares this covers ONLY the project "${scope.project}" and not the rest of their machine`;
  return 'the signer did not say what this covers, so it must not be read as a whole snapshot';
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

function validateRollupScopeField(body: RollupBody): string | null {
  const value = (body as RollupBodyV1).scope;
  // Absent is the older-client shape and reads as `unknown`; an explicit value
  // that is not a scope is a malformed claim and is refused.
  if (value === undefined) return null;
  return rollupScopeError(value);
}

/** Validate v1/v2 project containment and v2 exact project lineage. */
export function validateRollupBody(body: RollupBody): string | null {
  if (body.v !== 1 && body.v !== 2) return 'economic team rollup body version is invalid';
  const coverageError = validateRollupCoverage(body);
  if (coverageError !== null) return coverageError;
  const scopeError = validateRollupScopeField(body);
  if (scopeError !== null) return scopeError;
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

/**
 * What the exact lineage carried by a body's constituents adds up to.
 *
 * A SIGNATURE MUST NOT UPGRADE PROVENANCE. A v2 body carries a per-project
 * `economic.coverage`, and an aggregate over them is only as strong as its
 * weakest member. Signing the aggregate authenticates the bytes; it says
 * nothing about the rows underneath, so the aggregate has to keep saying what
 * they said.
 *
 * `legacy_unknown` DOMINATES, and this deliberately differs from
 * `rollupSpendCoverage`, where `partial` outranks `unknown`. There, `partial`
 * is a positive statement about what IS missing and is the more useful thing to
 * tell a receiver. Here `legacy_unknown` means no exact lineage travels for
 * that project at all, and reporting `partial` over it would imply a lineage
 * exists to be partial about — upgrading a provenance sentinel from context,
 * which is the one thing this column exists to prevent.
 *
 * A v1 body reads as `legacy_unknown` for the same reason: it carries no exact
 * amounts, and absence of lineage is not weak lineage.
 */
export function rollupEconomicCoverage(body: RollupBody): 'exact' | 'partial' | 'legacy_unknown' {
  if (body.v !== 2) return 'legacy_unknown';
  const projects = body.projects as EconomicProjectValue[];
  if (!Array.isArray(projects) || projects.length === 0) return 'legacy_unknown';
  const states = projects.map((project) => project.economic?.coverage);
  if (states.some((state) => state !== 'exact' && state !== 'partial')) return 'legacy_unknown';
  if (states.some((state) => state === 'partial')) return 'partial';
  return 'exact';
}

/**
 * Does this body describe the ledger it claims to summarise?
 *
 * INTEGRITY IS NOT TRUTH. `validateRollupBody` asks whether the body agrees
 * with ITSELF; this asks whether it agrees with the meter that produced it, and
 * a signature answers neither question. Four checks, in the order a defect
 * would reach them:
 *
 *   THE WINDOW. A body whose period is not the window the ledger was read over
 *   states a period nobody measured — the union-read-as-coverage error D-164
 *   found one layer up, here at the source rather than in the aggregate.
 *
 *   THE CONSTITUENTS. Every project the body names must exist in the ledger
 *   with the same figures, and their exact sum must match the ledger's sum over
 *   the same rows. Compared as fixed-scale integers, never with a tolerance: a
 *   tolerance on a conservation check is somewhere for a real gap to hide, and
 *   the receiver forms this same sum.
 *
 *   THE SCOPE. `all-projects` is checked against the population actually in the
 *   ledger, so a filtered list cannot declare itself a snapshot — that is D-101
 *   caught at the mint rather than refused at the client. `project` must carry
 *   exactly the project it names. `unknown` claims nothing, so it is held only
 *   to the row-by-row match.
 *
 *   THE RETENTION FLOOR. A `complete` claim over a window that reaches behind a
 *   recorded deletion boundary is refused. This is D-170's class and this
 *   program's most-recorded defect: a signed rollup declaring complete coverage
 *   over spend that had been deleted (D-181) is a signature over an absence.
 *   The floor can only REFUSE a claim, never grant one — `retentionTruncates-
 *   Window: false` is not evidence of completeness, and this check treats it as
 *   nothing at all.
 *
 * Returns the first disagreement, or null. Pure, and takes evidence rather than
 * a store, so the team-server package can keep importing this file.
 */
export function rollupLedgerDisagreement(body: RollupBody, ledger: RollupLedgerEvidence): string | null {
  if (ledger === null || typeof ledger !== 'object' || !Array.isArray(ledger.projects)) {
    return 'team rollup ledger evidence must carry the projects the ledger holds';
  }
  if (body.period.from !== ledger.window.from || body.period.to !== ledger.window.to) {
    return `team rollup period ${body.period.from}..${body.period.to} is not the window the ledger was read over `
      + `(${ledger.window.from}..${ledger.window.to})`;
  }

  const held = new Map(ledger.projects.map((row) => [row.project, row]));
  let claimedTotal = 0n;
  let ledgerTotal = 0n;
  for (const project of body.projects) {
    const row = held.get(project.project);
    if (row === undefined) {
      return `team rollup names project "${project.project}", which the local ledger does not hold for this window`;
    }
    for (const field of ['units', 'costUsd', 'spendOnRealizedUnitsUsd', 'acceptanceWeightedSpendUsd'] as const) {
      if (exactMinorUnits(project[field], `${project.project}.${field}`) !== exactMinorUnits(row[field], `ledger ${project.project}.${field}`)) {
        return `team rollup project "${project.project}" reports ${field} ${project[field]}, and the local ledger holds ${row[field]}`;
      }
    }
    claimedTotal += exactMinorUnits(project.costUsd, `${project.project}.costUsd`);
    ledgerTotal += exactMinorUnits(row.costUsd, `ledger ${project.project}.costUsd`);
  }
  if (claimedTotal !== ledgerTotal) {
    return 'team rollup constituent costs do not sum to what the local ledger holds for the same projects';
  }

  const scope = normalizeRollupScope(body);
  const names = new Set(body.projects.map((project) => project.project));
  if (scope.kind === 'all-projects') {
    const missing = ledger.projects.map((row) => row.project).filter((name) => !names.has(name));
    if (missing.length > 0) {
      return 'team rollup declares scope all-projects but omits ' + missing.join(', ')
        + ' — a filtered rollup read as a whole snapshot erases the rest of this machine from every team total';
    }
  } else if (scope.kind === 'project') {
    if (names.size !== 1 || !names.has(scope.project!)) {
      return `team rollup declares scope project "${scope.project}" but carries ${[...names].join(', ') || 'no projects'}`;
    }
  }

  if (normalizeRollupCoverage(body) === 'complete' && ledger.retentionTruncatesWindow) {
    return 'team rollup claims complete coverage over a window that starts before the recorded retention boundary '
      + `${ledger.retentionPrunedBeforeMs} — the deleted rows are not in these totals, and a signature over an absence `
      + 'is still an absence';
  }
  return null;
}

/**
 * Refuse to MINT what the receiver would refuse to accept, and what the local
 * ledger does not support.
 *
 * `team-server/src/server.ts` calls `validateRollupBody` on every arriving
 * rollup and answers HTTP 400, and the builders called it on nothing, so a body
 * carrying a containment violation was constructed, signed with the developer's
 * own key, and only then bounced by a remote. A signature is a commitment:
 * committing to a self-contradiction and retracting it on a 400 is worse than
 * never committing. Checked here rather than at the push call site so a new
 * caller cannot re-inherit the hole by forgetting the guard.
 *
 * THE TWO CONTAINMENT CHECKS ARE DUPLICATED ON PURPOSE, and neither may be
 * deleted in favour of the other. This one exists so an invalid rollup is never
 * produced or signed. The server's exists because a server cannot trust a
 * client: the body it receives need never have passed through this builder at
 * all — `team-server/test/server.test.ts` models exactly that by mutating a
 * body after building it and signing the result. Removing the mint-side check
 * returns us to signing contradictions; removing the ingest-side check trusts
 * every future client that was not written here.
 *
 * The LEDGER check is one-sided by contrast: only the machine that holds the
 * ledger can perform it, so it exists here and nowhere else. That asymmetry is
 * why `coverage` and `scope` travel on the wire — the receiver cannot recompute
 * them, so it has to be told.
 *
 * An internal-consistency floor plus an agreement with the local meter, not a
 * claim the numbers are right. `coverage` and `scope` remain the signer's own
 * non-authoritative claims.
 */
function assertMintable(body: RollupBody, ledger?: RollupLedgerEvidence): void {
  const error = validateRollupBody(body);
  if (error !== null) throw new Error(`refusing to mint a team rollup that no receiver will accept: ${error}`);
  if (ledger === undefined) return;
  const disagreement = rollupLedgerDisagreement(body, ledger);
  if (disagreement !== null) throw new Error(`refusing to mint a team rollup the local ledger does not support: ${disagreement}`);
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
  /** The signer's non-authoritative scope claim; legacy absence is `unknown`, never `all-projects`. */
  scope: RollupScope;
  /**
   * The exact lineage the constituents carry, aggregated at its weakest member.
   * DERIVED from the signed body rather than signed itself: a receiver can
   * recompute it from rows that are already in the payload, and a second copy
   * inside the bytes could drift from the rows it summarises.
   */
  economicCoverage: 'exact' | 'partial' | 'legacy_unknown';
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
  // Read before any outcome is decided, so every return path carries the
  // signer's own claims unchanged -- including the failure paths, where a
  // reader most needs to know what was being claimed.
  const scope = normalizeRollupScope(rollup.body);
  const economicCoverage = rollupEconomicCoverage(rollup.body);

  let embeddedKeyId: string;
  try {
    embeddedKeyId = keyIdForPem(rollup.publicKey);
  } catch {
    return { valid: false, reason: 'unreadable public key', keyId: '', pinned: false, coverage, scope, economicCoverage };
  }

  if (sha256Hex(c) !== rollup.bodyHash) {
    return { valid: false, reason: 'body hash mismatch', keyId: embeddedKeyId, pinned: false, coverage, scope, economicCoverage };
  }
  if (rollup.keyId !== embeddedKeyId) {
    return { valid: false, reason: 'keyId does not match the embedded public key', keyId: embeddedKeyId, pinned: false, coverage, scope, economicCoverage };
  }

  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(rollup.publicKey);
  } catch {
    return { valid: false, reason: 'unreadable public key', keyId: embeddedKeyId, pinned: false, coverage, scope, economicCoverage };
  }
  const ok = cryptoVerify(null, Buffer.from(c), publicKey, Buffer.from(rollup.signature, 'base64'));
  if (!ok) return { valid: false, reason: 'signature mismatch', keyId: embeddedKeyId, pinned: false, coverage, scope, economicCoverage };

  const semanticError = validateRollupBody(rollup.body);
  if (semanticError !== null) return { valid: false, reason: semanticError, keyId: embeddedKeyId, pinned: false, coverage, scope, economicCoverage };

  let pinned = false;
  if (opts.trustedPublicKeyPem !== undefined) {
    if (normalizePem(opts.trustedPublicKeyPem) !== normalizePem(rollup.publicKey)) {
      return { valid: false, reason: 'signed by an untrusted key (public key does not match the pinned key)', keyId: embeddedKeyId, pinned: false, coverage, scope, economicCoverage };
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
        scope,
        economicCoverage,
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
    scope,
    economicCoverage,
  };
}
