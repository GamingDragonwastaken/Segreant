/**
 * ISSUANCE CLASS: display_only — see `src/epistemic/issuance-map.ts`. This
 * states, on named axes, what the payload-building code already knows about its
 * own evidence. It issues nothing and must never be the first place a stronger
 * claim appears; where it cannot tell, it says `unknown`.
 *
 * WHY THIS IS SERVER-SIDE (AII-014, WP-B02's remainder).
 *
 * WP-B02 gave the GUI four named support axes in place of one
 * `established: boolean`. It did not move the JUDGEMENT: the browser went on
 * inferring the axes from whatever collapsed field the payload happened to
 * carry — a count of runs, a share of estimated spend, whether a ratio said
 * `usd`. The axes reached the projection and not the wire, and the server, which
 * holds the evidence, said nothing at all about its own claims.
 *
 * Three consequences, each found by reading the payload against the derivation
 * rather than by reasoning about it:
 *
 *   THE INFERENCE COULD NOT REACH `conflicted`. Every browser derivation was a
 *   two-branch ternary over a count. A reconciliation whose provider snapshots
 *   changed between observations — `changed_across_observations`, disclosed by
 *   `reconcileOpenAiCosts` and printed by the CLI — rendered on the spine
 *   exactly like one whose snapshots agreed. The field was on the wire and
 *   undeclared, so the browser could not have read it if it had wanted to.
 *
 *   AN EMPTY LEDGER REPORTED COMPLETE PRICING COVERAGE. `estimatedSpendShare`
 *   is 0 when there is no spend to price, so `share > 0 ? partial : complete`
 *   answered `complete` for a window with nothing in it. A completeness claim
 *   with no evidence behind it is the defect D-067 and D-069 exist to refuse,
 *   one axis over.
 *
 *   NOTHING BUT THE BROWSER GOT AN ANSWER. The CLI, a script, anything reading
 *   `/api/*` had to repeat the guesswork with nothing holding the two versions
 *   in agreement.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO. It does not decide whether the
 * endpoint answered. A server cannot state the support of a payload it never
 * sent, so "unreachable" stays a browser-side fact, and `core/claimLayers.ts`
 * supplies it. Nor does it write the operator-facing prose: the basis line, the
 * next step and the inspection stay where they can be read next to the pixels.
 *
 * A POPULATION OF CONTRADICTIONS IS NOT A CONTRADICTION IN THE AGGREGATE. This
 * distinction decides two of the four claims below and is worth stating once.
 * `informationJoin` combines two observations OF ONE PROPOSITION: the provider
 * said $8 for Tuesday and later said $10, so the claim about Tuesday is
 * `conflicted`. Twelve mature units whose gate evidence contradicted itself is
 * not that. Those are twelve different propositions, and joining them would
 * paint the aggregate with a state none of its parts asserts about it. The
 * honest reading is that the aggregate is SUPPORTED by the units that
 * adjudicated and does not REACH the ones that did not — coverage, not
 * epistemic state. So billing conflict lands on `epistemic` and realization
 * conflict lands on `coverage`, and the difference is the point rather than an
 * inconsistency.
 */

import type { ClaimProfilePayload, ClaimSupportPayload } from './shared-types.ts';

/**
 * The seven axes that do not vary, and why stating them is the point.
 *
 * Every canonical boundary under `src/` declares the same values on these axes
 * for every claim it issues: locally verified arithmetic and lineage, a Fiscus
 * assertion rather than a provider-authenticated one, a scope conditional on
 * this ledger, a measurement model never validated against a provider
 * statement, no causal identification, nothing final, and no decision-fitness
 * assessment. The dashboard's claims are those same claims, so they carry the
 * same values.
 *
 * Constancy is the reason to SEND them, not a reason to omit them. An operator
 * reading a cost spine has no way to discover from four varying axes that no
 * figure on the page is causal or final, and those are the two things a FinOps
 * reader most reliably assumes. The moment one of them does vary -- the causal
 * lane already issues `randomized` through `src/causal/epistemic.ts` -- the
 * difference has somewhere to appear instead of being flattened on the wire.
 */
const PRODUCT_CLAIM_AXES = {
  authenticity: 'self_asserted',
  scope: 'conditional',
  measurement: 'proxy_unvalidated',
  causality: 'none',
  finality: 'provisional',
  decisionFitness: 'not_assessed',
} as const;

