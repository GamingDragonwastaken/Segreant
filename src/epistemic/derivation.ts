import { grainRelation, type Grain } from './grain.ts';
import { scopeRelation, type Scope } from './scope.ts';
import { intervalRelation, type TimeInterval } from './time.ts';

/**
 * Explicit proof obligations understood by the first Trusted Epistemic Kernel.
 *
 * These are not claims that Fiscus invented the underlying methods. They are
 * runtime type tags for the places where a derivation is otherwise forbidden to
 * strengthen, translate, aggregate, reinterpret, or negatively close evidence.
 */
export const WITNESS_KINDS = [
  'identity',
  'authenticity',
  'completeness',
  'granularity_refinement',
  'aggregation',
  'grain_transform',
  'scope_transform',
  'temporal_transform',
  'measurement_validity',
  'causal_identification',
  'valuation',
  'allocation',
] as const;

export type WitnessKind = (typeof WITNESS_KINDS)[number];

export interface DerivationWitness {
  readonly id: string;
  readonly kind: WitnessKind;
  /** Evidence retained by input claims that grounds this witness. */
  readonly sourceEvidenceIds: readonly string[];
  /** Human-auditable statement of what the witness establishes. */
  readonly statement: string;
}

/**
 * Small claim descriptor for kernel-level derivation validation.
 *
 * Domain payloads deliberately stay outside this primitive. The kernel governs
 * the semantic coordinates that feature modules are not permitted to change
 * silently; richer evidence profiles and claim payloads can compose around it.
 */
export interface ClaimDescriptor {
  readonly id: string;
  /** Construct/measurand name, e.g. `provider_cost`, not a display label. */
  readonly construct: string;
  readonly grain: Grain;
  readonly scope: Scope;
  readonly validTime: TimeInterval;
  readonly evidenceIds: readonly string[];
  /** Witnesses this claim explicitly relies upon. Uncited witnesses do not count. */
  readonly witnessIds: readonly string[];
  /** Domain-specific obligations such as completeness for a negative claim. */
  readonly requiredWitnessKinds: readonly WitnessKind[];
}

export type DerivationViolationCode =
  | 'NO_INPUT_CLAIMS'
  | 'DUPLICATE_WITNESS_ID'
  | 'DUPLICATE_WITNESS_REFERENCE'
  | 'UNKNOWN_WITNESS'
  | 'WITNESS_SOURCE_EMPTY'
  | 'WITNESS_SOURCE_NOT_IN_INPUT'
  | 'OUTPUT_EVIDENCE_NOT_IN_INPUT'
  | 'GRAIN_REFINEMENT_WITNESS_REQUIRED'
  | 'AGGREGATION_WITNESS_REQUIRED'
  | 'GRAIN_TRANSFORM_WITNESS_REQUIRED'
  | 'SCOPE_TRANSFORM_WITNESS_REQUIRED'
  | 'TEMPORAL_TRANSFORM_WITNESS_REQUIRED'
  | 'MEASUREMENT_VALIDITY_WITNESS_REQUIRED'
  | 'REQUIRED_WITNESS_MISSING';

export interface DerivationViolation {
  readonly code: DerivationViolationCode;
  readonly message: string;
  readonly inputClaimId?: string;
  readonly witnessId?: string;
  readonly witnessKind?: WitnessKind;
  readonly evidenceId?: string;
}

function violation(
  code: DerivationViolationCode,
  message: string,
  detail: Omit<DerivationViolation, 'code' | 'message'> = {},
): DerivationViolation {
  return Object.freeze({ code, message, ...detail });
}

function duplicateValues(values: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    else seen.add(value);
  }
  return duplicates;
}

/**
 * Validate one derived claim against its declared inputs and witnesses.
 *
 * The validator is intentionally conservative:
 * - finer grain is a disaggregation/refinement and needs a refinement witness;
 * - coarser grain is an aggregation and still needs an aggregation witness;
 * - incomparable grains need an explicit transform witness;
 * - any scope or valid-time change needs an explicit transform witness;
 * - changing the construct when no input already measures that construct needs
 *   a measurement-validity witness;
 * - domain-required obligations (for example completeness of an incident feed
 *   before inferring "no incidents") must be named on the output claim.
 *
 * Ordinary invalid derivations return structured violations rather than throw.
 * This is a kernel conformance primitive, not yet the complete Evidence Calculus.
 */
