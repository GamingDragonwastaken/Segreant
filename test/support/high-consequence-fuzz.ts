/**
 * WP-H03 deterministic, dependency-free fuzzing for high-consequence pure and
 * boundary paths.
 *
 * This is intentionally not a general-purpose property-testing framework. It
 * fixes the seed and case counts, derives every case from the local generator,
 * compares production output with an independently written oracle, and puts a
 * replay coordinate in every failure. The sweep is small enough for the normal
 * test lifecycle and broad enough to exercise graph closure, exact allocation,
 * and malformed budget inputs that hand-picked examples routinely miss.
 */

import {
  DEFAULT_CONFIG,
  MAX_RUNAWAY_WINDOW_SEC,
  type BudgetConfig,
} from '../../src/config.ts';
import { BudgetGuard } from '../../src/budget/guard.ts';
import {
  applyExactAllocation,
  validateExactAllocationResult,
  type ExactAllocatableRow,
  type ExactAllocationRunResult,
} from '../../src/alloc/exact.ts';
import type { AllocationRule, CostCentre } from '../../src/alloc/rules.ts';
import { addMoney, compareMoney, formatMoneyAmount, money, type Money } from '../../src/economics/money.ts';
import { revocationClosure, type DependencyEdge } from '../../src/epistemic/revocation.ts';
import {
  deterministicRandom,
  generateNonNegativeAmountText,
  seedFor,
  type DeterministicRandom,
} from './deterministicGenerator.ts';

export const HIGH_CONSEQUENCE_FUZZ_SEED = 0x48_03_fade;
export const HIGH_CONSEQUENCE_GRAPH_CASES = 160;
export const HIGH_CONSEQUENCE_ALLOCATION_CASES = 120;
export const HIGH_CONSEQUENCE_BOUNDARY_CASES = 240;

export interface HighConsequenceFuzzReport {
  readonly seed: number;
  readonly graphCases: number;
  readonly allocationCases: number;
  readonly boundaryCases: number;
  readonly reachableEdges: number;
  readonly unrelatedNodes: number;
  readonly malformedBoundaryInputs: number;
  readonly failures: readonly string[];
  readonly allPropertiesHeld: boolean;
}

function replay(label: string, seed: number, index: number): string {
  return `seed=${HIGH_CONSEQUENCE_FUZZ_SEED} stream=${label} streamSeed=${seed} case=${index}`;
}

function decimalAmount(value: Money): string {
  return `${formatMoneyAmount(value)} ${value.currency}/${value.basis}`;
}