/**
 * Build the payload from the profile.
 *
 * The three shared axes are copied, and that identity is the whole contract: the
 * spine reads a projection OF the claim's profile, never a second statement
 * beside it. `test/claim-support-axes.test.ts` asserts it, so an edit that lets
 * the spine's coverage differ from the claim's coverage fails rather than
 * quietly reintroducing the collapse WP-B02 removed.
 *
 * `figure` is passed separately because it is a rendering decision -- whether
 * the band shows a number -- and the kernel has no axis for that. Folding it
 * into the profile would be a display concern claiming epistemic authority.
 */
function projectClaimSupport(
  profile: ClaimProfilePayload,
  figure: ClaimSupportPayload['figure'],
  note?: string,
): ClaimSupportPayload {
  return {
    profile,
    epistemic: profile.epistemic,
    coverage: profile.coverage,
    monetaryBasis: profile.monetaryBasis,
    figure,
    ...(note === undefined ? {} : { note }),
  };
}

export interface MeteredSupportInput {
  /** Cost priced from a rate card the matcher actually matched, plus estimates. */
  readonly totalCostUsd: number;
  readonly estimatedCostUsd: number;
}

/**
 * Metered is the one claim whose figure IS the claim: if the ledger read, there
 * is a priced count. Coverage asks a narrower question than an operator might
 * hope — how much of the SPEND IN THIS LEDGER was priced from a matched rate
 * card rather than an estimate. It says nothing about whether the ledger sees
 * every request the organisation made, which no local evidence can establish.
 */
export function meteredClaimSupport(input: MeteredSupportInput): ClaimSupportPayload {
  const priced = input.totalCostUsd > 0;
  const estimatedShare = priced ? input.estimatedCostUsd / input.totalCostUsd : null;
  return projectClaimSupport(
    {
      ...PRODUCT_CLAIM_AXES,
      epistemic: 'supported',
      // Alone among the four, metered has no canonical kernel boundary behind
      // it: it is a read of the request ledger, and nothing digests those rows
      // or re-reads them to confirm they are unaltered. `verified` here would be
      // borrowed from the boundaries that earned it.
      integrity: 'unknown',
      // No priced spend means no pricing evidence, not complete pricing. The
      // share-based test this replaces answered `complete` for an empty window.
      coverage: estimatedShare === null ? 'unknown' : estimatedShare > 0 ? 'partial' : 'complete',
      monetaryBasis: estimatedShare === null ? 'none' : estimatedShare > 0 ? 'mixed' : 'list',
    },
    'shown',
    priced ? undefined : 'no priced spend in this window, so pricing coverage is unevidenced rather than complete',
  );
}

export interface BilledSupportInput {
  readonly recordCount: number;
  readonly runCount: number;
  /** The newest recorded run, or null. Runs are immutable: evidence, not a computation. */
  readonly latest: {
    readonly snapshotStability?: string;
    readonly unstableDayStartMs?: readonly number[];
    readonly offPathBound?: string;
  } | null;
}

/**
 * Billed is established by a recorded reconciliation run, never by holding a
 * provider bill: an imported file nobody compared against anything proves only
 * that a file was read.
 *
 * The `conflicted` branch is the one that could not previously be expressed.
 * Repeated observations of the same provider days that disagree are two
 * observations of one proposition, so the claim is contradicted rather than
 * established — and reporting it as `supported` is the collapse WP-B03 removed
 * from the gate ladder, still standing on the billing claim.
 */
export function billedClaimSupport(input: BilledSupportInput): ClaimSupportPayload {
  if (input.runCount <= 0) {
    return projectClaimSupport(
      {
        ...PRODUCT_CLAIM_AXES,
        epistemic: 'unknown',
        // No run means no immutable, digest-identified record to verify.
        integrity: 'unknown',
        // Records held but never compared is visible non-emptiness about a claim
        // that is still unknown — which is what tells an operator the next step
        // is theirs, rather than that there is nothing to work with.
        coverage: input.recordCount > 0 ? 'partial' : 'unknown',
        monetaryBasis: 'none',
      },
      'not_a_money_claim',
    );
  }

  const unstable = input.latest?.snapshotStability === 'changed_across_observations';
  const days = input.latest?.unstableDayStartMs ?? [];
  // D-068: a residual below zero refutes the condition under which it bounds
  // off-path spend at all, so the reconciled scope is not established to reach
  // what the provider charged.
  const boundsNothing = input.latest?.offPathBound === 'none_local_estimate_exceeds_provider';

  return projectClaimSupport(
    {
      ...PRODUCT_CLAIM_AXES,
      epistemic: unstable ? 'conflicted' : 'supported',
      // Matches the canonical billing reconciliation boundary: the run is
      // immutable and identified by the digest of the result it describes, so it
      // cannot outlive a change to that result.
      integrity: 'verified',
      coverage: boundsNothing ? 'partial' : 'complete',
      monetaryBasis: 'billed',
    },
    // An evidence claim about whether a comparison happened, not a second cost
    // figure. The band carries no dollar in any branch.
    'not_a_money_claim',
    unstable
      ? `provider snapshots disagreed on ${days.length} day(s) of this scope`
      : boundsNothing
        ? 'the local estimate exceeds the provider total, so the residual bounds no off-path spend'
        : undefined,
  );
}

