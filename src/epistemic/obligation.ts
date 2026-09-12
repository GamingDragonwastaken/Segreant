/**
 * What a registered witness must CONTAIN before it discharges an obligation,
 * per kind — and, for most kinds, the statement that nothing checkable is
 * asked of it.
 *
 * `assessDerivationLegality` (derivation.ts) decides WHICH witness kinds a
 * step needs and matches them against the derivation's inline references by
 * kind alone. D-190 added, at the ledger, that the registered record must
 * also read `supported`. Neither asks whether the witness has anything to do
 * with the claims it bridges: a `causal_identification` grounded entirely in
 * some other study's evidence lifted this one, and `detail` is prose. This
 * module is the content check, and it runs against the REGISTERED `Witness`
 * (which is the record that carries `basisChange` and whose evidence the
 * ledger can resolve), not the inline reference — the same seam D-190 chose,
 * for the same reason: the inline reference declares the obligation, the
 * registered record is what can be held to it.
 *
 * ONLY WHAT THE RECORD TYPES CAN DECIDE IS AN OBLIGATION. Three kinds have
 * one. The rest are listed with `checked: false` and the reason, so a reader
 * finds "kind-only" stated by name rather than inferred from an absent case.
 * Inventing a content check for `integrity_attestation` that compared a free
 * string to a free string would be a fabricated obligation, and a fabricated
 * obligation is worse than an unstated one: it reads as verified.
 *
 * A witness that fails its obligation is SET ASIDE, not refused outright,
 * exactly as an unsupported witness is at D-190: legality is assessed without
 * it, and the refusal — if the step then needs the kind — names the witness
 * and what it failed to contain. A witness cited on a step that does not need
 * its kind is neither checked against that step nor able to block it.
 */

import type { Claim } from './claim.ts';
import type { Evidence } from './evidence.ts';
import type { DerivationWitnessKind } from './derivation.ts';
import type { Witness } from './witness.ts';

export type WitnessObligation =
  /** The kernel checks this content before the witness discharges. */
  | { readonly checked: true; readonly obligation: string }
  /** Kind-only. `why` says what a checkable obligation would need that the records do not carry. */
  | { readonly checked: false; readonly why: string };

const COORDINATE_OBLIGATION: WitnessObligation = Object.freeze({
  checked: true,
  obligation: 'carries `from`/`to` coordinates equal to the exact coordinates the step moves between; enforced by `assessCoordinateDerivation`, not here.',
});

/**
 * Every witness kind, and what it must contain. Exhaustive over
 * `DerivationWitnessKind` by type, so adding a kind without deciding its
 * obligation is a compile error rather than a silent kind-only default.
 */
export const WITNESS_OBLIGATIONS: Readonly<Record<DerivationWitnessKind, WitnessObligation>> = Object.freeze({
  grain_refinement: COORDINATE_OBLIGATION,
  grain_aggregation: COORDINATE_OBLIGATION,
  grain_bridge: COORDINATE_OBLIGATION,
  scope_filter: COORDINATE_OBLIGATION,
  scope_coverage: COORDINATE_OBLIGATION,
  scope_bridge: COORDINATE_OBLIGATION,
  causal_identification: Object.freeze({
    checked: true,
    obligation: 'cites at least one evidence record the output claim also cites: an identification is an identification OF the study whose effect it licenses.',
  }),
  measurement_validation: Object.freeze({
    checked: true,
    obligation: 'cites at least one evidence record whose `measurementModelRef` is the model the output claim asserts a rung for.',
  }),
  monetary_rebasing: Object.freeze({
    checked: true,
    obligation: 'carries a `basisChange` whose `from` is the input claim\'s monetaryBasis and whose `to` is the output claim\'s.',
  }),
  epistemic_resolution: Object.freeze({
    checked: false,
    why: 'the records do not say WHICH conflict was resolved or how; a resolution is a judgement with no typed field to compare against the claims either side.',
  }),
  coverage_witness: Object.freeze({
    checked: false,
    why: 'coverage is a property of the evidence corpus, and the witness carries no typed statement of what corpus it inspected; `Evidence.completeness` describes one record, not the set.',
  }),
  scope_validation: Object.freeze({
    checked: false,
    why: 'the scope-establishment rung has no typed referent on the witness to compare with the claim; it is not the coordinate scope, which the coordinate kinds already guard.',
  }),
  monetary_finality: Object.freeze({
    checked: false,
    why: 'finality is asserted by whoever closes the period; the witness carries no typed period or invoice reference to check against the claim.',
  }),
  integrity_attestation: Object.freeze({
    checked: false,
    why: 'an attestation names its method in `detail`, which is prose; the records carry no typed digest or method identifier to compare.',
  }),
  authenticity_attestation: Object.freeze({
    checked: false,
    why: 'same as integrity: the provider or signature it attests is named in prose, and nothing typed on the claim names what it should match.',
  }),
  decision_fitness: Object.freeze({
    checked: false,
    why: 'fitness is decided against a stated use in `claim-uses.ts`, and the witness carries no typed use identifier to compare with the claim\'s.',
  }),
});

export interface ObligationStep {
  readonly source: Claim;
  readonly output: Claim;
  /** Resolve a cited evidence id to its registered record, or `null` if none. */
  readonly evidence: (id: string) => Evidence | null;
}

export interface ObligationVerdict {
  readonly discharges: boolean;
  /** Null when it discharges; otherwise what the witness failed to contain, naming the witness. */
  readonly reason: string | null;
}

const DISCHARGES: ObligationVerdict = Object.freeze({ discharges: true, reason: null });

function refused(reason: string): ObligationVerdict {
  return Object.freeze({ discharges: false, reason });
}

/**
 * Does this registered witness contain what its kind obliges, for THIS step?
 *
 * Kind-only kinds always discharge here; the D-190 `supported` check and the
 * kind match in `assessDerivationLegality` are the whole of their obligation.
 * Coordinate kinds also discharge here, because `assessCoordinateDerivation`
 * already holds them to their coordinates and a second copy would drift.
 */
export function assessWitnessObligation(registered: Witness, step: ObligationStep): ObligationVerdict {
  switch (registered.kind) {
    case 'causal_identification': {
      const shared = registered.evidenceIds.some((id) => step.output.evidenceIds.includes(id));
      if (shared) return DISCHARGES;
      return refused(
        `${registered.id} cites no evidence that ${step.output.id} cites `
        + `(witness: ${registered.evidenceIds.join(', ')}; claim: ${step.output.evidenceIds.join(', ')})`,
      );
    }
    case 'measurement_validation': {
      const model = step.output.measurementModelRef;
      if (model === null) return refused(`${registered.id} validates a measurement but ${step.output.id} names no measurementModelRef`);
      const matching = registered.evidenceIds.some((id) => step.evidence(id)?.measurementModelRef === model);
      if (matching) return DISCHARGES;
      const cited = registered.evidenceIds.map((id) => `${id} -> ${step.evidence(id)?.measurementModelRef ?? 'null'}`);
      return refused(`${registered.id} cites no evidence collected under ${model} (cited: ${cited.join(', ')})`);
    }
    case 'monetary_rebasing': {
      const change = registered.basisChange;
      const from = step.source.profile.monetaryBasis;
      const to = step.output.profile.monetaryBasis;
      if (change === undefined) return refused(`${registered.id} names no basisChange`);
      if (change.from === from && change.to === to) return DISCHARGES;
      return refused(`${registered.id} declares ${change.from} -> ${change.to}, and this step moves ${from} -> ${to}`);
    }
    default:
      return DISCHARGES;
  }
}