function expectedClosure(roots: readonly string[], graph: readonly DependencyEdge[]): string[] {
  const descendants = new Map<string, string[]>();
  for (const edge of graph) {
    const list = descendants.get(edge.from) ?? [];
    list.push(edge.to);
    descendants.set(edge.from, list);
  }
  const seen = new Set<string>();
  const queue = [...new Set(roots)].sort((a, b) => a.localeCompare(b));
  for (const root of queue) seen.add(root);
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    for (const child of descendants.get(queue[cursor]!) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      queue.push(child);
    }
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

function graphSweep(
  failures: string[],
): { reachableEdges: number; unrelatedNodes: number } {
  const seed = seedFor(HIGH_CONSEQUENCE_FUZZ_SEED, 'epistemic/revocation-closure');
  const rng = deterministicRandom(seed);
  let reachableEdges = 0;
  let unrelatedNodes = 0;

  for (let index = 0; index < HIGH_CONSEQUENCE_GRAPH_CASES; index += 1) {
    const nodeCount = rng.between(5, 12);
    const nodes = Array.from({ length: nodeCount }, (_, node) => `graph:${index}:${node}`);
    const edges: DependencyEdge[] = [];
    // Only forward edges are generated, so the reference oracle is a DAG and
    // no case can be rejected merely because the generator made a cycle.
    for (let from = 0; from < nodeCount - 1; from += 1) {
      for (let to = from + 1; to < nodeCount; to += 1) {
        if (rng.chance(1, 4)) edges.push({ from: nodes[from]!, to: nodes[to]! });
      }
    }
    // Every case has one reachable edge and one independent node. This makes
    // the sweep unable to pass by testing only singleton roots or empty graphs.
    if (!edges.some((edge) => edge.from === nodes[0])) edges.push({ from: nodes[0]!, to: nodes[1]! });
    const roots = [nodes[0]!, rng.pick(nodes.slice(2))];
    const expected = expectedClosure(roots, edges);
    const actual = revocationClosure([...roots, roots[0]!], rng.shuffled(edges));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      failures.push(`${replay('epistemic/revocation-closure', seed, index)} expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
      continue;
    }

    const reachable = new Set(expected);
    reachableEdges += edges.filter((edge) => reachable.has(edge.from) && reachable.has(edge.to)).length;
    unrelatedNodes += nodes.filter((node) => !reachable.has(node)).length;
    // Revocation closure is a set operation: adding a duplicate root or
    // permuting the graph cannot change the result.
    const permuted = revocationClosure([...roots].reverse(), rng.shuffled(edges));
    if (JSON.stringify(permuted) !== JSON.stringify(actual)) {
      failures.push(`${replay('epistemic/revocation-closure', seed, index)} permutation changed closure`);
    }
  }
  return { reachableEdges, unrelatedNodes };
}

const ALLOCATION_CENTRE: CostCentre = Object.freeze({
  costCentreId: 'eng',
  name: 'Engineering',
  owner: null,
  createdAtMs: 0,
  archivedAtMs: null,
});

const ALLOCATION_RULE: AllocationRule = Object.freeze({
  ruleId: 'all',
  version: 1,
  method: 'direct',
  match: {},
  targets: [{ costCentreId: 'eng', ratio: 1 }],
  priority: 1,
  effectiveFromMs: 0,
  effectiveToMs: null,
  revokedAtMs: null,
  owner: null,
  note: null,
  createdAtMs: 0,
});

function allocationRows(rng: DeterministicRandom, caseIndex: number): ExactAllocatableRow[] {
  const count = rng.between(1, 8);
  const rows: ExactAllocatableRow[] = [];
  for (let index = 0; index < count; index += 1) {
    const amount = money(generateNonNegativeAmountText(rng, 8), 'USD', 'list');
    rows.push({
      sourceEventIds: [`economic:fuzz:${caseIndex}:${index}`],
      amount,
      project: rng.pick(['api', 'worker', 'web']),
      provider: rng.pick(['openai', 'anthropic']),
      model: rng.pick(['model-a', 'model-b', 'model-c']),
      source: null,
      user: null,
      tsEpochMs: rng.between(1, 999),
    });
  }
  if (rows.every((row) => row.amount.coefficient === 0n)) {
    const first = rows[0]!;
    rows[0] = { ...first, amount: money('1', 'USD', 'list') };
  }
  return rows;
}

function allocationSignature(result: ExactAllocationRunResult): string {
  return JSON.stringify({
    total: result.totalByIdentity.map((bucket) => ({ ...bucket, amount: decimalAmount(bucket.amount), sourceEventIds: [...bucket.sourceEventIds] })),
    allocated: result.allocatedByIdentity.map((bucket) => ({ ...bucket, amount: decimalAmount(bucket.amount), sourceEventIds: [...bucket.sourceEventIds] })),
    unallocated: result.unallocatedByIdentity.map((bucket) => ({ ...bucket, amount: decimalAmount(bucket.amount), sourceEventIds: [...bucket.sourceEventIds] })),
    lines: result.lines.map((line) => ({
      costCentreId: line.costCentreId,
      ruleId: line.ruleId,
      amount: decimalAmount(line.amount),
      sourceEventIds: [...line.sourceEventIds],
    })),
    unresolvedRequestIds: [...result.unresolvedRequestIds],
    sourceBases: [...result.sourceBases],
    complete: result.complete,
    conserves: result.conserves,
  });
}

function allocationSweep(failures: string[]): void {
  const seed = seedFor(HIGH_CONSEQUENCE_FUZZ_SEED, 'exact/allocation-conservation');
  const rng = deterministicRandom(seed);
  for (let index = 0; index < HIGH_CONSEQUENCE_ALLOCATION_CASES; index += 1) {
    const rows = allocationRows(rng, index);
    try {
      const input = {
        rows,
        rules: [ALLOCATION_RULE],
        costCentres: [ALLOCATION_CENTRE],
        periodStartMs: 0,
        periodEndMs: 1_000,
        runAtMs: 2_000,
      } as const;
      const first = applyExactAllocation(input);
      const shuffled = applyExactAllocation({ ...input, rows: rng.shuffled(rows) });
      validateExactAllocationResult(first);
      validateExactAllocationResult(shuffled);
      if (allocationSignature(first) !== allocationSignature(shuffled)) {
        failures.push(`${replay('exact/allocation-conservation', seed, index)} row permutation changed the exact run`);
        continue;
      }

      let expected = money('0', 'USD', 'list');
      for (const row of rows) expected = addMoney(expected, row.amount);
      const total = first.totalByIdentity[0]?.amount;
      const allocated = first.allocatedByIdentity[0]?.amount;
      if (total === undefined || compareMoney(total, expected) !== 0 || allocated === undefined || compareMoney(allocated, expected) !== 0) {
        failures.push(`${replay('exact/allocation-conservation', seed, index)} expected=${decimalAmount(expected)} total=${total ? decimalAmount(total) : 'missing'} allocated=${allocated ? decimalAmount(allocated) : 'missing'}`);
      }
    } catch (error) {
      failures.push(`${replay('exact/allocation-conservation', seed, index)} generated valid input was refused: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function zeroStore(): unknown {
  return {
    exactSpendBetween: () => ({ amount: money('0', 'USD', 'effective'), eventIds: [], sourceBases: [], requestCount: 0, unresolvedRequests: 0 }),
    spendBetween: () => 0,
    exactSpendInWindow: () => ({ amount: money('0', 'USD', 'effective'), eventIds: [], sourceBases: [], requestCount: 0, unresolvedRequests: 0 }),
    spendInWindow: () => ({ costUsd: 0, requests: 0 }),
    exactSpendForSession: () => ({ amount: money('0', 'USD', 'effective'), eventIds: [], sourceBases: [], requestCount: 0, unresolvedRequests: 0 }),
    spendForSession: () => 0,
    upsertSession: () => undefined,
  };
}

function invalidBudget(rng: DeterministicRandom, cap: boolean): BudgetConfig {
  const base = structuredClone(DEFAULT_CONFIG.budget);
  if (cap) {
    const values = [Number.NaN, Number.POSITIVE_INFINITY, '25'] as const;
    base.dailyUsd = rng.pick(values) as unknown as number;
    base.runawayWindowSec = 60;
  } else {
    const values = [Number.NaN, Number.POSITIVE_INFINITY, -1, MAX_RUNAWAY_WINDOW_SEC + 1, '60'] as const;
    base.runawayWindowSec = rng.pick(values) as unknown as number;
  }
  return base;
}

function boundarySweep(failures: string[]): number {
  const seed = seedFor(HIGH_CONSEQUENCE_FUZZ_SEED, 'budget/malformed-input-boundary');
  const rng = deterministicRandom(seed);
  let malformed = 0;
  for (let index = 0; index < HIGH_CONSEQUENCE_BOUNDARY_CASES; index += 1) {
    const config = invalidBudget(rng, index % 2 === 0);
    malformed += 1;
    try {
      new BudgetGuard(zeroStore() as never, config).evaluate({ nowMs: 1_800_000_000_000, sessionId: 'fuzz-session' });
      failures.push(`${replay('budget/malformed-input-boundary', seed, index)} invalid input was allowed`);
    } catch {
      // Every generated malformed cap/window must stop before a decision.
    }
  }
  return malformed;
}

/** Run all fixed fuzz streams in declaration order. */
export function runHighConsequenceFuzzAssurance(): HighConsequenceFuzzReport {
  const failures: string[] = [];
  const graph = graphSweep(failures);
  allocationSweep(failures);
  const malformedBoundaryInputs = boundarySweep(failures);
  return Object.freeze({
    seed: HIGH_CONSEQUENCE_FUZZ_SEED,
    graphCases: HIGH_CONSEQUENCE_GRAPH_CASES,
    allocationCases: HIGH_CONSEQUENCE_ALLOCATION_CASES,
    boundaryCases: HIGH_CONSEQUENCE_BOUNDARY_CASES,
    reachableEdges: graph.reachableEdges,
    unrelatedNodes: graph.unrelatedNodes,
    malformedBoundaryInputs,
    failures: Object.freeze(failures),
    allPropertiesHeld: failures.length === 0,
  });
}

export function formatHighConsequenceFuzzReport(report: HighConsequenceFuzzReport): string {
  const lines = [
    `WP-H03 fuzz assurance: seed=${report.seed} graphCases=${report.graphCases} allocationCases=${report.allocationCases} boundaryCases=${report.boundaryCases}`,
    `reachableEdges=${report.reachableEdges} unrelatedNodes=${report.unrelatedNodes} malformedBoundaryInputs=${report.malformedBoundaryInputs} failures=${report.failures.length}`,
  ];
  for (const failure of report.failures) lines.push(`- ${failure}`);
  return lines.join('\n');
}
