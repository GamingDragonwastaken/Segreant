/**
 * The bridge between a surrogate and the construct it stands in for.
 *
 * `proxy_validated` is the middle rung of the measurement ladder and it reads,
 * in words, as "this surrogate's relationship to the construct has been
 * checked". Nothing recorded WHAT was checked, against what, in which
 * direction, or how strongly — the rung was granted because the string was
 * written. Measured against the tree before this module existed, a
 * `proxy_validated` model cited for its target construct was admissible with
 * zero reasons and no field anywhere holding the argument that licensed it.
 *
 * That is the same shape as the two holes D-146 closed one file over, and it is
 * the last one in this subsystem: a reference that pointed nowhere, a
 * validation string nobody recognised, and now a relationship nobody stated.
 *
 * WHAT A BRIDGE IS. A declared record of the argument that a movement in the
 * surrogate says something about the target: its direction, the basis of the
 * claim, the failure modes its author already knows about, and whether it is
 * currently contested. It is a CEILING on how a surrogate may be read and never
 * a promotion — `assessBridgedMeasurementBacking` can only lower the strength a
 * model's own author declared, never raise it.
 *
 * NO BRIDGE EVER REACHES `validated`. That rung means the construct itself was
 * measured; a surrogate that became the construct would no longer be a
 * surrogate. `bridgeCeiling` therefore tops out at `proxy_validated` for every
 * combination of direction, basis and status, and a test enumerates all
 * twenty-seven of them.
 *
 * PRE-REGISTRATION IS NOT VALIDATION, and this is the load-bearing judgement of
 * the module rather than a detail. Fixing a metric before collection defends
 * against choosing it after seeing the data; it says nothing about whether the
 * metric measures the construct. `src/causal/epistemic.ts` offers exactly that
 * basis for its two `proxy_validated` claims, so calling it validation would
 * have laundered the repository's own strongest surrogate claims through this
 * module on the day it was written.
 *
 * WHAT THIS DOES NOT ESTABLISH. That a bridge's argument is true. An
 * `empirical_association` bridge is checked for the SHAPE of its evidence — a
 * reference measurement that resolves, is itself directly validated, and
 * measures the same construct — and not for the strength, sign, or
 * reproducibility of the association it asserts. A registered bridge whose
 * sample is three observations and whose association is noise passes every gate
 * here. What the module refuses is a surrogate read as its target with no
 * stated relationship at all, or with one that its own declaration cannot
 * support.
 */

import { MEASUREMENT_VALIDATIONS, type MeasurementModel, type MeasurementValidation } from './model.ts';
import { assessMeasurementBacking, type MeasurementRegistry } from './registry.ts';
import type { TimeInterval } from '../epistemic/time.ts';

/**
 * Which way the surrogate is claimed to move with the target. `unknown_direction`
 * is an honest declaration and not a default: a bridge that cannot say which way
 * the surrogate moves licenses no reading of any movement in it, so it is capped
 * at the bottom rung rather than refused — refusing it would push an author
 * toward guessing a direction.
 */
export const SURROGATE_DIRECTIONS = ['increases_with_target', 'decreases_with_target', 'unknown_direction'] as const;
export type SurrogateDirection = (typeof SURROGATE_DIRECTIONS)[number];

export const SURROGATE_BRIDGE_BASIS_KINDS = ['asserted', 'preregistered', 'empirical_association'] as const;
export type SurrogateBridgeBasisKind = (typeof SURROGATE_BRIDGE_BASIS_KINDS)[number];

export type SurrogateBridgeBasis =
  /** Someone's argument that the surrogate stands for the target. Not a check. */
  | { readonly kind: 'asserted'; readonly argument: string }
  /**
   * The surrogate was fixed in advance of collection. This rules out choosing
   * the metric after seeing the data; it does not rule in the metric.
   */
  | { readonly kind: 'preregistered'; readonly argument: string; readonly registrationRef: string }
  /**
   * The surrogate was compared against an independent measurement of the target.
   * The only basis that can license `proxy_validated`, and only when that
   * reference itself resolves, is `validated`, and measures the same construct.
   */
  | {
      readonly kind: 'empirical_association';
      readonly argument: string;
      readonly referenceMeasurementRef: string;
      readonly sample: string;
    };

