/**
 * WP-H03: bounded mutation assurance for high-consequence invariants.
 *
 * This is deliberately a small mutation-testing seam, not a fuzzing framework.
 * Each case constructs one fixed, in-memory counterexample and substitutes a
 * faulty predicate/input mutation. The refusal assertion is run against that
 * mutant. A thrown AssertionError means the adversarial test would go red under
 * the mutation, so the mutation is killed. No database, network, clock, random
 * source, or filesystem write is involved.
 */
import assert from 'node:assert/strict';
import { AssertionError } from 'node:assert';
import {
  applyExactAllocation,
  validateExactAllocationResult,
  type ExactAllocationRunResult,
  type ExactAllocatableRow,
} from '../../src/alloc/exact.ts';
import type { AllocationRule, CostCentre } from '../../src/alloc/rules.ts';
import { addMoney, compareMoney, money, type Money } from '../../src/economics/money.ts';
import {
  assessCompleteness,
  completenessWitness,
  type CompletenessAssessment,
  type NegativeClaimTarget,
} from '../../src/measurement/completeness.ts';
import { scope } from '../../src/epistemic/scope.ts';
import { interval } from '../../src/epistemic/time.ts';
import { revocationClosure, type DependencyEdge } from '../../src/epistemic/revocation.ts';
import { causalEventHash } from '../../src/causal/protocol.ts';
import { qualifyCausalStudy } from '../../src/causal/qualification.ts';
import type { CausalQualification } from '../../src/causal/types.ts';
import { completedData, H } from './causalStudyFixture.ts';
import {
  certifyDecision,
  type ActionUtilityInterval,
  type DecisionCertificate,
} from '../../src/decision/engine.ts';

export type MutationOutcome = 'accepted' | 'refused' | 'errored';
export type MutationAssurance = 'killed' | 'survived';

export interface HighConsequenceMutationResult {
  readonly name: string;
  readonly target: string;
  readonly expectedRefusal: string;
  /** The unsafe mutant's outcome before the adversarial refusal assertion. */
  readonly actualOutcome: MutationOutcome;
  /** `killed` means the refusal assertion failed under this mutant. */
  readonly assurance: MutationAssurance;
  readonly observation: string;
}

export interface HighConsequenceMutationReport {
  readonly mutations: readonly HighConsequenceMutationResult[];
  readonly killed: number;
  readonly survived: number;
  readonly allKilled: boolean;
}

interface PreparedMutation {
  readonly actualOutcome: MutationOutcome;
  /** This is the assertion that should fail when the mutant is present. */
  readonly refusalAssertion: () => void;
}

interface MutationDefinition {
  readonly name: string;
  readonly target: string;
  readonly expectedRefusal: string;
  readonly prepare: () => PreparedMutation;
}

const PERIOD_START_MS = 0;
const PERIOD_END_MS = 100;
const RUN_AT_MS = 100;

const EXACT_CENTRE: CostCentre = {
  costCentreId: 'eng',
  name: 'Engineering',
  owner: null,
  createdAtMs: 0,
  archivedAtMs: null,
};

const EXACT_RULE: AllocationRule = {
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
};

function exactFixture(): ExactAllocationRunResult {
  const row: ExactAllocatableRow = {
    sourceEventIds: ['economic:source:one'],
    amount: money('1', 'USD', 'list'),
    project: 'backend-api',
    provider: 'openai',
    model: 'gpt-4o',
    source: null,
    user: null,
    tsEpochMs: 10,
  };
  return applyExactAllocation({
    rows: [row],
    rules: [EXACT_RULE],
    costCentres: [EXACT_CENTRE],
    periodStartMs: PERIOD_START_MS,
    periodEndMs: PERIOD_END_MS,
    runAtMs: RUN_AT_MS,
  });
}

function incrementMoney(value: Money): Money {
  return Object.freeze({
    ...value,
    coefficient: value.coefficient + 1n,
  });
}

function withShiftedLine(result: ExactAllocationRunResult): ExactAllocationRunResult {
  const first = result.lines[0];
  assert.ok(first, 'exact fixture must contain one allocation line');
  return {
    ...result,
    lines: result.lines.map((line, index) => index === 0
      ? { ...line, amount: incrementMoney(line.amount) }
      : line),
  };
}

