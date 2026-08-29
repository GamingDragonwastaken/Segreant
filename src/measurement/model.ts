/**
 * Measurement models make the bridge from observable to construct explicit.
 * Precision is one property of a measurement; it cannot validate the construct
 * being measured or turn an unvalidated surrogate into the target itself.
 */

import type { Scope } from '../epistemic/scope.ts';
import type { TimeInterval } from '../epistemic/time.ts';

export type MeasurementValidation = 'proxy_unvalidated' | 'proxy_validated' | 'validated';

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

  if (!['proxy_unvalidated', 'proxy_validated', 'validated'].includes(input.validation)) {
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

export function assessMeasurementFitness(
  model: MeasurementModel,
  requirement: MeasurementFitnessRequirement,
): MeasurementFitness {
  const requiredConstruct = nonEmpty(requirement.requiredConstruct, 'required construct');
  const reasons: string[] = [];
  if (model.targetConstruct !== requiredConstruct) {
    reasons.push(`construct mismatch: model targets ${model.targetConstruct}, claim requires ${requiredConstruct}`);
  }
  if (model.validation === 'proxy_unvalidated') {
    reasons.push('unvalidated proxy cannot establish the target construct regardless of statistical precision');
  }
  return Object.freeze({ fitForConstructClaim: reasons.length === 0, reasons: Object.freeze(reasons) });
}
