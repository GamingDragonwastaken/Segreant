/**
 * The budget advisor's cap, as a decision problem the decision subsystem can
 * see -- the first product consumer of `src/decision/` (D-220).
 *
 * WHAT THE ADVISOR OWNS. `recommendBudget` proposes a daily cap from observed
 * spend and, when instrumented, the share of that spend which reached a kept
 * outcome. Setting that cap is a decision with an alternative -- leave the cap
 * where it is -- and a consequence: it changes which future spend the proxy
 * admits. Until this file, that decision was presented as a heuristic with a
 * comment saying decisions belong to `src/decision/engine.ts`, and nothing
 * outside `src/decision/` imported the engine. `certifyDecision`,
 * `minimaxRegret`, `buildDecisionKernelIssuance`, `issueDecisionToKernel`,
 * `decisionCountermodels`, `decisionInvalidatingAssumptionSets`,
 * `gateDecisionForConsequence` and the read's `pendingInvalidationBy` were each
 * tested and none reached an operator.
 *
 * THE UTILITY BASIS, STATED SO IT CAN BE REFUSED. The engine needs a utility
 * interval per action, and the advisor's evidence is a daily spend series plus
 * one lifecycle share. No utility model is derived here; one OBJECTIVE is
 * declared and the intervals follow from what is and is not observed:
 *
 *   objective   net well-landed spend over the observed window, in USD --
 *               spend that reached a kept outcome counts +1, spend admitted
 *               that did not counts -1, spend a cap would have blocked counts 0.
 *   replay      each cap clips every observed active day at the cap; no
 *               behavioural response is modelled, and clipping a day is assumed
 *               not to change whether the rest of that day's spend realized.
 *   the unknown the realized TOTAL is observed (share x total) but WHICH days'
 *               spend realized is not, so a cap's interval spans every split of
 *               that total between the spend it admits and the spend it blocks.
 *               Uninstrumented realization widens the total itself to
 *               [0, total spend].
 *
 * That last line is why the certificate is usually `undetermined`: Segreant does
 * not know whether the tail days were the valuable ones, and the interval says
 * so rather than assuming either way. Strict dominance is still reachable --
 * when almost nothing realizes and the cap is far tighter than the current one,
 * admitting less spend nets more under every split -- and the test file shows
 * it. A dominant certificate is decision fitness under this declared rule; it
 * is not a claim that the objective is the right one.
 *
 * D-193'S BAR, AND HOW THIS SURFACE HONOURS IT WHEN IT IS NOT MET. A
 * recommendation that is acted on needs `decisionFitness >= sufficient` AND
 * `measurement >= proxy_validated`. The assurance ladder in
 * `src/decision/assurance.ts` carries both: DAL-1 needs a proven certificate,
 * DAL-2 needs measurement at `proxy_validated`, and a `changes_spend`
 * consequence needs DAL-3. The advisor's declared inputs are the product's own
 * profiles for the metered series and the realization funnel -- `integrity:
 * unknown`, `measurement: proxy_unvalidated`, `causality: none` -- so the gate
 * refuses today from real inputs, and `standing.status` is `review_only` with
 * the refusal's shortfalls as its reason. `certified` exists because the gate
 * can open on inputs the product does not yet issue; it still authorizes
 * nothing, because nothing in `src/decision/` does. `standing.because` says
 * WHICH of the three things kept it review-only -- overlapping intervals, a
 * one-option problem, or a proven certificate whose inputs fall short -- so a
 * dominant-but-uncertified decision is never rendered like an undetermined one.
 *
 * THE REGRET PICK IS NOT A CERTIFICATE. `minimaxRegret` is run over the same
 * intervals and carried verbatim with `rule: 'minimax_regret'`; it is a
 * declared selection rule, is rendered as one, and never changes `standing`.
 *
 * PERSISTENCE IS THE NO-ACTION ARTEFACT, DECLARED AS SUCH. `--apply` writes the
 * cap to config exactly as before -- an operator's act on advisory output -- and
 * additionally persists the certificate bundle through the canonical adapter so
 * the kernel holds what was known when the cap was set, and a later withdrawal
 * of the basis evidence reaches the read as `invalidatedBy` or
 * `pendingInvalidationBy`. The bundle is stored with `actionSemantics.mode:
 * 'no_action'` and `permitted: false` by construction, and the issuance gate is
 * therefore run at `no_action`: that is what the record does. The
 * `changes_spend` gate is the one rendered and returned, and it says the cap
 * write was NOT certified. Gating persistence at `changes_spend` instead would
 * refuse every issuance the product can make today and leave the audit trail
 * empty, which is the unwired-mechanism state this file exists to end.
 */