function withShiftedSummaryAndLine(result: ExactAllocationRunResult): ExactAllocationRunResult {
  const firstLine = result.lines[0];
  const firstBucket = result.allocatedByIdentity[0];
  assert.ok(firstLine, 'exact fixture must contain one allocation line');
  assert.ok(firstBucket, 'exact fixture must contain one allocation bucket');
  const shifted = incrementMoney(firstLine.amount);
  return {
    ...result,
    allocatedByIdentity: result.allocatedByIdentity.map((bucket, index) => index === 0
      ? { ...bucket, amount: incrementMoney(bucket.amount) }
      : bucket),
    lines: result.lines.map((line, index) => index === 0
      ? { ...line, amount: shifted }
      : line),
    conserves: false,
  };
}

/** Mutant: the persisted boolean is treated as proof instead of a conclusion. */
function mutatedBooleanConservationPredicate(value: ExactAllocationRunResult): boolean {
  return value.conserves;
}

/**
 * Mutant: summary buckets are checked, but detailed allocation lines are not.
 * The fixture has one identity, making this deliberately bounded and exact.
 */
function mutatedSummaryOnlyConservationPredicate(value: ExactAllocationRunResult): boolean {
  if (!value.conserves || value.totalByIdentity.length !== 1 || value.allocatedByIdentity.length !== 1) return false;
  if (value.unallocatedByIdentity.length > 1) return false;
  const total = value.totalByIdentity[0]!;
  const allocated = value.allocatedByIdentity[0]!;
  const unallocated = value.unallocatedByIdentity[0] ?? {
    ...total,
    amount: money('0', total.currency, total.basis),
  };
  return compareMoney(total.amount, addMoney(allocated.amount, unallocated.amount)) === 0;
}

const COMPLETENESS_TARGET: NegativeClaimTarget = {
  eventType: 'linked_incident',
  scope: scope({ organization: 'acme', project: 'atlas' }),
  period: interval('2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'),
};

