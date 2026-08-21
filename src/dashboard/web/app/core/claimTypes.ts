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
  /** The figure, when the layer is established. */
  valueUsd: number | null;
  /** Whether the evidence substantiates this claim at all. */
  established: boolean;
  /** What the figure rests on, or what is missing when it does not exist. */
  basis: string;
  /** What the operator would have to do to establish it. Only when unestablished. */
  nextStep?: string;
  /** The auditable long form of `basis`. Required — see the module comment. */
  inspection: ClaimInspection;
}