export const SURROGATE_BRIDGE_STATUSES = ['supported', 'contested', 'unsupported'] as const;
export type SurrogateBridgeStatus = (typeof SURROGATE_BRIDGE_STATUSES)[number];

export interface SurrogateBridgeInput {
  readonly id: string;
  /** The measurement model this bridge is about. A bridge is not portable. */
  readonly surrogateModelRef: string;
  readonly targetConstruct: string;
  readonly surrogateConstruct: string;
  readonly direction: SurrogateDirection;
  readonly basis: SurrogateBridgeBasis;
  /**
   * Known ways the relationship fails. At least one is required, because a
   * bridge with none recorded has not been examined — every real surrogate has
   * a regime where it stops tracking, and an author who cannot name one has not
   * looked for it.
   */
  readonly failureModes: readonly string[];
  readonly status: SurrogateBridgeStatus;
  /** What contests it. Required unless `supported`, and forbidden when supported. */
  readonly contest: string | null;
  readonly validTime?: TimeInterval;
}

export type SurrogateBridge = Readonly<SurrogateBridgeInput>;

export interface SurrogateBridgeRegistry {
  readonly ids: readonly string[];
  resolve(ref: string): SurrogateBridge | null;
}

export interface BridgedMeasurementRequest {
  readonly measurementModelRef: string | null;
  readonly surrogateBridgeRef: string | null;
  readonly requiredConstruct: string;
  readonly assertedValidation: MeasurementValidation;
}

export interface BridgedMeasurementBacking {
  readonly admissible: boolean;
  readonly model: MeasurementModel | null;
  readonly bridge: SurrogateBridge | null;
  /**
   * The strongest rung this citation actually earns, which is never above the
   * one the model's own author declared and never above what the bridge can
   * carry. A caller that wants to report something weaker than it asserted has
   * the number here rather than having to derive it from the reasons.
   */
  readonly earnedValidation: MeasurementValidation;
  /** True when what was earned is weaker than what was asserted. */
  readonly degraded: boolean;
  readonly reasons: readonly string[];
}

function validationRank(value: MeasurementValidation): number {
  return MEASUREMENT_VALIDATIONS.indexOf(value);
}

function weaker(left: MeasurementValidation, right: MeasurementValidation): MeasurementValidation {
  return validationRank(left) <= validationRank(right) ? left : right;
}

function nonEmpty(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`surrogate bridge ${label} must be non-empty`);
  }
  return value;
}

/**
 * Build a bridge, validating the declaration itself.
 *
 * Order matters in one place: an unrecognised `status` is rejected before the
 * contest rules are applied, so a typo is reported as a typo rather than as a
 * missing contest.
 */
export function surrogateBridge(input: SurrogateBridgeInput): SurrogateBridge {
  const id = nonEmpty(input.id, 'id');
  const surrogateModelRef = nonEmpty(input.surrogateModelRef, 'surrogate model reference');
  const targetConstruct = nonEmpty(input.targetConstruct, 'target construct');
  const surrogateConstruct = nonEmpty(input.surrogateConstruct, 'surrogate construct');

  if (!SURROGATE_DIRECTIONS.includes(input.direction)) {
    throw new Error(`invalid surrogate bridge direction: ${String(input.direction)}`);
  }
  if (!input.basis || !SURROGATE_BRIDGE_BASIS_KINDS.includes(input.basis.kind)) {
    throw new Error(`invalid surrogate bridge basis kind: ${String(input.basis?.kind)}`);
  }
  if (!SURROGATE_BRIDGE_STATUSES.includes(input.status)) {
    throw new Error(`invalid surrogate bridge status: ${String(input.status)}`);
  }

  if (surrogateConstruct === targetConstruct) {
    throw new Error('surrogate construct and target construct must differ; a construct measured directly is not a surrogate for itself');
  }

  if (!Array.isArray(input.failureModes) || input.failureModes.length === 0) {
    throw new Error('surrogate bridge must record at least one known failure mode; a relationship with none recorded has not been examined');
  }
  for (const mode of input.failureModes) nonEmpty(mode, 'failure mode');

  if (input.status === 'supported') {
    if (input.contest !== null) {
      throw new Error('supported surrogate bridge cannot also record a contest; record the status the evidence supports');
    }
  } else if (input.contest === null || input.contest.trim().length === 0) {
    throw new Error(`${input.status} surrogate bridge must record what contests it`);
  }

  nonEmpty(input.basis.argument, 'basis argument');
  if (input.basis.kind === 'preregistered') nonEmpty(input.basis.registrationRef, 'registration reference');
  if (input.basis.kind === 'empirical_association') {
    const reference = nonEmpty(input.basis.referenceMeasurementRef, 'reference measurement reference');
    nonEmpty(input.basis.sample, 'sample description');
    if (reference === surrogateModelRef) {
      throw new Error(`surrogate model ${surrogateModelRef} cannot be validated against itself`);
    }
  }

  return Object.freeze({
    ...input,
    id,
    surrogateModelRef,
    targetConstruct,
    surrogateConstruct,
    failureModes: Object.freeze([...input.failureModes]),
    basis: Object.freeze({ ...input.basis }) as SurrogateBridgeBasis,
  });
}

