/**
 * Measurement models make the bridge from observable to construct explicit.
 * Precision is one property of a measurement; it cannot validate the construct
 * being measured or turn an unvalidated surrogate into the target itself.
 */

import type { Scope } from '../epistemic/scope.ts';
import type { TimeInterval } from '../epistemic/time.ts';

/**
 * Ordered weakest-first, and the order is load-bearing rather than cosmetic:
 * `mergeClaimProfiles` already treats the identical `MEASUREMENT` axis as a
 * ladder, so a fitness gate that recognises only the bottom rung is disagreeing
 * with the kernel about what these words mean.
 */
export const MEASUREMENT_VALIDATIONS = ['proxy_unvalidated', 'proxy_validated', 'validated'] as const;
export type MeasurementValidation = (typeof MEASUREMENT_VALIDATIONS)[number];

function validationRank(value: unknown): number {
  return MEASUREMENT_VALIDATIONS.indexOf(value as MeasurementValidation);
}

export type MeasurementUncertainty =
  | { readonly kind: 'none'; readonly description: string }
  | { readonly kind: 'bounded'; readonly description: string; readonly bound: string }
  | { readonly kind: 'statistical'; readonly description: string; readonly standardError: number };

export interface MeasurementModelInput {
  readonly id: string;
  readonly targetConstruct: string;
  readonly measurand: string;
  readonly observable: string;
  readonly procedure: string;
  readonly scope: Scope;
  readonly population: string;
  readonly validation: MeasurementValidation;
  readonly calibration: string | null;
  readonly uncertainty: MeasurementUncertainty;
  readonly validTime?: TimeInterval;
}

export type MeasurementModel = Readonly<MeasurementModelInput>;

export interface MeasurementFitnessRequirement {
  readonly requiredConstruct: string;
  /**
   * The measurement strength the CALLER intends to assert, not the strength the
   * model happens to carry. Omitting it asks the strongest question — may this
   * model stand behind a `validated` claim about the construct — because the
   * permissive reading is the one that lets a surrogate be reported as the
   * target.
   */
  readonly requiredValidation?: MeasurementValidation;
}

export interface MeasurementFitness {
  readonly fitForConstructClaim: boolean;
  readonly reasons: readonly string[];
}

function nonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`measurement ${label} must be non-empty`);
  return normalized;
}

export function measurementModel(input: MeasurementModelInput): MeasurementModel {
  const id = nonEmpty(input.id, 'id');
  const targetConstruct = nonEmpty(input.targetConstruct, 'target construct');
  const measurand = nonEmpty(input.measurand, 'measurand');
  const observable = nonEmpty(input.observable, 'observable');
  const procedure = nonEmpty(input.procedure, 'procedure');
  const population = nonEmpty(input.population, 'population');

  if (validationRank(input.validation) < 0) {
    throw new Error(`invalid measurement validation: ${String(input.validation)}`);
  }
  if (input.uncertainty.description.trim().length === 0) throw new Error('measurement uncertainty description must be non-empty');
  if (input.uncertainty.kind === 'bounded' && input.uncertainty.bound.trim().length === 0) {
    throw new Error('bounded measurement uncertainty requires a non-empty bound');
  }
  if (input.uncertainty.kind === 'statistical' && (!Number.isFinite(input.uncertainty.standardError) || input.uncertainty.standardError < 0)) {
    throw new Error('measurement standard error must be finite and non-negative');
  }

  return Object.freeze({
    id,
    targetConstruct,
    measurand,
    observable,
    procedure,
    scope: input.scope,
    population,
    validation: input.validation,
    calibration: input.calibration,
    uncertainty: Object.freeze({ ...input.uncertainty }),
    ...(input.validTime ? { validTime: input.validTime } : {}),
  });
}

/**
 * May this model stand behind a claim about `requiredConstruct` at the strength
 * the caller intends to assert?
 *
 * Two things this gate used to get wrong, and both were the same mistake — a
 * strength granted because a field was populated rather than because it was
 * checked.
 *
 * IT TESTED ONLY THE BOTTOM RUNG. The single condition was
 * `validation === 'proxy_unvalidated'`, so any other value passed. A model that
 * never went through `measurementModel()` — reconstituted from a stored row, a
 * payload, or an interface-shaped literal, which is every model that crosses a
 * boundary — could carry a typo, a legacy spelling, or nothing at all in
 * `validation` and be declared construct-fit on the strength of not matching
 * one string. An unrecognised validation is now the same answer as an
 * unvalidated one, because a model that cannot state how it was validated has
 * not told us it was.
 *
 * IT COLLAPSED THE TOP TWO RUNGS. `proxy_validated` means a surrogate whose
 * relationship to the construct has been checked; `validated` means the
 * construct itself was measured. They are not interchangeable, and the gate
 * returned an unqualified yes for both — so a caller intending to stamp
 * `measurement: 'validated'` on a claim was told a validated surrogate would
 * do. That is construct laundering with the kernel's own vocabulary: a
 * survival ratio reported as value, a token count reported as effort. The
 * requirement now carries the strength being asserted and the model must reach
 * it.
 *
 * What this still does NOT establish: that the model's procedure actually
 * measures what its `targetConstruct` says it does. Construct validity is an
 * argument made by whoever declared the model; this function only refuses to
 * let a declaration be read as stronger than it is.
 */
export function assessMeasurementFitness(
  model: MeasurementModel,
  requirement: MeasurementFitnessRequirement,
): MeasurementFitness {
  const requiredConstruct = nonEmpty(requirement.requiredConstruct, 'required construct');
  const requiredValidation = requirement.requiredValidation ?? 'validated';
  if (validationRank(requiredValidation) < 0) {
    throw new Error(`invalid required measurement validation: ${String(requiredValidation)}`);
  }

  const reasons: string[] = [];
  if (model.targetConstruct !== requiredConstruct) {
    reasons.push(`construct mismatch: model targets ${model.targetConstruct}, claim requires ${requiredConstruct}`);
  }

  const modelRank = validationRank(model.validation);
  if (modelRank < 0) {
    reasons.push(`unrecognized measurement validation: ${String(model.validation)}; a model that cannot state how it was validated establishes nothing`);
  } else if (model.validation === 'proxy_unvalidated') {
    reasons.push('unvalidated proxy cannot establish the target construct regardless of statistical precision');
  } else if (modelRank < validationRank(requiredValidation)) {
    reasons.push(`measurement strength escalation: model is ${model.validation}, claim asserts ${requiredValidation}`);
  }

  return Object.freeze({ fitForConstructClaim: reasons.length === 0, reasons: Object.freeze(reasons) });
}