import { createHash } from 'node:crypto';
import {
  buildUtilityIntervalProblem,
  certifyDecision,
  minimaxRegret,
  preferenceRobustness,
  type ActionUtilityInterval,
  type DecisionCertificate,
  type MinimaxRegretResult,
  type PreferenceRobustnessResult,
  type UtilityIntervalProblem,
} from '../decision/engine.ts';
import { decisionCountermodels, decisionInvalidatingAssumptionSets } from '../decision/countermodels.ts';
import { gateDecisionForConsequence, type DecisionAssuranceGate, type DecisionAssuranceInput } from '../decision/assurance.ts';
import {
  buildDecisionKernelIssuance,
  issueDecisionToKernel,
  readDecisionCertificateBundle,
  type DecisionCertificateBundleRead,
  type DecisionKernelIssuance,
  type DecisionKernelIssuanceInput,
  type DecisionProblemIdentity,
} from '../decision/epistemic.ts';
import type { Countermodel, MinimalInvalidatingSets } from '../epistemic/countermodel.ts';
import { evidence, type CompletenessStatus, type Evidence } from '../epistemic/evidence.ts';
import { grain } from '../epistemic/grain.ts';
import type { EpistemicLedger } from '../epistemic/ledger.ts';
import { scope } from '../epistemic/scope.ts';
import { canonicalJson } from '../epistemic/serialization.ts';
import type { EconomicBasis } from '../economics/money.ts';

/** One problem, versioned: which daily cap the proxy should run. */
export const BUDGET_CAP_PROBLEM: DecisionProblemIdentity = Object.freeze({ id: 'budget-cap:daily', version: 1 });

export const BUDGET_CAP_OBJECTIVE =
  'Net well-landed spend over the observed window, in USD: spend that reached a kept outcome counts +1, '
  + 'spend admitted that did not counts -1, spend the cap would have blocked counts 0.';

const CAP_ASSUMPTIONS = Object.freeze([
  'The observed active-day spend series is replayed under each cap; a cap clips a day at the cap, no behavioural response is modelled, and clipping a day does not change whether the rest of that day\'s spend realized.',
  'realizedSpendShare is a lifecycle share of attributed spend that reached a kept outcome -- not a value figure, not a causal claim, and not a forecast.',
  "Which days' spend realized is not observed; each interval spans every split of the observed realized total between admitted and blocked spend.",
  'When realization is uninstrumented the realized total ranges over [0, total spend].',
]);

export type BudgetCapAction = 'keep_current' | 'apply_recommended';

export interface BudgetCapActionEvaluation {
  readonly action: BudgetCapAction;
  /** The cap this action runs; `null` means no daily cap. */
  readonly capUsd: number | null;
  /** Observed-window spend the cap would have admitted. */
  readonly admittedUsd: number;
  /** Observed-window spend the cap would have blocked. */
  readonly blockedUsd: number;
  readonly utility: { readonly low: number; readonly high: number };
  /** Realized spend inside the admitted portion, over every split consistent with observation. */
  readonly realizedAdmitted: { readonly low: number; readonly high: number };
}

/**
 * The admissible preference set for the cap decision (D-249). The declared
 * objective weighs a realized dollar at +1 and an unrealized admitted dollar
 * at -1; an operator who prices realization higher or lower is still acting
 * on the same evidence. Each entry is a point utility per action, so the set
 * is evaluated at both ends of the realized-admitted interval rather than at
 * a midpoint the evidence does not support. Finite and explicit: a preference
 * not listed here is not admissible, and no weight is inferred.
 */