/**
 * An immutable registry, on the same reasoning as `measurementRegistry`: a
 * registry a caller can add to at will is the hole one indirection further out,
 * since whoever needs a bridge to resolve could make it resolve. Every entry is
 * re-run through `surrogateBridge()` because bridges cross boundaries as plain
 * objects, and the structural type is satisfied by anything shaped right.
 */
export function surrogateBridgeRegistry(bridges: readonly SurrogateBridge[]): SurrogateBridgeRegistry {
  const byId = new Map<string, SurrogateBridge>();
  for (const candidate of bridges) {
    const canonical = surrogateBridge(candidate);
    const existing = byId.get(canonical.id);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(canonical)) {
      throw new Error(`conflicting surrogate bridges registered under id: ${canonical.id}`);
    }
    byId.set(canonical.id, canonical);
  }
  const ids = Object.freeze([...byId.keys()].sort());
  return Object.freeze({
    ids,
    resolve(ref: string): SurrogateBridge | null {
      return byId.get(ref) ?? null;
    },
  });
}

/**
 * The strongest rung this bridge could ever license, from its DECLARATION
 * alone.
 *
 * Deliberately registry-free, so a caller can price a bridge before assembling
 * anything and so the ceiling has one definition. Resolving an empirical
 * bridge's reference measurement can only lower this further; it can never
 * raise it, which is why that check lives in `bridgeSupport` below rather than
 * here.
 */
export function bridgeCeiling(bridge: SurrogateBridge): MeasurementValidation {
  if (bridge.status !== 'supported') return 'proxy_unvalidated';
  if (bridge.direction === 'unknown_direction') return 'proxy_unvalidated';
  if (bridge.basis.kind !== 'empirical_association') return 'proxy_unvalidated';
  return 'proxy_validated';
}

interface BridgeSupport {
  readonly ceiling: MeasurementValidation;
  readonly reasons: readonly string[];
}

function bridgeSupport(models: MeasurementRegistry, bridge: SurrogateBridge): BridgeSupport {
  const reasons: string[] = [];
  let ceiling: MeasurementValidation = 'proxy_validated';
  const lower = (): void => { ceiling = 'proxy_unvalidated'; };

  if (bridge.status !== 'supported') {
    reasons.push(`surrogate bridge is ${bridge.status}: ${String(bridge.contest)}`);
    lower();
  }
  if (bridge.direction === 'unknown_direction') {
    reasons.push('surrogate bridge direction is unknown, so no movement in the surrogate licenses any reading of the target');
    lower();
  }

  if (bridge.basis.kind !== 'empirical_association') {
    reasons.push(
      bridge.basis.kind === 'preregistered'
        ? 'a preregistered surrogate bridge supports at most proxy_unvalidated: fixing the metric in advance rules out choosing it after the data, and says nothing about whether it measures the construct'
        : 'an asserted surrogate bridge supports at most proxy_unvalidated: it records an argument, not a check',
    );
    lower();
  } else {
    const referenceRef = bridge.basis.referenceMeasurementRef;
    const reference = models.resolve(referenceRef);
    if (reference === null) {
      reasons.push(`surrogate bridge reference measurement ${referenceRef} resolves to no registered measurement model`);
      lower();
    } else if (reference.targetConstruct !== bridge.targetConstruct) {
      reasons.push(`surrogate bridge reference measurement ${referenceRef} targets ${reference.targetConstruct}, not ${bridge.targetConstruct}`);
      lower();
    } else if (reference.validation !== 'validated') {
      reasons.push(`surrogate bridge reference measurement ${referenceRef} is itself ${reference.validation}, so validating a surrogate against it establishes nothing about the construct`);
      lower();
    }
  }

  return { ceiling, reasons: Object.freeze(reasons) };
}

