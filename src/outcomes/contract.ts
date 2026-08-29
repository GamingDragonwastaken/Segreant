/**
 * Domain-neutral outcome contracts.
 *
 * Confirmation is conjunctive over required predicates: every required fact
 * must be supported. Unknown required facts are unresolved, never implicit pass.
 * Contradictory evidence remains conflicted. This is the generic replacement
 * foundation for treating a Git commit's durability signals as universal value.
 */

import type { EpistemicState } from '../epistemic/state.ts';

export interface OutcomeContract {
  readonly id: string;
  readonly requiredPredicates: readonly string[];
}

export type OutcomeStatus = 'confirmed' | 'failed' | 'unresolved' | 'conflicted';
export type PredicateResolver = (predicate: string) => EpistemicState;

export interface OutcomeEvaluation {
  readonly contractId: string;
  readonly status: OutcomeStatus;
  readonly supportedPredicates: readonly string[];
  readonly refutedPredicates: readonly string[];
  readonly unresolvedPredicates: readonly string[];
  readonly conflictedPredicates: readonly string[];
}

export interface OutcomeBounds {
  readonly lower: number;
  readonly upper: number;
  readonly n: number;
  readonly confirmed: number;
  readonly failed: number;
  readonly unresolved: number;
  readonly conflicted: number;
}

function validateContract(contract: OutcomeContract): void {
  if (contract.id.trim().length === 0) throw new Error('outcome contract id must be non-empty');
  if (contract.requiredPredicates.length === 0) throw new Error('outcome contract requires at least one required predicate');
  const seen = new Set<string>();
  for (const raw of contract.requiredPredicates) {
    const predicate = raw.trim();
    if (predicate.length === 0) throw new Error('outcome contract required predicates must be non-empty');
    if (seen.has(predicate)) throw new Error(`duplicate required predicate: ${predicate}`);
    seen.add(predicate);
  }
}

export function evaluateOutcomeContract(contract: OutcomeContract, resolve: PredicateResolver): OutcomeEvaluation {
  validateContract(contract);
  const supported: string[] = [];
  const refuted: string[] = [];
  const unresolved: string[] = [];
  const conflicted: string[] = [];

  for (const predicate of contract.requiredPredicates) {
    const state = resolve(predicate);
    if (state === 'supported') supported.push(predicate);
    else if (state === 'refuted') refuted.push(predicate);
    else if (state === 'conflicted') conflicted.push(predicate);
    else unresolved.push(predicate);
  }

  let status: OutcomeStatus;
  if (refuted.length > 0) status = 'failed';
  else if (conflicted.length > 0) status = 'conflicted';
  else if (unresolved.length > 0) status = 'unresolved';
  else status = 'confirmed';

  return Object.freeze({
    contractId: contract.id,
    status,
    supportedPredicates: Object.freeze(supported),
    refutedPredicates: Object.freeze(refuted),
    unresolvedPredicates: Object.freeze(unresolved),
    conflictedPredicates: Object.freeze(conflicted),
  });
}

/**
 * Partial-identification bounds for the realized share.
 * Lower bound counts only confirmed outcomes. Upper bound excludes only outcomes
 * that are refuted without ambiguity; unresolved/conflicted outcomes remain
 * possible until evidence resolves them.
 */
export function outcomeBounds(evaluations: ReadonlyArray<OutcomeEvaluation>): OutcomeBounds {
  const n = evaluations.length;
  let confirmed = 0;
  let failed = 0;
  let unresolved = 0;
  let conflicted = 0;
  for (const evaluation of evaluations) {
    if (evaluation.status === 'confirmed') confirmed += 1;
    else if (evaluation.status === 'failed') failed += 1;
    else if (evaluation.status === 'conflicted') conflicted += 1;
    else unresolved += 1;
  }
  if (n === 0) return Object.freeze({ lower: 0, upper: 0, n: 0, confirmed, failed, unresolved, conflicted });
  return Object.freeze({
    lower: confirmed / n,
    upper: (confirmed + unresolved + conflicted) / n,
    n,
    confirmed,
    failed,
    unresolved,
    conflicted,
  });
}