export const BUDGET_CAP_ADMISSIBLE_PREFERENCES: ReadonlyArray<{
  readonly id: string;
  /** Utility per admitted dollar that realized; unrealized admitted dollars always cost 1. */
  readonly realizedWeight: number;
  readonly end: 'low' | 'high';
  readonly rationale: string;
}> = Object.freeze([
  { id: 'objective:low', realizedWeight: 2, end: 'low', rationale: 'the declared objective at the pessimistic end of the realized-admitted interval' },
  { id: 'objective:high', realizedWeight: 2, end: 'high', rationale: 'the declared objective at the optimistic end of the realized-admitted interval' },
  { id: 'break_even:low', realizedWeight: 1, end: 'low', rationale: 'a realized dollar merely recovers its cost; pessimistic end' },
  { id: 'break_even:high', realizedWeight: 1, end: 'high', rationale: 'a realized dollar merely recovers its cost; optimistic end' },
  { id: 'value_heavy:low', realizedWeight: 4, end: 'low', rationale: 'a realized dollar is worth three more than it cost; pessimistic end' },
  { id: 'value_heavy:high', realizedWeight: 4, end: 'high', rationale: 'a realized dollar is worth three more than it cost; optimistic end' },
]);

function admissiblePreferenceScenarios(actions: readonly BudgetCapActionEvaluation[]) {
  return BUDGET_CAP_ADMISSIBLE_PREFERENCES.map((preference) => ({
    preferenceId: preference.id,
    utilities: Object.fromEntries(actions.map((item) => {
      const realized = item.realizedAdmitted[preference.end];
      return [item.action, preference.realizedWeight * realized - (item.admittedUsd - realized)];
    })),
  }));
}

/**
 * Why the standing is what it is. The first three are the review-only reasons
 * and they are different facts: overlapping intervals say the evidence does not
 * separate the caps; a one-option problem is not a decision; and a proven
 * certificate held below the level a spend change requires is dominance the
 * inputs cannot carry -- which is D-193's bar, not the engine's.
 */
export type BudgetCapStandingReason =
  | 'intervals_overlap'
  | 'no_competitor'
  | 'assurance_below_required'
  | 'certified';

export interface BudgetCapStanding {
  /**
   * `review_only` whenever the `changes_spend` gate refuses -- which it does
   * from every input profile the product issues today. `certified` means the
   * evidence requirement for a spend change was met; it is never authorization.
   */
  readonly status: 'review_only' | 'certified';
  readonly because: BudgetCapStandingReason;
  readonly certifiedForSpendChange: boolean;
  readonly reasons: readonly string[];
}

export interface BudgetCapDecision {
  readonly problem: DecisionProblemIdentity;
  readonly objective: string;
  readonly basis: {
    readonly dailySpends: readonly number[];
    readonly realizedSpendShare: number | null;
    readonly currentDailyCapUsd: number | null;
    readonly recommendedDailyUsd: number;
  };
  readonly actions: readonly BudgetCapActionEvaluation[];
  readonly intervals: readonly ActionUtilityInterval[];
  /** The intervals as the engine's normalized problem: which uncertainty representation they carry (D-249). */
  readonly utilityProblem: UtilityIntervalProblem;
  /** Strict interval dominance, verbatim from the engine. */
  readonly certificate: DecisionCertificate;
  /** The declared ambiguity rule, routed through the same intervals; never a proof. */
  readonly regret: MinimaxRegretResult;
  /** The gate for the consequence acting on this decision has: changing spend. */
  readonly assurance: DecisionAssuranceGate;
  /**
   * Robustness of the pick across the declared admissible preference set
   * (D-249): which actions stay optimal under every admissible weighting of
   * realized against admitted spend, at both ends of the realized interval. A
   * diagnostic beside the certificate; it never moves standing.
   */
  readonly preference: PreferenceRobustnessResult;
  readonly standing: BudgetCapStanding;
  /** "Why not certified?" -- one live witness per stated assumption, and the load-bearing sets. */
  readonly whyNotCertified: {
    readonly countermodels: readonly Countermodel[];
    readonly invalidatingAssumptionSets: MinimalInvalidatingSets;
  };
  readonly assumptions: readonly string[];
}

export interface BudgetCapDecisionInput {
  readonly dailySpends: readonly number[];
  readonly realizedSpendShare: number | null;
  readonly currentDailyCapUsd: number | null | undefined;
  readonly recommendedDailyUsd: number;
  /**
   * Kernel profiles of the claims the decision rests on, from the side that
   * holds the evidence. Absent means undeclared, which the gate reads as DAL-0.
   */
  readonly inputs?: readonly DecisionAssuranceInput[];
}

function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function replay(dailySpends: readonly number[], capUsd: number | null): { admittedUsd: number; blockedUsd: number } {
  let admitted = 0;
  let blocked = 0;
  for (const spend of dailySpends) {
    const day = finite(spend, 'daily spend');
    if (day <= 0) continue;
    const kept = capUsd === null ? day : Math.min(day, capUsd);
    admitted += kept;
    blocked += day - kept;
  }
  return { admittedUsd: admitted, blockedUsd: blocked };
}

