import { createHash } from 'node:crypto';

/**
 * Experimental economic-control primitives.
 *
 * These types describe alternatives Fiscus may compare. They are deliberately
 * not wired into the proxy or any enforcement path: an execution plan is a
 * research/decision object, not permission to route traffic.
 */
export interface ExecutionPlan {
  provider: string;
  model: string;
  endpointOrDeployment?: string | null;
  reasoningOrAgentParadigm?: string | null;
  promptVersion?: string | null;
  retrievalConfiguration?: string | null;
  toolPolicy?: string | null;
  cacheOrBatchPolicy?: string | null;
  reasoningEffort?: string | number | null;
  outputLimit?: number | null;
  retryPolicy?: string | null;
  fallbackPolicy?: string | null;
}

export type EvidenceGrade = 'A' | 'B' | 'C' | 'D' | 'E' | 'ungraded';

/** Common envelope emitted by modality-specific outcome adapters. */
export interface OutcomeEvidence {
  outcomeName: string;
  /** Domain-specific measure. Null means not observed, never zero-by-default. */
  measure: number | null;
  unit: string;
  evidenceGrade: EvidenceGrade;
  lowerBound: number | null;
  upperBound: number | null;
  observedAtMs: number;
  provenance: string;
  coverage: number | null;
  assumptions: string[];
}

export interface OutcomeAdapter<Raw = unknown> {
  readonly id: string;
  adapt(raw: Raw): OutcomeEvidence;
}

/**
 * Canonical JSON used only for local identifiers / hash chaining.
 * - object keys are sorted;
 * - undefined object members are omitted;
 * - undefined array entries become null, matching JSON.stringify semantics;
 * - non-finite numbers and non-JSON primitives are refused rather than hashed
 *   into an implementation-specific string.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'null';

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new Error('canonicalJson refuses non-finite numbers');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
      const record = value as Record<string, unknown>;
      const entries = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
      return `{${entries.join(',')}}`;
    }
    default:
      throw new Error(`canonicalJson refuses ${typeof value}`);
  }
}

/** Stable content address for one exact execution plan. */
export function executionPlanKey(plan: ExecutionPlan): string {
  if (!plan.provider.trim() || !plan.model.trim()) throw new Error('execution plan requires provider and model');
  return createHash('sha256').update(canonicalJson(plan)).digest('hex');
}