function completenessFixture(): CompletenessAssessment {
  const supporting = completenessWitness({
    id: 'incident-feed-complete',
    sourceId: 'pager',
    state: 'supported',
    eventTypes: ['linked_incident'],
    scope: scope({ organization: 'acme' }),
    period: interval('2026-07-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
  });
  const refuting = completenessWitness({
    id: 'incident-feed-gap',
    sourceId: 'pager-audit',
    state: 'refuted',
    eventTypes: ['linked_incident'],
    scope: scope({ organization: 'acme', project: 'atlas' }),
    period: interval('2026-08-10T00:00:00.000Z', '2026-08-12T00:00:00.000Z'),
  });
  return assessCompleteness(COMPLETENESS_TARGET, [supporting, refuting]);
}

/** Mutant: a supporting witness wins even when completeness is conflicted. */
function mutatedCompletenessPredicate(value: CompletenessAssessment): boolean {
  return value.qualifyingWitnessIds.length > 0;
}

const REVOCATION_GRAPH: readonly DependencyEdge[] = [
  { from: 'evidence:invoice', to: 'claim:billed-cost' },
  { from: 'claim:billed-cost', to: 'claim:allocated-cost' },
  { from: 'claim:allocated-cost', to: 'decision:budget' },
  { from: 'evidence:experiment', to: 'claim:causal-value' },
  { from: 'claim:causal-value', to: 'decision:budget' },
];

function revocationFixture(): readonly string[] {
  return revocationClosure(['evidence:invoice'], REVOCATION_GRAPH);
}

function omittedTransitiveRevocationClosure(): readonly string[] {
  const graphWithoutTransitiveEdge = REVOCATION_GRAPH.filter((edge) =>
    !(edge.from === 'claim:billed-cost' && edge.to === 'claim:allocated-cost'),
  );
  return revocationClosure(['evidence:invoice'], graphWithoutTransitiveEdge);
}

function causalPlanMutationInput(): Parameters<typeof qualifyCausalStudy>[0] {
  const data = completedData();
  const original = data.executions[0];
  assert.ok(original, 'causal fixture must contain an execution');
  const alteredCore = {
    ...original,
    actualExecutionPlanHash: H('f'),
  };
  const altered = {
    ...alteredCore,
    eventHash: causalEventHash({ ...alteredCore, eventHash: undefined }),
  };
  return {
    ...data,
    executions: data.executions.map((execution, index) => index === 0 ? altered : execution),
  };
}

/**
 * Mutant: the execution-plan failure is removed from the qualification gate.
 * A valid protocol with one altered execution plan must not become qualified.
 */
function mutatedCausalQualificationGate(data: Parameters<typeof qualifyCausalStudy>[0]): boolean {
  const qualification = qualifyCausalStudy(data);
  const withoutPlanGate = qualification.reasons.filter(
    (reason) => !reason.includes('does not confirm the assigned intervention plan')
      && !reason.includes('does not bind a qualifying execution'),
  );
  return withoutPlanGate.length === 0;
}

const OVERLAPPING_INTERVALS: readonly ActionUtilityInterval[] = [
  { action: 'keep-premium', low: 1, high: 9 },
  { action: 'route-cheap', low: 4, high: 10 },
];

/** Mutant: any rival comparison is treated as a positive dominance margin. */
function mutatedDominancePredicate(certificate: DecisionCertificate): boolean {
  return certificate.comparisons.some((comparison) => comparison.margin !== null);
}

const MUTATIONS: readonly MutationDefinition[] = [
  {
    name: 'forged conservation boolean',
    target: 'validateExactAllocationResult.conserves',
    expectedRefusal: 'reject a non-conserving exact allocation even when conserves=true',
    prepare: () => {
      const baseline = exactFixture();
      assert.doesNotThrow(() => validateExactAllocationResult(baseline));
      const candidate = withShiftedSummaryAndLine(baseline);
      assert.throws(() => validateExactAllocationResult({ ...candidate, conserves: true }), /does not conserve/);
      const mutantAccepted = mutatedBooleanConservationPredicate({ ...candidate, conserves: true });
      return {
        actualOutcome: mutantAccepted ? 'accepted' : 'refused',
        refusalAssertion: () => assert.equal(
          mutatedBooleanConservationPredicate({ ...candidate, conserves: true }),
          false,
          'the forged conservation boolean must be refused',
        ),
      };
    },
  },
  {
    name: 'conservation line-total drift',
    target: 'validateExactAllocationResult.lines versus allocatedByIdentity',
    expectedRefusal: 'reject line totals that drift from the persisted allocated summary',
    prepare: () => {
      const baseline = exactFixture();
      assert.doesNotThrow(() => validateExactAllocationResult(baseline));
      const candidate = withShiftedLine(baseline);
      assert.throws(() => validateExactAllocationResult(candidate), /line totals/);
      const mutantAccepted = mutatedSummaryOnlyConservationPredicate(candidate);
      return {
        actualOutcome: mutantAccepted ? 'accepted' : 'refused',
        refusalAssertion: () => assert.equal(
          mutatedSummaryOnlyConservationPredicate(candidate),
          false,
          'summary conservation must not hide line-total drift',
        ),
      };
    },
  },
  {
    name: 'conflicted completeness downgraded to supported',
    target: 'assessCompleteness.state and qualifiesAbsenceInference',
    expectedRefusal: 'withhold absence inference when supported and refuted completeness witnesses conflict',
    prepare: () => {
      const baseline = completenessFixture();
      assert.equal(baseline.state, 'conflicted');
      assert.equal(baseline.qualifiesAbsenceInference, false);
      const mutantAccepted = mutatedCompletenessPredicate(baseline);
      return {
        actualOutcome: mutantAccepted ? 'accepted' : 'refused',
        refusalAssertion: () => assert.equal(
          mutatedCompletenessPredicate(baseline),
          false,
          'a conflicting completeness result must not qualify absence',
        ),
      };
    },
  },
  {
    name: 'transitive revocation edge omitted',
    target: 'revocationClosure prerequisite-to-dependent traversal',
    expectedRefusal: 'return every transitive dependent when a prerequisite is revoked',
    prepare: () => {
      const expected = revocationFixture();
      assert.ok(expected.includes('claim:allocated-cost'));
      assert.ok(expected.includes('decision:budget'));
      const mutant = omittedTransitiveRevocationClosure();
      const mutantAccepted = !mutant.includes('decision:budget');
      return {
        actualOutcome: mutantAccepted ? 'accepted' : 'refused',
        refusalAssertion: () => assert.deepEqual(
          mutant,
          expected,
          'an omitted transitive edge must not shorten revocation closure',
        ),
      };
    },
  },
  {
    name: 'execution-plan qualification gate removed',
    target: 'qualifyCausalStudy.execution.actualExecutionPlanHash',
    expectedRefusal: 'withhold causal qualification when execution deviates from the assigned plan',
    prepare: () => {
      const mutatedInput = causalPlanMutationInput();
      const baseline = qualifyCausalStudy(mutatedInput);
      assert.equal(baseline.state, 'invalid');
      assert.ok(baseline.reasons.some((reason) => reason.includes('does not confirm the assigned intervention plan')));
      const mutantAccepted = mutatedCausalQualificationGate(mutatedInput);
      return {
        actualOutcome: mutantAccepted ? 'accepted' : 'refused',
        refusalAssertion: () => assert.equal(
          mutatedCausalQualificationGate(mutatedInput),
          false,
          'execution-plan deviation must prevent causal qualification',
        ),
      };
    },
  },
  {
    name: 'one-rival dominance accepted as robust dominance',
    target: 'certifyDecision strict positive lower-bound margin',
    expectedRefusal: 'withhold dominance when utility intervals overlap',
    prepare: () => {
      const baseline = certifyDecision(OVERLAPPING_INTERVALS);
      assert.equal(baseline.status, 'undetermined');
      assert.equal(baseline.action, null);
      const mutantAccepted = mutatedDominancePredicate(baseline);
      return {
        actualOutcome: mutantAccepted ? 'accepted' : 'refused',
        refusalAssertion: () => assert.equal(
          mutatedDominancePredicate(baseline),
          false,
          'an interval with a non-positive margin is not robust dominance',
        ),
      };
    },
  },
];

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replaceAll(/\s+/g, ' ').trim().slice(0, 240);
}