function evaluate(
  action: BudgetCapAction,
  capUsd: number | null,
  dailySpends: readonly number[],
  realizedTotal: { readonly low: number; readonly high: number },
): BudgetCapActionEvaluation {
  const { admittedUsd, blockedUsd } = replay(dailySpends, capUsd);
  // Realized spend within the admitted portion, over every split of the
  // realized total consistent with what was observed: at most everything
  // admitted (or everything realized), at least what is left after the blocked
  // portion has absorbed as much of the realized total as it can.
  const realizedAdmittedLow = Math.max(0, realizedTotal.low - blockedUsd);
  const realizedAdmittedHigh = Math.min(admittedUsd, realizedTotal.high);
  return Object.freeze({
    action,
    capUsd,
    admittedUsd,
    blockedUsd,
    utility: Object.freeze({
      low: 2 * realizedAdmittedLow - admittedUsd,
      high: 2 * realizedAdmittedHigh - admittedUsd,
    }),
    realizedAdmitted: Object.freeze({ low: realizedAdmittedLow, high: realizedAdmittedHigh }),
  });
}

/**
 * State the cap decision and run it through the engine, the regret rule, the
 * assurance gate and the countermodels. Pure; nothing is persisted.
 */
export function decideBudgetCap(input: BudgetCapDecisionInput): BudgetCapDecision {
  const dailySpends = Object.freeze(input.dailySpends.filter((spend) => finite(spend, 'daily spend') > 0));
  if (dailySpends.length === 0) throw new Error('a cap decision needs at least one active day of observed spend');
  const recommended = finite(input.recommendedDailyUsd, 'recommendedDailyUsd');
  if (recommended <= 0) throw new Error('recommendedDailyUsd must be positive');
  const current = input.currentDailyCapUsd === undefined || input.currentDailyCapUsd === null
    ? null
    : finite(input.currentDailyCapUsd, 'currentDailyCapUsd');
  if (current !== null && current <= 0) throw new Error('currentDailyCapUsd must be positive or null');
  const share = input.realizedSpendShare;
  if (share !== null && (finite(share, 'realizedSpendShare') < 0 || share > 1)) {
    throw new Error('realizedSpendShare must be within [0, 1] or null');
  }
  const total = dailySpends.reduce((sum, spend) => sum + spend, 0);
  const realizedTotal = share === null
    ? { low: 0, high: total }
    : { low: share * total, high: share * total };

  const actions = Object.freeze([
    evaluate('apply_recommended', recommended, dailySpends, realizedTotal),
    evaluate('keep_current', current, dailySpends, realizedTotal),
  ]);
  const intervals = Object.freeze(actions.map((item) => Object.freeze({
    action: item.action,
    low: item.utility.low,
    high: item.utility.high,
  })));
  const utilityProblem = buildUtilityIntervalProblem(intervals);
  const certificate = certifyDecision(utilityProblem.intervals);
  const regret = minimaxRegret(utilityProblem.intervals);
  const preference = preferenceRobustness(admissiblePreferenceScenarios(actions));
  const assurance = gateDecisionForConsequence({
    certificate,
    inputs: input.inputs ?? [],
    consequence: 'changes_spend',
  });
  const countermodels = decisionCountermodels(intervals);
  const invalidatingAssumptionSets = decisionInvalidatingAssumptionSets(intervals);

  const reasons: string[] = [];
  let because: BudgetCapStandingReason;
  if (certificate.status !== 'proven_dominant') {
    because = certificate.reason === 'no_competitor' ? 'no_competitor' : 'intervals_overlap';
    reasons.push(
      because === 'intervals_overlap'
        ? 'Not certified: the utility intervals overlap, so neither cap strictly dominates under the declared objective. '
          + 'Which days\' spend realized is not observed, and the interval refuses to assume it.'
        : 'Not certified: no alternative was evaluated against the selected cap.',
    );
  } else if (!assurance.meetsRequirement) {
    because = 'assurance_below_required';
    reasons.push(
      `Strict interval dominance holds for ${certificate.action} under the declared objective, but dominance over these `
      + 'intervals is not certification for a spend change: the declared inputs do not reach the level that requires.',
    );
  } else {
    because = 'certified';
  }
  if (assurance.refusal !== null) {
    reasons.push(assurance.refusal.message);
    for (const remedy of assurance.refusal.remedy) reasons.push(`To clear it: ${remedy}`);
  } else {
    reasons.push(
      `Certified for a spend change at ${assurance.assessment.level} (${assurance.assessment.label}) under the declared objective.`,
    );
  }
  reasons.push(
    'A certificate is decision fitness under the declared interval rule and never authorizes the cap; applying it is an '
    + 'operator\'s act on advisory output, and the record says whether the decision was certified when it was applied.',
  );
  const standing: BudgetCapStanding = Object.freeze({
    status: because === 'certified' ? 'certified' : 'review_only',
    because,
    certifiedForSpendChange: because === 'certified',
    reasons: Object.freeze(reasons),
  });

  return Object.freeze({
    problem: BUDGET_CAP_PROBLEM,
    objective: BUDGET_CAP_OBJECTIVE,
    basis: Object.freeze({
      dailySpends,
      realizedSpendShare: share,
      currentDailyCapUsd: current,
      recommendedDailyUsd: recommended,
    }),
    actions,
    intervals,
    utilityProblem,
    certificate,
    regret,
    assurance,
    preference,
    standing,
    whyNotCertified: Object.freeze({ countermodels, invalidatingAssumptionSets }),
    assumptions: Object.freeze([...CAP_ASSUMPTIONS, ...certificate.assumptions]),
  });
}

