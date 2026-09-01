/**
 * The shape of a claim, and the shape of its evidence.
 *
 * These types live in `core/` rather than beside the spine that renders them,
 * because two independent things need them and neither should have to reach
 * into a component to get one: `core/claimLayers.ts` derives them from the
 * payloads, and `components/claimInspector.ts` displays them. A core module
 * importing a component to borrow a type is a layering inversion that only ever
 * gets worse, so the type lives below both. `components/spine.ts` re-exports
 * them, so nothing that already imported `Layer` from there had to change.
 *
 * `ClaimInspection` is the part worth explaining. This product's whole position
 * is that a figure which cannot say where it came from should not ship — and a
 * band reading "$89.66 · counted from requests" states a basis in six words,
 * which is enough to orient and not enough to audit. The inspection is the
 * audit: the same claim answered along the six dimensions that decide whether
 * an operator can actually rely on it, plus what it is assuming and what
 * evidence it does not have. Every field is REQUIRED and every field is a
 * string, so there is no such thing as a claim that declines to answer one of
 * them. Where a dimension is not established, the honest string says so —
 * "not established", "no reconciled provider scope" — because a blank renders
 * identically to a dimension nobody thought about.
 */

export type LayerId = 'metered' | 'billed' | 'allocated' | 'realized';

/**
 * The axes a layer's support is stated on (AII-014, WP-B02, WP-B04).
 *
 * These are no longer a hand-written mirror. WP-B02 wrote them out here and
 * `test/claim-support-axes.test.ts` checked them against `src/epistemic/`; the
 * axes are now on the WIRE, so the browser imports the generated copy of the
 * canonical payload source instead and there is nothing here left to drift.
 * `src/dashboard/shared-types.ts` is the one remaining mirror of the kernel
 * vocabularies — it must not import, because the build copies it verbatim into
 * this compiler root — and the drift test now reads that file.
 */
export type {
  ClaimEpistemicState as LayerEpistemicState,
  ClaimCoverageStatus as LayerCoverage,
  ClaimMonetaryBasis as LayerMonetaryBasis,
  ClaimFigureStatus as LayerFigure,
} from './generated-types.ts';

import type { ClaimSupportPayload, ClaimFigureStatus } from './generated-types.ts';

/**
 * What the evidence for one layer actually reaches.
 *
 * This replaces a single `established: boolean`, which stood for three different
 * questions at once — is the claim supported, is there a figure, and should the
 * operator be shown a next step — and answered all three with one bit.
 * `src/epistemic/profile.ts` opens by saying a claim is never reduced to
 * `established: boolean`; the spine was doing it anyway.
 *
 * There is deliberately no score here. Replacing one boolean with a number
 * between 0 and 1 is the same collapse with a decimal point.
 *
 * The SERVER decides these now. What is left in the browser is the one judgement
 * the server cannot make about itself: what a claim's support is when the
 * endpoint that would have stated it did not answer.
 */
export type LayerSupport = ClaimSupportPayload;

/**
 * The support of a claim whose endpoint did not answer.
 *
 * `unknown` is the whole of the honest answer — a dead endpoint is an absence of
 * evidence, never a measured zero — and each layer keeps its own `figure`,
 * because whether a band ever carries a dollar is a property of the claim rather
 * than of whether the fetch succeeded.
 */
export function unreachableSupport(figure: ClaimFigureStatus): LayerSupport {
  return { epistemic: 'unknown', coverage: 'unknown', monetaryBasis: 'none', figure };
}

/**
 * Does evidence support this claim? A specific predicate over one named axis —
 * not a revival of the collapsed boolean, which also decided figure rendering
 * and next-step display.
 */
export function claimIsSupported(layer: Layer): boolean {
  return layer.support.epistemic === 'supported';
}

/**
 * Does the evidence CONTRADICT itself? Distinct from unsupported, and the
 * distinction is the whole reason the axis is four-valued: an absence of
 * evidence and two sources that disagree are opposite situations, and the
 * sentence "an absence of evidence, never a measured zero" is false about the
 * second one. Reachable since the axes moved to the wire — the browser's old
 * two-branch inference had no state that could say it.
 */
export function claimIsConflicted(layer: Layer): boolean {
  return layer.support.epistemic === 'conflicted';
}

/** Is the claim REFUTED — a measured no, rather than nothing measured? */
export function claimIsRefuted(layer: Layer): boolean {
  return layer.support.epistemic === 'refuted';
}

/** Is the claim simply unevidenced? The only case that is an absence. */
export function claimIsUnevidenced(layer: Layer): boolean {
  return layer.support.epistemic === 'unknown';
}

/** Is the operator being shown a number? A different question from the above. */
export function claimShowsFigure(layer: Layer): boolean {
  return layer.support.figure === 'shown';
}

/**
 * Supported, but no figure because something needed to price it is missing.
 * The case the old boolean reported as "not established", which reads to an
 * operator as "your work produced nothing".
 */
export function claimIsSupportedButUncosted(layer: Layer): boolean {
  return layer.support.epistemic === 'supported' && layer.support.figure === 'withheld_uncosted';
}

export interface ClaimInspection {
  /** Where the underlying evidence physically came from. */
  provenance: string;
  /** What the claim covers — the window, the entities, the run it belongs to. */
  scope: string;
  /** When it was computed or observed. Never inferred from "now". */
  freshness: string;
  /** How much of the thing being claimed the evidence actually reaches. */
  coverage: string;
  /**
   * What the claim can and cannot make happen. This dimension exists because
   * three of the four claims are routinely read as controls that they are not:
   * metering is not a cap, allocation is showback rather than chargeback, and
   * realized value is never evidence that a budget held.
   */
  enforceability: string;
  /** The named source an auditor would go to in order to re-derive this. */
  evidenceSource: string;
  /** What is being taken on trust — including provider-report conditions. */
  assumptions: string[];
  /** What would have to exist for this claim to be established, or stronger. */
  missingEvidence: string[];
}

export interface Layer {
  id: LayerId;
  /** What the claim is called. */
  label: string;
  /** The claim itself, in one line, in the operator's words. */
  claim: string;
  /** The figure, when there is one. See `support.figure` for why there is not. */
  valueUsd: number | null;
  /** What the evidence reaches, on the axes that decide it. Never one boolean. */
  support: LayerSupport;
  /** What the figure rests on, or what is missing when it does not exist. */
  basis: string;
  /** What the operator would have to do to establish or price it. */
  nextStep?: string;
  /** The auditable long form of `basis`. Required — see the module comment. */
  inspection: ClaimInspection;
}
