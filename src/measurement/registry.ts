/**
 * Resolution of a `measurementModelRef` to the model it names.
 *
 * Evidence and Claim both carry `measurementModelRef` as free text, and
 * `claim()` requires it to be non-null once `profile.measurement` rises above
 * `proxy_unvalidated`. That rule checks that a reference was WRITTEN. Nothing
 * checked that it pointed anywhere, so naming a model and having one were the
 * same act: `measurementModelRef: 'no-such-model'` and a reference to a real,
 * validated, construct-matching model were indistinguishable to every consumer,
 * and so was a reference to a real model that measures something else entirely.
 *
 * That is construct laundering with a citation attached. The most valuable
 * reference to forge is a true one — Fiscus's only declared measurement model
 * is Git line retention, which its own author marked `artifact_persistence` and
 * `proxy_unvalidated`; cited behind a "developer productivity, validated"
 * figure it would have looked like provenance rather than the contradiction it
 * is.
 *
 * So this module answers one question and refuses to answer it permissively:
 * may a claim about construct C, asserting measurement strength S, cite this
 * reference? A reference that resolves to nothing is not weak backing, it is no
 * backing, and it never degrades quietly into the strength the caller wanted.
 *
 * The registry is an immutable value built from an explicit list rather than a
 * mutable global that boundaries write into as they load. A registry a caller
 * can add to at will is the same hole one indirection further out: whoever
 * needs a reference to resolve could make it resolve.
 *
 * WHAT THIS DOES NOT ESTABLISH. That a registered model's procedure really
 * measures the construct written on it. Construct validity is an argument made
 * by whoever declared the model and it is not mechanically checkable here.
 * This module only ensures that the argument exists, is reachable, and is not
 * read as stronger or as being about something other than what it says.
 */

import {
  assessMeasurementFitness,
  measurementModel,
  MEASUREMENT_VALIDATIONS,
  type MeasurementModel,
  type MeasurementValidation,
} from './model.ts';

export interface MeasurementRegistry {
  /** Registered references, sorted, so a caller can report what was available. */
  readonly ids: readonly string[];
  /** The model a reference names, or `null` when it names none. */
  resolve(ref: string): MeasurementModel | null;
}

export interface MeasurementBackingRequest {
  /** The reference as stored on the Evidence or Claim, `null` included. */
  readonly measurementModelRef: string | null;
  /** The construct the figure is being reported as measuring. */
  readonly requiredConstruct: string;
  /** The strength the citing claim asserts on its measurement axis. */
  readonly assertedValidation: MeasurementValidation;
}

export interface MeasurementBacking {
  readonly admissible: boolean;
  /** The resolved model, or `null` when the reference named nothing. */
  readonly model: MeasurementModel | null;
  readonly reasons: readonly string[];
}

/**
 * Build an immutable registry.
 *
 * Every entry is re-run through `measurementModel()` rather than trusted as
 * given. Models reach this point as plain objects — spread into wrappers, read
 * back from payloads, written as interface-shaped literals — and the structural
 * type is satisfied by anything with the right field names. A model whose
 * `validation` is a typo would otherwise be registered and then, at the fitness
 * gate, be judged on a string nobody validated.
 *
 * Registering the same model twice is a caller assembling overlapping lists and
 * is allowed; registering two DIFFERENT models under one reference is not,
 * because the reference would then denote whichever the assembly order picked.
 */
export function measurementRegistry(models: readonly MeasurementModel[]): MeasurementRegistry {
  const byId = new Map<string, MeasurementModel>();
  for (const candidate of models) {
    const canonical = measurementModel(candidate);
    const existing = byId.get(canonical.id);
    if (existing !== undefined && !sameModel(existing, canonical)) {
      throw new Error(`conflicting measurement models registered under id: ${canonical.id}`);
    }
    byId.set(canonical.id, canonical);
  }
  const ids = Object.freeze([...byId.keys()].sort());
  return Object.freeze({
    ids,
    resolve(ref: string): MeasurementModel | null {
      return byId.get(ref) ?? null;
    },
  });
}

function sameModel(a: MeasurementModel, b: MeasurementModel): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * May a claim about `requiredConstruct`, asserting `assertedValidation`, cite
 * this reference?
 *
 * A null reference is admissible only for `proxy_unvalidated`, matching the
 * rule `claim()` already enforces. That case is not an oversight left open: a
 * claim asserting nothing on the measurement axis is not reporting one
 * construct as another, and refusing it would force every honest weak boundary
 * in the codebase to invent a model in order to keep working — the laundering
 * incentive pointed the other way.
 *
 * A reference that IS given is checked whatever the asserted strength, because
 * a proxy_unvalidated figure that cites a model measuring a different construct
 * is still reporting the wrong thing, just without the extra claim to strength.
 */
export function assessMeasurementBacking(
  registry: MeasurementRegistry,
  request: MeasurementBackingRequest,
): MeasurementBacking {
  if (!MEASUREMENT_VALIDATIONS.includes(request.assertedValidation)) {
    throw new Error(`invalid asserted measurement validation: ${String(request.assertedValidation)}`);
  }

  const ref = typeof request.measurementModelRef === 'string' ? request.measurementModelRef.trim() : null;
  if (ref === null || ref.length === 0) {
    if (request.assertedValidation === 'proxy_unvalidated') {
      return Object.freeze({ admissible: true, model: null, reasons: Object.freeze([]) });
    }
    return Object.freeze({
      admissible: false,
      model: null,
      reasons: Object.freeze([
        `claim asserts ${request.assertedValidation} measurement but names no measurement model`,
      ]),
    });
  }

  const model = registry.resolve(ref);
  if (model === null) {
    return Object.freeze({
      admissible: false,
      model: null,
      reasons: Object.freeze([
        `measurement model ref ${ref} resolves to no registered measurement model`,
      ]),
    });
  }

  // A `proxy_unvalidated` assertion still has to name the right construct, but
  // asking `assessMeasurementFitness` for construct FITNESS at that strength
  // would always fail — an unvalidated proxy establishes no construct, which is
  // the point of the axis. So the weak case checks identity only.
  if (request.assertedValidation === 'proxy_unvalidated') {
    const requiredConstruct = request.requiredConstruct.trim();
    if (requiredConstruct.length === 0) throw new Error('measurement required construct must be non-empty');
    const reasons = model.targetConstruct === requiredConstruct
      ? []
      : [`construct mismatch: model targets ${model.targetConstruct}, claim requires ${requiredConstruct}`];
    return Object.freeze({ admissible: reasons.length === 0, model, reasons: Object.freeze(reasons) });
  }

  const fitness = assessMeasurementFitness(model, {
    requiredConstruct: request.requiredConstruct,
    requiredValidation: request.assertedValidation,
  });
  return Object.freeze({ admissible: fitness.fitForConstructClaim, model, reasons: fitness.reasons });
}

/**
 * The refusing form, for boundaries that must not proceed on an inadmissible
 * citation. Returns the resolved model so a caller can record what it actually
 * relied on, and `null` for the one admissible unbacked case.
 */
export function assertMeasurementBacking(
  registry: MeasurementRegistry,
  request: MeasurementBackingRequest,
): MeasurementModel | null {
  const backing = assessMeasurementBacking(registry, request);
  if (!backing.admissible) {
    throw new Error(`inadmissible measurement backing: ${backing.reasons.join('; ')}`);
  }
  return backing.model;
}