export interface BudgetCapIssuanceOptions {
  readonly issuedAt: string;
  readonly windowDays: number;
  readonly spendBasis: 'live_proxy' | 'all_observed';
  /** The economic basis of the daily series, or `null` when it is not one basis. */
  readonly monetaryBasis: EconomicBasis | null;
  /**
   * How completely the series covers the window it claims -- the metered
   * claim's own `coverage` axis, which already accounts for retention deletion
   * and pricing gaps. Stated by the caller that holds the evidence; `unknown`
   * when it was not declared.
   */
  readonly seriesCoverage?: CompletenessStatus;
}

const BUNDLE_ID_PREFIX = `evidence:decision:certificate:${BUDGET_CAP_PROBLEM.id}:`;

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex').slice(0, 16);
}

/**
 * The issuance input for the canonical adapter: the basis evidence (the series
 * and share the intervals were computed from), the certificate, and the
 * `no_action` gate. Side-effect free; `issueBudgetCapDecision` persists it.
 */
export function budgetCapIssuanceInput(decision: BudgetCapDecision, opts: BudgetCapIssuanceOptions): DecisionKernelIssuanceInput {
  const issuedAt = opts.issuedAt;
  const issuedMs = Date.parse(issuedAt);
  if (!Number.isFinite(issuedMs)) throw new Error('issuedAt must be an instant');
  if (!Number.isSafeInteger(opts.windowDays) || opts.windowDays <= 0) throw new Error('windowDays must be a positive integer');
  const basisPayload = {
    problem: decision.problem,
    objective: decision.objective,
    dailySpends: decision.basis.dailySpends,
    realizedSpendShare: decision.basis.realizedSpendShare,
    currentDailyCapUsd: decision.basis.currentDailyCapUsd,
    recommendedDailyUsd: decision.basis.recommendedDailyUsd,
    windowDays: opts.windowDays,
    spendBasis: opts.spendBasis,
    issuedAt,
  };
  const key = digest(basisPayload);
  const decisionId = `${BUDGET_CAP_PROBLEM.id}:${key}`;
  const coordinate = { scope: scope({ ledger: 'segreant-budget', problem: BUDGET_CAP_PROBLEM.id }), grain: grain(['day']) };
  const validTime = {
    from: new Date(issuedMs - opts.windowDays * 24 * 60 * 60 * 1000).toISOString(),
    to: issuedAt,
  };
  const basis: Evidence = evidence({
    id: `evidence:budget:cap:basis:${key}`,
    evidenceType: 'budget.cap_decision_basis',
    sourceIdentity: 'segreant:budget-advisor',
    sourceClass: 'segreant_local_daily_spend_series',
    payload: basisPayload as never,
    scope: coordinate.scope,
    grain: coordinate.grain,
    occurredAt: validTime.from,
    validTime,
    observedAt: issuedAt,
    recordedAt: issuedAt,
    assertedAt: issuedAt,
    finalizedAt: null,
    // The request ledger is read, not digested: nothing re-reads those rows to
    // confirm they are unaltered, so this is the same `unknown` the metered
    // claim carries rather than a `verified` borrowed from boundaries that earned it.
    integrity: 'unknown',
    authenticity: 'self_asserted',
    completeness: {
      status: opts.seriesCoverage ?? 'unknown',
      method: 'daily_spend_series_replay',
      coveredEventTypes: ['request'],
      coveredScope: coordinate.scope,
      coveredTime: validTime,
    },
    measurementModelRef: null,
    monetaryBasis: opts.monetaryBasis,
    assumptions: decision.assumptions,
    supersedes: [],
    supersededBy: null,
    revocation: null,
    schemaVersion: 1,
    sensitivity: 'internal',
    redaction: 'none',
  });
  return {
    decisionId,
    decisionProblem: BUDGET_CAP_PROBLEM,
    certificate: decision.certificate,
    intervals: decision.intervals,
    evidence: [{ id: basis.id, record: basis }],
    issuedAt,
    validity: {
      conditions: [
        'Required evidence remains available and unrevoked.',
        'The observed spend series this certificate replays is the one the proxy went on to enforce against.',
      ],
    },
    // The record persists with `no_action` semantics by construction; the gate
    // here says so. The `changes_spend` gate is `decision.assurance`, rendered
    // beside the cap, and it is the one that says the cap write was not certified.
    assurance: {
      consequence: 'no_action',
      inputs: decision.assurance.assessment.inputs,
    },
  };
}