export interface AllocatedSupportInput {
  readonly costCentreCount: number;
  readonly runCount: number;
}

/**
 * Allocation is showback: the claim is whose cost it is, not how much, so the
 * band never carries a dollar. Cost centres defined with no run recorded is
 * partial coverage of a claim that is still unknown — nothing has been
 * apportioned, and nothing says it cannot be.
 */
export function allocatedClaimSupport(input: AllocatedSupportInput): ClaimSupportPayload {
  const run = input.runCount > 0;
  return projectClaimSupport(
    {
      ...PRODUCT_CLAIM_AXES,
      epistemic: run ? 'supported' : 'unknown',
      // Matches the canonical exact-allocation boundary, whose run identity is
      // digest-derived -- but only once a run exists. Cost centres verify
      // nothing on their own.
      integrity: run ? 'verified' : 'unknown',
      coverage: run ? 'complete' : input.costCentreCount > 0 ? 'partial' : 'unknown',
      monetaryBasis: run ? 'allocated' : 'none',
    },
    'not_a_money_claim',
  );
}

export interface RealizedSupportInput {
  readonly maturedUnits: number;
  readonly realizedUnits: number;
  /** Per-gate count of mature units whose evidence contradicted itself (AII-003). */
  readonly gateConflicts: Readonly<Record<string, number>> | null;
  /** RoI lens coverage, or null when it could not be computed. */
  readonly roiCoverage: number | null;
  /** Whether a priced value figure exists — `basis: 'usd'` and a number with it. */
  readonly valued: boolean;
}

/**
 * Realized value counts only MATURED units that actually shipped, and its figure
 * is the VALUE produced rather than the spend attributed to it.
 *
 * Two separate holes land on `coverage` here, and they stay separate in the
 * prose the browser writes: the RoI lens may not reach every unit, and some
 * mature units may hold contradicted gate evidence. A conflicted unit does not
 * realize — `serialRealization` requires an empty conflict set independently of
 * the three-valued projection — so contradictions do not corrupt the figure.
 * They mean the aggregate under-counts by an unadjudicated amount, which is a
 * claim that does not reach everything it covers rather than a claim its own
 * evidence contradicts. See the module comment.
 */
export function realizedClaimSupport(input: RealizedSupportInput): ClaimSupportPayload {
  const conflicted = Object.entries(input.gateConflicts ?? {}).filter(([, n]) => n > 0);
  const conflictedUnits = conflicted.reduce((sum, [, n]) => sum + n, 0);
  const supported = input.realizedUnits > 0;

  return projectClaimSupport(
    {
      ...PRODUCT_CLAIM_AXES,
      epistemic: supported ? 'supported' : 'unknown',
      // Matches the canonical coding-realization boundary once a unit has
      // realized; with none, there is no issued record whose lineage was
      // verified.
      integrity: supported ? 'verified' : 'unknown',
      coverage:
        conflicted.length > 0
          ? 'partial'
          : typeof input.roiCoverage !== 'number'
            ? 'unknown'
            : input.roiCoverage >= 1
              ? 'complete'
              : 'partial',
      monetaryBasis: input.valued ? 'estimated' : 'none',
    },
    !supported ? 'withheld_unsupported' : input.valued ? 'shown' : 'withheld_uncosted',
    conflicted.length > 0
      ? `${conflictedUnits} mature unit(s) hold contradicted gate evidence at ${conflicted
        .map(([gate]) => gate)
        .join(', ')} and are unadjudicated rather than refuted`
      : undefined,
  );
}