function runMutation(definition: MutationDefinition): HighConsequenceMutationResult {
  let prepared: PreparedMutation;
  try {
    prepared = definition.prepare();
  } catch (error) {
    return Object.freeze({
      name: definition.name,
      target: definition.target,
      expectedRefusal: definition.expectedRefusal,
      actualOutcome: 'errored',
      assurance: 'survived',
      observation: `mutation setup errored: ${errorText(error)}`,
    });
  }

  try {
    prepared.refusalAssertion();
    return Object.freeze({
      name: definition.name,
      target: definition.target,
      expectedRefusal: definition.expectedRefusal,
      actualOutcome: prepared.actualOutcome,
      assurance: 'survived',
      observation: 'the adversarial refusal assertion passed under the mutant',
    });
  } catch (error) {
    if (!(error instanceof AssertionError)) {
      return Object.freeze({
        name: definition.name,
        target: definition.target,
        expectedRefusal: definition.expectedRefusal,
        actualOutcome: 'errored',
        assurance: 'survived',
        observation: `adversarial refusal assertion errored: ${errorText(error)}`,
      });
    }
    return Object.freeze({
      name: definition.name,
      target: definition.target,
      expectedRefusal: definition.expectedRefusal,
      actualOutcome: prepared.actualOutcome,
      assurance: 'killed',
      observation: `adversarial refusal assertion failed under mutant: ${errorText(error)}`,
    });
  }
}

/** Run the fixed WP-H03 mutation set in declaration order. */
export function runHighConsequenceMutationAssurance(): HighConsequenceMutationReport {
  const mutations = Object.freeze(MUTATIONS.map(runMutation));
  const killed = mutations.filter((mutation) => mutation.assurance === 'killed').length;
  const survived = mutations.length - killed;
  return Object.freeze({
    mutations,
    killed,
    survived,
    allKilled: survived === 0,
  });
}

/** Human-readable, deterministic output suitable for a focused test/CI log. */
export function formatHighConsequenceMutationReport(report: HighConsequenceMutationReport): string {
  const lines = [
    `WP-H03 mutation assurance: ${report.killed}/${report.mutations.length} killed; ${report.survived} survived`,
  ];
  for (const mutation of report.mutations) {
    lines.push(
      `- ${mutation.name} target=${mutation.target} expected refusal=${mutation.expectedRefusal}`
      + ` actual outcome=${mutation.actualOutcome} assurance=${mutation.assurance}`,
    );
  }
  return lines.join('\n');
}