/** Preview the kernel records without persisting them. */
export function previewBudgetCapIssuance(decision: BudgetCapDecision, opts: BudgetCapIssuanceOptions): DecisionKernelIssuance {
  return buildDecisionKernelIssuance(budgetCapIssuanceInput(decision, opts));
}

/** Persist the certificate bundle; replay of the same input is idempotent. */
export function issueBudgetCapDecision(ledger: EpistemicLedger, decision: BudgetCapDecision, opts: BudgetCapIssuanceOptions): DecisionKernelIssuance {
  return issueDecisionToKernel(ledger, budgetCapIssuanceInput(decision, opts));
}

/**
 * Every persisted cap certificate, revalidated at `asOf`, latest first. Each
 * read carries `invalidatedBy` and `pendingInvalidationBy`, which is the
 * mechanism WP-R07 built and nothing rendered.
 */
export function readBudgetCapCertificates(ledger: EpistemicLedger, asOf: string): readonly DecisionCertificateBundleRead[] {
  const ids = ledger.graph().nodes
    .filter((node) => node.kind === 'evidence' && node.id.startsWith(BUNDLE_ID_PREFIX))
    .map((node) => node.id);
  const reads: DecisionCertificateBundleRead[] = [];
  for (const id of ids) {
    const read = readDecisionCertificateBundle(ledger, id, asOf);
    if (read !== null && read.bundle.decisionProblem.id === BUDGET_CAP_PROBLEM.id) reads.push(read);
  }
  return Object.freeze(reads.sort((a, b) => {
    const order = Date.parse(b.bundle.validity.issuedAt) - Date.parse(a.bundle.validity.issuedAt);
    return order !== 0 ? order : a.bundle.id.localeCompare(b.bundle.id);
  }));
}

function money(value: number): string {
  const sign = value < 0 ? '-' : '';
  const magnitude = Math.abs(value);
  return `${sign}$${magnitude >= 1 ? magnitude.toFixed(2) : magnitude.toFixed(4)}`;
}

function capLabel(capUsd: number | null): string {
  return capUsd === null ? 'no cap' : money(capUsd);
}

/**
 * The operator-facing block, as lines. Plain text so the CLI and any other
 * surface print the same words; the CLI adds colour.
 *
 * What the block must never do: present the regret pick as dominance, present
 * a proven certificate as a recommendation when the inputs fall short, or
 * present a truncated invalidating-set search as the whole answer.
 */
