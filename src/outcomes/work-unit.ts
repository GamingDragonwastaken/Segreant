import type { EpistemicState } from '../epistemic/state.ts';
import {
  evaluateOutcomeContract,
  type OutcomeContract,
  type OutcomeEvaluation,
} from './contract.ts';

/** Domain-neutral unit of work. Domain meaning lives in an OutcomeAdapter. */
export interface WorkUnit {
  readonly id: string;
  readonly kind: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly context: Readonly<Record<string, unknown>>;
}

export interface WorkUnitInput {
  readonly id: string;
  readonly kind: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly context?: Readonly<Record<string, unknown>>;
}

export interface OutcomeMeasure {
  readonly value: number | string | boolean | null;
  readonly intervalOrBounds: Readonly<Record<string, number>> | null;
}

export interface OutcomeAdapter {
  readonly id: string;
  readonly contract: OutcomeContract;
  readonly resolve: (predicate: string, unit: WorkUnit) => EpistemicState;
  readonly measure?: (unit: WorkUnit, evaluation: OutcomeEvaluation) => OutcomeMeasure | null;
  readonly observedAtMs?: (unit: WorkUnit, evaluation: OutcomeEvaluation) => number | null;
}

export interface OutcomeEvidence {
  readonly outcomeName: string;
  readonly valueOrSuccessMeasure: number | string | boolean | null;
  readonly evidenceGrade: OutcomeEvaluation['status'];
  readonly intervalOrBounds: Readonly<Record<string, number>> | null;
  readonly observedAtMs: number | null;
  readonly provenance: string;
  readonly coverage: 'complete' | 'partial' | 'none';
  readonly assumptions: readonly string[];
}

export interface AdaptedOutcome {
  readonly unitId: string;
  readonly adapterId: string;
  readonly evaluation: OutcomeEvaluation;
  readonly evidence: OutcomeEvidence;
}

function nonEmpty(value: string, label: string): string {
  if (value.trim().length === 0) throw new Error(`${label} must be non-empty`);
  return value;
}

export function createWorkUnit(input: WorkUnitInput): WorkUnit {
  const id = nonEmpty(input.id, 'work unit id');
  const kind = nonEmpty(input.kind, 'work unit kind');
  if (!Number.isFinite(input.startedAtMs) || !Number.isFinite(input.endedAtMs) || input.endedAtMs < input.startedAtMs) {
    throw new Error('work unit interval must be finite and ordered');
  }
  return Object.freeze({
    id,
    kind,
    startedAtMs: input.startedAtMs,
    endedAtMs: input.endedAtMs,
    context: Object.freeze({ ...(input.context ?? {}) }),
  });
}

export function adaptOutcome(unit: WorkUnit, adapter: OutcomeAdapter): AdaptedOutcome {
  nonEmpty(adapter.id, 'outcome adapter id');
  const evaluation = evaluateOutcomeContract(
    adapter.contract,
    (predicate) => adapter.resolve(predicate, unit),
  );
  const measure = adapter.measure?.(unit, evaluation) ?? null;
  const observedAtMs = adapter.observedAtMs?.(unit, evaluation) ?? null;
  const coverage = evaluation.status === 'unresolved' ? 'partial' : 'complete';
  return Object.freeze({
    unitId: unit.id,
    adapterId: adapter.id,
    evaluation,
    evidence: Object.freeze({
      outcomeName: adapter.contract.id,
      valueOrSuccessMeasure: measure?.value ?? null,
      evidenceGrade: evaluation.status,
      intervalOrBounds: measure?.intervalOrBounds ?? null,
      observedAtMs,
      provenance: `adapter:${adapter.id}`,
      coverage,
      assumptions: Object.freeze([]),
    }),
  });
}