export function validateDerivation(
  inputs: readonly ClaimDescriptor[],
  output: ClaimDescriptor,
  witnesses: readonly DerivationWitness[],
): readonly DerivationViolation[] {
  const failures: DerivationViolation[] = [];
  if (inputs.length === 0) {
    failures.push(violation('NO_INPUT_CLAIMS', 'a derivation requires at least one input claim'));
  }

  const inputEvidenceIds = new Set<string>();
  for (const input of inputs) {
    for (const evidenceId of input.evidenceIds) inputEvidenceIds.add(evidenceId);
  }

  const duplicateWitnessIds = duplicateValues(witnesses.map((item) => item.id));
  for (const id of [...duplicateWitnessIds].sort()) {
    failures.push(violation(
      'DUPLICATE_WITNESS_ID',
      `witness id is ambiguous because it appears more than once: ${id}`,
      { witnessId: id },
    ));
  }

  const witnessById = new Map<string, DerivationWitness>();
  for (const item of witnesses) {
    if (!duplicateWitnessIds.has(item.id)) witnessById.set(item.id, item);
  }

  const duplicateReferences = duplicateValues(output.witnessIds);
  for (const id of [...duplicateReferences].sort()) {
    failures.push(violation(
      'DUPLICATE_WITNESS_REFERENCE',
      `output claim cites witness more than once: ${id}`,
      { witnessId: id },
    ));
  }

  const validCitedWitnesses: DerivationWitness[] = [];
  const citedOnce = new Set<string>();
  for (const witnessId of output.witnessIds) {
    if (citedOnce.has(witnessId)) continue;
    citedOnce.add(witnessId);

    const item = witnessById.get(witnessId);
    if (!item) {
      failures.push(violation(
        'UNKNOWN_WITNESS',
        `output claim cites an unknown or ambiguous witness: ${witnessId}`,
        { witnessId },
      ));
      continue;
    }

    if (item.sourceEvidenceIds.length === 0) {
      failures.push(violation(
        'WITNESS_SOURCE_EMPTY',
        `witness ${item.id} is not grounded in any retained input evidence`,
        { witnessId: item.id, witnessKind: item.kind },
      ));
      continue;
    }

    let grounded = true;
    for (const evidenceId of item.sourceEvidenceIds) {
      if (!inputEvidenceIds.has(evidenceId)) {
        grounded = false;
        failures.push(violation(
          'WITNESS_SOURCE_NOT_IN_INPUT',
          `witness ${item.id} cites evidence not retained by any input claim: ${evidenceId}`,
          { witnessId: item.id, witnessKind: item.kind, evidenceId },
        ));
      }
    }
    if (grounded) validCitedWitnesses.push(item);
  }

  for (const evidenceId of output.evidenceIds) {
    if (!inputEvidenceIds.has(evidenceId)) {
      failures.push(violation(
        'OUTPUT_EVIDENCE_NOT_IN_INPUT',
        `derived claim cites evidence that is not retained by an input claim: ${evidenceId}`,
        { evidenceId },
      ));
    }
  }

  const hasWitness = (kind: WitnessKind): boolean => validCitedWitnesses.some((item) => item.kind === kind);

  for (const input of inputs) {
    const relation = grainRelation(input.grain, output.grain);
    if (relation === 'coarser' && !hasWitness('granularity_refinement')) {
      failures.push(violation(
        'GRAIN_REFINEMENT_WITNESS_REQUIRED',
        `claim ${output.id} is finer-grained than input ${input.id} without a granularity-refinement witness`,
        { inputClaimId: input.id, witnessKind: 'granularity_refinement' },
      ));
    } else if (relation === 'finer' && !hasWitness('aggregation')) {
      failures.push(violation(
        'AGGREGATION_WITNESS_REQUIRED',
        `claim ${output.id} aggregates input ${input.id} without an aggregation witness`,
        { inputClaimId: input.id, witnessKind: 'aggregation' },
      ));
    } else if (relation === 'incomparable' && !hasWitness('grain_transform')) {
      failures.push(violation(
        'GRAIN_TRANSFORM_WITNESS_REQUIRED',
        `claim ${output.id} changes from an incomparable grain on input ${input.id} without a grain-transform witness`,
        { inputClaimId: input.id, witnessKind: 'grain_transform' },
      ));
    }

    if (scopeRelation(input.scope, output.scope) !== 'equal' && !hasWitness('scope_transform')) {
      failures.push(violation(
        'SCOPE_TRANSFORM_WITNESS_REQUIRED',
        `claim ${output.id} changes scope relative to input ${input.id} without a scope-transform witness`,
        { inputClaimId: input.id, witnessKind: 'scope_transform' },
      ));
    }

    if (intervalRelation(input.validTime, output.validTime) !== 'equal' && !hasWitness('temporal_transform')) {
      failures.push(violation(
        'TEMPORAL_TRANSFORM_WITNESS_REQUIRED',
        `claim ${output.id} changes valid time relative to input ${input.id} without a temporal-transform witness`,
        { inputClaimId: input.id, witnessKind: 'temporal_transform' },
      ));
    }
  }

  if (inputs.length > 0 && !inputs.some((input) => input.construct === output.construct) && !hasWitness('measurement_validity')) {
    failures.push(violation(
      'MEASUREMENT_VALIDITY_WITNESS_REQUIRED',
      `claim ${output.id} changes construct without a measurement-validity witness`,
      { witnessKind: 'measurement_validity' },
    ));
  }

  for (const kind of new Set(output.requiredWitnessKinds)) {
    if (!hasWitness(kind)) {
      failures.push(violation(
        'REQUIRED_WITNESS_MISSING',
        `claim ${output.id} requires a cited, grounded ${kind} witness`,
        { witnessKind: kind },
      ));
    }
  }

  return Object.freeze(failures);
}