export function renderBudgetCapDecision(decision: BudgetCapDecision, certificates: readonly DecisionCertificateBundleRead[], canonical: DecisionKernelIssuance): readonly string[] {
  if (canonical.certificateBundle.decisionProblem.id !== decision.problem.id
      || canonical.certificateBundle.decisionProblem.version !== decision.problem.version
      || canonicalJson(canonical.certificateBundle.dominance) !== canonicalJson(decision.certificate)) {
    throw new Error('canonical decision preview does not match the budget decision being rendered');
  }
  const lines: string[] = [];
  const standing = decision.standing.status === 'review_only' ? 'REVIEW ONLY' : 'CERTIFIED (never authorization)';
  lines.push(`Decision — ${decision.problem.id} v${decision.problem.version}: ${standing}`);
  lines.push(`  Objective   ${decision.objective}`);
  for (const action of decision.actions) {
    lines.push(
      `  ${action.action.padEnd(18)} ${capLabel(action.capUsd).padStart(9)}   admits ${money(action.admittedUsd)} · blocks ${money(action.blockedUsd)}`
      + `   utility [${money(action.utility.low)}, ${money(action.utility.high)}]`,
    );
  }
  const certificate = canonical.certificateBundle.dominance;
  lines.push(
    certificate.status === 'proven_dominant'
      ? `  Certificate  proven_dominant: ${certificate.action} by a margin of ${money(certificate.margin ?? 0)} (${certificate.rule})`
      : `  Certificate  ${certificate.status} (${certificate.reason}) under ${certificate.rule}`,
  );
  lines.push(
    canonical.decision === null
      ? '  Kernel claim  no decision-fitness Claim issued (certificate is undetermined).'
      : `  Kernel claim  ${canonical.decision.id} · decisionFitness=${canonical.decision.profile.decisionFitness}`,
  );
  lines.push(
    `  Minimax regret selects ${decision.regret.actions.join(', ')} (worst-case regret ${money(decision.regret.minimaxRegret)}) — `
    + `rule ${decision.regret.rule}: a declared selection rule, not dominance and not proof of objective optimality.`,
  );
  const pref = decision.preference;
  lines.push(
    `  Preference   ${pref.status}: ${pref.robustOptimalActions.length > 0 ? `${pref.robustOptimalActions.join(', ')} stays optimal` : 'no action stays optimal'} `
    + `across ${pref.preferenceIds.length} declared admissible preferences — a robustness diagnostic, not a recommendation.`,
  );
  const assessment = decision.assurance.assessment;
  lines.push(
    `  Assurance    ${assessment.level} (${assessment.label}), derived from ${assessment.inputs.length} declared input claim(s) and the certificate; `
    + `a spend change requires ${decision.assurance.requiredLevel}.`,
  );
  for (const reason of decision.standing.reasons) lines.push(`  · ${reason}`);
  lines.push('  Why not certified? Each stated assumption has a live countermodel; the observation that would exclude it is named.');
  for (const model of decision.whyNotCertified.countermodels) {
    lines.push(`    [${model.status}] ${model.world}`);
    lines.push(`      excluded by: ${model.excludedBy ?? 'nothing available here'}`);
  }
  const sets = decision.whyNotCertified.invalidatingAssumptionSets;
  if (sets.sets.length > 0) {
    const listed = sets.sets.map((set) => set.map((assumption) => `"${assumption}"`).join(' + ')).join('; ');
    lines.push(
      sets.truncated
        ? `    Would flip it (search capped at ${sets.limit}, so not certified minimal): ${listed}`
        : `    Would flip it: ${listed}`,
    );
    lines.push(
      sets.inertAssumptions === null
        ? '    Inert assumptions: not determined (the search was capped).'
        : sets.inertAssumptions.length === 0
          ? '    Inert assumptions: none — every stated assumption is in some minimal set.'
          : `    Inert assumptions: ${sets.inertAssumptions.map((assumption) => `"${assumption}"`).join('; ')}`,
    );
  } else {
    lines.push(`    Would flip it: nothing to flip (${sets.emptyBecause ?? 'no set found within the search bound'}).`);
  }
  if (certificates.length === 0) {
    lines.push('  Kernel record  not yet recorded — --apply persists this certificate as a no-action bundle.');
  } else {
    for (const read of certificates) {
      const pending = read.pendingInvalidationBy.length === 0
        ? 'no withdrawal booked'
        : `withdrawal booked against ${read.pendingInvalidationBy.join(', ')}`;
      const invalidated = read.invalidatedBy.length === 0 ? '' : ` · invalidated by ${read.invalidatedBy.join(', ')}`;
      lines.push(`  Kernel record  ${read.bundle.id}`);
      lines.push(`                 issued ${read.bundle.validity.issuedAt} · ${read.status}${invalidated} · ${pending} · canAutoAct=${read.canAutoAct}`);
    }
  }
  return Object.freeze(lines);
}