/**
 * May a claim about `requiredConstruct`, asserting `assertedValidation`, cite
 * this model through this bridge?
 *
 * The answer never exceeds what the model's own author declared. That is the
 * whole discipline: a bridge is a ceiling, so the worst it can do to an honest
 * caller is withhold, and the best it can do to a dishonest one is refuse.
 */
export function assessBridgedMeasurementBacking(
  models: MeasurementRegistry,
  bridges: SurrogateBridgeRegistry,
  request: BridgedMeasurementRequest,
): BridgedMeasurementBacking {
  const base = assessMeasurementBacking(models, {
    measurementModelRef: request.measurementModelRef,
    requiredConstruct: request.requiredConstruct,
    assertedValidation: request.assertedValidation,
  });

  const reasons: string[] = [...base.reasons];
  const model = base.model;
  let earned: MeasurementValidation = model === null ? 'proxy_unvalidated' : model.validation;
  let bridge: SurrogateBridge | null = null;

  if (request.surrogateBridgeRef !== null) {
    bridge = bridges.resolve(request.surrogateBridgeRef);
    if (bridge === null) {
      reasons.push(`surrogate bridge ${request.surrogateBridgeRef} resolves to no registered surrogate bridge`);
      earned = 'proxy_unvalidated';
    } else if (model === null) {
      // A bridge cited with nothing to bridge FROM is not a weaker citation; it
      // is a citation of a relationship whose left-hand side is missing.
      reasons.push(`surrogate bridge ${bridge.id} cited without a measurement model to bridge from`);
      earned = 'proxy_unvalidated';
    } else if (bridge.surrogateModelRef !== request.measurementModelRef) {
      reasons.push(`surrogate bridge ${bridge.id} is declared for measurement model ${bridge.surrogateModelRef}, not ${String(request.measurementModelRef)}`);
      earned = 'proxy_unvalidated';
    } else if (bridge.targetConstruct !== request.requiredConstruct) {
      reasons.push(`surrogate bridge targets ${bridge.targetConstruct}, not ${request.requiredConstruct}: ${bridge.id} does not bridge to this construct`);
      earned = 'proxy_unvalidated';
    } else if (model.validation === 'validated') {
      // Not a technicality. A model whose author says the construct itself was
      // measured, cited through a surrogate relationship, means one of the two
      // declarations is wrong — and reading it permissively would let a bridge
      // launder a direct claim rather than bound a surrogate one.
      reasons.push(`measurement model ${model.id} is declared validated and does not stand on a surrogate bridge`);
    } else {
      const support = bridgeSupport(models, bridge);
      reasons.push(...support.reasons);
      earned = weaker(earned, support.ceiling);
    }
  } else if (
    model !== null
    && model.validation === 'proxy_validated'
    && validationRank(request.assertedValidation) > validationRank('proxy_unvalidated')
  ) {
    // THE COUNTEREXAMPLE THIS MODULE EXISTS FOR. `proxy_validated` asserts that
    // the surrogate's relationship to the construct was checked. Without a
    // bridge there is no record of that check, so the rung is not earned.
    reasons.push(`measurement model ${model.id} is proxy_validated but names no surrogate bridge, so nothing records what relationship was checked`);
    earned = 'proxy_unvalidated';
  }

  return Object.freeze({
    admissible: reasons.length === 0,
    model,
    bridge,
    earnedValidation: earned,
    degraded: validationRank(earned) < validationRank(request.assertedValidation),
    reasons: Object.freeze(reasons),
  });
}

/** The refusing form, for boundaries that must not proceed on an inadmissible citation. */
export function assertBridgedMeasurementBacking(
  models: MeasurementRegistry,
  bridges: SurrogateBridgeRegistry,
  request: BridgedMeasurementRequest,
): { readonly model: MeasurementModel | null; readonly bridge: SurrogateBridge | null } {
  const backing = assessBridgedMeasurementBacking(models, bridges, request);
  if (!backing.admissible) {
    throw new Error(`inadmissible bridged measurement backing: ${backing.reasons.join('; ')}`);
  }
  return Object.freeze({ model: backing.model, bridge: backing.bridge });
}
