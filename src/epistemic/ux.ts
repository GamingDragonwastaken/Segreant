/**
 * Structured, review-only epistemic UX bundle (WP-I02).
 *
 * This is the shared model behind a Trace-the-Dollar reader, support/countermodel
 * disclosure, measure-next planning, and Preference Map presentation. It does
 * not mint claims or recommendations: every surface carries its boundary and
 * refuses to turn missing graph edges into a complete story.
 */

import { moneyFromJson, type MoneyJson } from '../economics/money.ts';
import {
  minimalInvalidatingAssumptionSets,
  type CertificationStructure,
  type MinimalInvalidatingSets,
} from './countermodel.ts';
import {
  preferenceRobustness,
  type PreferenceRobustnessResult,
  type PreferenceScenario,
} from '../decision/engine.ts';

export interface EpistemicTraceNode {
  readonly id: string;
  readonly kind: 'request' | 'economic_event' | 'correction' | 'allocation';
  readonly amount: MoneyJson;
  readonly sourceIds: readonly string[];
  readonly recordedAtMs: number;
}

export interface EpistemicTraceInput {
  readonly rootId: string;
  readonly nodes: readonly EpistemicTraceNode[];
}

export interface MeasureNextGap {
  readonly id: string;
  readonly question: string;
  readonly consequence: 'high' | 'medium' | 'low';
  readonly requiredEvidence: readonly string[];
  readonly cost: number | null;
}

export interface EpistemicUxBundleInput {
  readonly trace: EpistemicTraceInput;
  readonly support: CertificationStructure;
  readonly measureNext: { readonly gaps: readonly MeasureNextGap[] };
  readonly preferences: readonly PreferenceScenario[];
}

export interface EpistemicTraceResult {
  readonly status: 'complete' | 'withheld';
  readonly rootId: string;
  readonly orderedNodeIds: readonly string[];
  readonly missingSourceIds: readonly string[];
  readonly amounts: Readonly<Record<string, MoneyJson>>;
  readonly limitations: readonly string[];
}

export interface MeasureNextResult {
  readonly status: 'review_only_unpriced';
  readonly gaps: readonly MeasureNextGap[];
  readonly nonClaims: readonly string[];
}

export interface EpistemicUxBundle {
  readonly trace: EpistemicTraceResult;
  readonly support: MinimalInvalidatingSets;
  readonly measureNext: MeasureNextResult;
  readonly preferences: PreferenceRobustnessResult;
  readonly nonClaims: readonly string[];
}

function identifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error(`${label} must be a bounded identifier`);
}

function trace(input: EpistemicTraceInput): EpistemicTraceResult {
  identifier(input.rootId, 'trace.rootId');
  if (!Array.isArray(input.nodes) || input.nodes.length === 0) throw new Error('trace.nodes must be non-empty');
  const byId = new Map<string, EpistemicTraceNode>();
  for (const [index, node] of input.nodes.entries()) {
    identifier(node.id, `trace.nodes[${index}].id`);
    if (byId.has(node.id)) throw new Error(`trace node id is duplicated: ${node.id}`);
    if (!['request', 'economic_event', 'correction', 'allocation'].includes(node.kind)) throw new Error(`trace.nodes[${index}].kind is unsupported`);
    if (!Number.isSafeInteger(node.recordedAtMs) || node.recordedAtMs <= 0) throw new Error(`trace.nodes[${index}].recordedAtMs is invalid`);
    moneyFromJson(node.amount);
    if (!Array.isArray(node.sourceIds)) throw new Error(`trace.nodes[${index}].sourceIds must be an array`);
    byId.set(node.id, node);
  }
  if (!byId.has(input.rootId)) throw new Error('trace root node is not present');
  const ordered = [...input.nodes].sort((left, right) => left.recordedAtMs - right.recordedAtMs || left.id.localeCompare(right.id));
  const seen = new Set<string>();
  const missing = new Set<string>();
  for (const node of ordered) {
    for (const sourceId of node.sourceIds) {
      if (!byId.has(sourceId) || !seen.has(sourceId)) missing.add(sourceId);
    }
    seen.add(node.id);
  }
  const amounts: Record<string, MoneyJson> = {};
  for (const node of ordered) amounts[node.id] = Object.freeze({ ...node.amount });
  return Object.freeze({
    status: missing.size === 0 ? 'complete' : 'withheld',
    rootId: input.rootId,
    orderedNodeIds: Object.freeze(ordered.map((node) => node.id)),
    missingSourceIds: Object.freeze([...missing].sort()),
    amounts: Object.freeze(amounts),
    limitations: Object.freeze([
      'Trace order and source identity are checked, but this reader does not infer unrecorded provider invoices or semantic truth from an amount.',
      'Corrections and allocations retain their declared lineage; conservation and claim strength remain the economic/kernel boundaries.',
    ]),
  });
}

function measureNext(input: EpistemicUxBundleInput['measureNext']): MeasureNextResult {
  if (!Array.isArray(input.gaps) || input.gaps.length === 0) throw new Error('measureNext.gaps must be non-empty');
  const seen = new Set<string>();
  const gaps: MeasureNextGap[] = input.gaps.map((gap, index) => {
    identifier(gap.id, `measureNext.gaps[${index}].id`);
    if (seen.has(gap.id)) throw new Error(`measure-next gap is duplicated: ${gap.id}`);
    seen.add(gap.id);
    if (typeof gap.question !== 'string' || gap.question.trim() === '') throw new Error(`measureNext.gaps[${index}].question is required`);
    if (!['high', 'medium', 'low'].includes(gap.consequence)) throw new Error(`measureNext.gaps[${index}].consequence is unsupported`);
    if (!Array.isArray(gap.requiredEvidence) || gap.requiredEvidence.length === 0) throw new Error(`measureNext.gaps[${index}].requiredEvidence is required`);
    if (gap.cost !== null && (typeof gap.cost !== 'number' || !Number.isFinite(gap.cost) || gap.cost < 0)) throw new Error(`measureNext.gaps[${index}].cost is invalid`);
    return { ...gap, requiredEvidence: [...gap.requiredEvidence] };
  });
  const consequenceRank: Record<MeasureNextGap['consequence'], number> = { high: 0, medium: 1, low: 2 };
  gaps.sort((left, right) => consequenceRank[left.consequence] - consequenceRank[right.consequence] || left.id.localeCompare(right.id));
  return Object.freeze({
    status: 'review_only_unpriced',
    gaps: Object.freeze(gaps),
    nonClaims: Object.freeze([
      'This is a qualitative evidence-gap map, not a value-of-information ranking.',
      'No posterior, probability of decision change, or acquisition-cost model is inferred when the caller has not supplied one.',
    ]),
  });
}

export function buildEpistemicUxBundle(input: EpistemicUxBundleInput): EpistemicUxBundle {
  if (input === null || typeof input !== 'object') throw new Error('epistemic UX input must be an object');
  return Object.freeze({
    trace: trace(input.trace),
    support: minimalInvalidatingAssumptionSets(input.support),
    measureNext: measureNext(input.measureNext),
    preferences: preferenceRobustness(input.preferences),
    nonClaims: Object.freeze([
      'This bundle is a read-only presentation model. It does not issue, strengthen, authorize, or route a claim.',
      'A complete trace is complete only over the supplied nodes and source edges, not over the external world.',
    ]),
  });
}
