/**
 * Decision Assurance Levels — WP-F05, closing AII-025 and AII-026.
 *
 * ## The gap this closes
 *
 * `certifyDecision` proves strict interval dominance over bare numbers. It is
 * honest about what it proves and silent about where the numbers came from, and
 * that silence was load-bearing: an `observational_separation` from
 * `src/value/frontier.ts` — a comparison in which models were never assigned —
 * could be turned into two intervals, certified `proven_dominant` for
 * `switch_default_model`, and persisted as `decision.fitness_sufficient` with
 * `causality: 'none'`, with nothing on the path asking what the intervals were
 * made of. The observational label existed. The gate did not.
 *
 * ## What an assurance level is, and is not
 *
 * A Decision Assurance Level (DAL) classifies **how much the declared inputs
 * support acting**, and nothing else. It is DERIVED, in this file, from two
 * things the kernel already carries:
 *
 *   1. the ten-axis `ClaimProfile` of every declared input claim, and
 *   2. the dominance certificate's own result — whether an alternative was
 *      actually evaluated and dominated.
 *
 * A caller cannot assert a level. There is no field to assert one with. A caller
 * supplies input identities and their kernel profiles; the level falls out.
 *
 * A DAL is not a probability, not a confidence interval, not a score, and not an
 * authorization. `authorizesAction` is permanently `false`: meeting a level says
 * the evidence requirement for a class of consequence was met, not that Fiscus
 * may act. Execution remains outside this module, as `CONTEXT.md` requires.
 *
 * ## Why `decisionFitness` is not in the ladder
 *
 * It is the axis this assessment is about. Reading it as an input would let a
 * claim assert its own decision fitness and have that assertion raise the level
 * that governs it. Every other axis participates; that one is deliberately
 * excluded, and its exclusion is recorded in `assumptions`.
 *
 * ## Fail closed
 *
 * Unknown stays unknown. No declared inputs is `DAL-0`, not "nothing contrary
 * was found". An undeclared consequence is held to the strictest requirement,
 * not the loosest. Every cap is the WEAKEST input, never an average.
 */

import type { DecisionCertificate } from './engine.ts';
import {
  AUTHENTICITY,

  INTEGRITY,
  MEASUREMENT,
  SCOPE_STATUS,
  claimProfile,
  type ClaimProfile,
} from '../epistemic/profile.ts';

export const DECISION_ASSURANCE_LEVELS = ['DAL-0', 'DAL-1', 'DAL-2', 'DAL-3'] as const;
export type DecisionAssuranceLevel = (typeof DECISION_ASSURANCE_LEVELS)[number];

/** Human-facing names. The code is authoritative; the label is for surfaces. */
export const DECISION_ASSURANCE_LABELS: Readonly<Record<DecisionAssuranceLevel, string>> = Object.freeze({
  'DAL-0': 'unassured',
  'DAL-1': 'advisory',
  'DAL-2': 'reviewed',
  'DAL-3': 'action_supporting',
});

/**
 * What the decision would do if someone acted on it. `undeclared` is not a
 * neutral default — it is held to the strictest requirement, because a caller
 * that has not said what a decision does has not shown it is harmless.
 */
export const DECISION_CONSEQUENCES = ['undeclared', 'no_action', 'advisory_only', 'changes_spend'] as const;
export type DecisionConsequence = (typeof DECISION_CONSEQUENCES)[number];

/**
 * The level each consequence class requires.
 *
 * `changes_spend` requires `DAL-3` for the reason AII-025 names: the only
 * evidence class that supports changing spend on the strength of a comparison is
 * one where the thing being compared was assigned. An observational separation
 * caps at `DAL-2` by construction and is therefore refused here.
 */
export const CONSEQUENCE_REQUIRED_LEVEL: Readonly<Record<DecisionConsequence, DecisionAssuranceLevel>> = Object.freeze({
  undeclared: 'DAL-3',
  no_action: 'DAL-0',
  advisory_only: 'DAL-1',
  changes_spend: 'DAL-3',
});

export interface DecisionAssuranceInput {
  /** The kernel identity of the input claim. */
  readonly id: string;
  /** The kernel's own ten-axis profile for that claim — not a strength assertion. */
  readonly profile: ClaimProfile;
}

/** One reason a level was not reached, named on the axis that capped it. */
export interface DecisionAssuranceShortfall {
  /** `null` when the shortfall is a property of the certificate rather than an input. */
  readonly inputId: string | null;
  readonly axis: string;
  readonly observed: string;
  readonly requiredForLevel: DecisionAssuranceLevel;
  readonly required: string;
}

export interface DecisionAssuranceAssessment {
  readonly level: DecisionAssuranceLevel;
  readonly label: string;
  readonly rule: 'decision_assurance_level.v1';
  readonly basis: 'derived_from_input_claim_profiles_and_dominance_certificate';
  readonly inputs: readonly DecisionAssuranceInput[];
  /** Every axis that blocked the next level up, weakest-input semantics. */
  readonly shortfalls: readonly DecisionAssuranceShortfall[];
  readonly reasons: readonly string[];
  readonly assumptions: readonly string[];
}

export type DecisionAssuranceRefusalCode =
  | 'no_declared_inputs'
  | 'consequence_not_declared'
  | 'assurance_below_required';

export interface DecisionAssuranceRefusal {
  readonly code: DecisionAssuranceRefusalCode;
  readonly message: string;
  readonly observedLevel: DecisionAssuranceLevel;
  readonly requiredLevel: DecisionAssuranceLevel;
  readonly shortfalls: readonly DecisionAssuranceShortfall[];
  readonly remedy: readonly string[];
}

export interface DecisionAssuranceGate {
  readonly consequence: DecisionConsequence;
  readonly requiredLevel: DecisionAssuranceLevel;
  readonly assessment: DecisionAssuranceAssessment;
  /** Whether the evidence requirement for this consequence class was met. */
  readonly meetsRequirement: boolean;
  /** Always false. Meeting a requirement is never permission to act. */
  readonly authorizesAction: false;
  readonly refusal: DecisionAssuranceRefusal | null;
}

const ASSURANCE_ASSUMPTIONS = Object.freeze([
  'The level is the weakest declared input on every axis; inputs are never averaged.',
  'The `decisionFitness` axis is deliberately excluded from the ladder so a claim cannot raise the level that governs it.',
  'A level classifies evidential support for acting; it is never authorization to act, and it is not a probability.',
  'Declared inputs are the complete input set for this decision; an undeclared input cannot lower the level it was left out of.',
]);

const LEVEL_INDEX: Readonly<Record<DecisionAssuranceLevel, number>> = Object.freeze({
  'DAL-0': 0,
  'DAL-1': 1,
  'DAL-2': 2,
  'DAL-3': 3,
});

export function meetsLevel(observed: DecisionAssuranceLevel, required: DecisionAssuranceLevel): boolean {
  return LEVEL_INDEX[observed] >= LEVEL_INDEX[required];
}

function atLeast<T extends string>(value: T, floor: T, order: readonly T[]): boolean {
  return order.indexOf(value) >= order.indexOf(floor);
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be non-empty`);
  return value.trim();
}

/**
 * Normalize declared inputs. `claimProfile` re-validates every axis, so a profile
 * carrying an invented axis value fails here rather than silently ranking.
 */
export function normalizeAssuranceInputs(
  value: unknown,
  label = 'decision assurance inputs',
): readonly DecisionAssuranceInput[] {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const seen = new Set<string>();
  return Object.freeze(value.map((item, index) => {
    if (item === null || typeof item !== 'object') throw new Error(`${label}[${index}] must be an object`);
    const record = item as { id?: unknown; profile?: unknown };
    for (const key of Object.keys(record)) {
      if (key !== 'id' && key !== 'profile') throw new Error(`${label}[${index}] contains unknown field: ${key}`);
    }
    const id = nonEmpty(record.id, `${label}[${index}] id`);
    if (seen.has(id)) throw new Error(`duplicate ${label} entry: ${id}`);
    seen.add(id);
    if (record.profile === null || typeof record.profile !== 'object') {
      throw new Error(`${label}[${index}] profile must be a claim profile`);
    }
    return Object.freeze({ id, profile: claimProfile(record.profile as ClaimProfile) });
  }));
}

export function normalizeConsequence(value: unknown, label = 'decision consequence'): DecisionConsequence {
  if (value === undefined || value === null) return 'undeclared';
  const candidate = nonEmpty(value, label);
  if (!(DECISION_CONSEQUENCES as readonly string[]).includes(candidate)) {
    throw new Error(`${label} must be one of ${DECISION_CONSEQUENCES.join(', ')}`);
  }
  return candidate as DecisionConsequence;
}

/**
 * Axis requirements per level.
 *
 * Read the table as: to reach LEVEL, EVERY declared input must satisfy EVERY row
 * at that level and at every level below it. There is no compensation between
 * axes — a randomized estimand does not buy back missing coverage, because they
 * answer different questions.
 */
interface AxisRule {
  readonly axis: string;
  readonly required: string;
  readonly holds: (profile: ClaimProfile) => boolean;
  readonly observed: (profile: ClaimProfile) => string;
}

const DAL1_RULES: readonly AxisRule[] = Object.freeze([
  {
    axis: 'epistemic',
    required: 'supported',
    holds: (p) => p.epistemic === 'supported',
    observed: (p) => p.epistemic,
  },
  {
    axis: 'integrity',
    required: 'at least unverifiable',
    holds: (p) => atLeast(p.integrity, 'unverifiable', INTEGRITY),
    observed: (p) => p.integrity,
  },
  {
    // The four claims Fiscus refuses to collapse are metered usage, provider-billed
    // cost, allocated cost and realized value. `mixed` means an input already
    // collapsed two of them, so no level above the floor is available to it.
    axis: 'monetaryBasis',
    required: 'a single declared basis, not mixed',
    holds: (p) => p.monetaryBasis !== 'mixed',
    observed: (p) => p.monetaryBasis,
  },
]);

const DAL2_RULES: readonly AxisRule[] = Object.freeze([
  { axis: 'integrity', required: 'verified', holds: (p) => p.integrity === 'verified', observed: (p) => p.integrity },
  {
    axis: 'authenticity',
    required: 'at least self_asserted',
    holds: (p) => atLeast(p.authenticity, 'self_asserted', AUTHENTICITY),
    observed: (p) => p.authenticity,
  },
  {
    axis: 'scope',
    required: 'at least conditional',
    holds: (p) => atLeast(p.scope, 'conditional', SCOPE_STATUS),
    observed: (p) => p.scope,
  },
  { axis: 'coverage', required: 'complete', holds: (p) => p.coverage === 'complete', observed: (p) => p.coverage },
  {
    axis: 'measurement',
    required: 'at least proxy_validated',
    holds: (p) => atLeast(p.measurement, 'proxy_validated', MEASUREMENT),
    observed: (p) => p.measurement,
  },
  {
    axis: 'causality',
    required: 'at least observational',
    holds: (p) => p.causality !== 'none',
    observed: (p) => p.causality,
  },
  {
    axis: 'finality',
    required: 'at least provisional',
    holds: (p) => p.finality !== 'unknown',
    observed: (p) => p.finality,
  },
]);

const DAL3_RULES: readonly AxisRule[] = Object.freeze([
  {
    // AII-025 in one row. `observational` and `quasi_experimental` both mean the
    // thing being compared was not assigned, so the separation is a property of
    // the observed comparison and not of the alternatives being decided between.
    axis: 'causality',
    required: 'randomized',
    holds: (p) => p.causality === 'randomized',
    observed: (p) => p.causality,
  },
  {
    axis: 'measurement',
    required: 'validated',
    holds: (p) => p.measurement === 'validated',
    observed: (p) => p.measurement,
  },
  {
    axis: 'scope',
    required: 'established',
    holds: (p) => p.scope === 'established',
    observed: (p) => p.scope,
  },
  {
    axis: 'authenticity',
    required: 'at least pinned',
    holds: (p) => atLeast(p.authenticity, 'pinned', AUTHENTICITY),
    observed: (p) => p.authenticity,
  },
  {
    // A spend-changing decision priced off list or estimated dollars is a decision
    // about a rate card, not about what the provider charged. `none` stays
    // admissible because a utility need not be denominated in dollars at all.
    axis: 'monetaryBasis',
    required: "an observed money basis ('none', 'provider_observed', 'billed', 'effective', 'allocated' or 'full_cost')",
    holds: (p) => p.monetaryBasis === 'none'
      || p.monetaryBasis === 'provider_observed'
      || p.monetaryBasis === 'billed'
      || p.monetaryBasis === 'effective'
      || p.monetaryBasis === 'allocated'
      || p.monetaryBasis === 'full_cost',
    observed: (p) => p.monetaryBasis,
  },
  {
    axis: 'coverage',
    required: 'complete',
    holds: (p) => p.coverage === 'complete',
    observed: (p) => p.coverage,
  },
]);

const LEVEL_RULES: readonly (readonly [DecisionAssuranceLevel, readonly AxisRule[]])[] = Object.freeze([
  ['DAL-1', DAL1_RULES],
  ['DAL-2', DAL2_RULES],
  ['DAL-3', DAL3_RULES],
]);

function certificateShortfalls(certificate: DecisionCertificate): DecisionAssuranceShortfall[] {
  const out: DecisionAssuranceShortfall[] = [];
  if (certificate.status !== 'proven_dominant') {
    out.push({
      inputId: null,
      axis: 'dominance',
      observed: `${certificate.status} (${certificate.reason})`,
      requiredForLevel: 'DAL-1',
      required: 'proven_dominant',
    });
  }
  // AII-026 in one row: a proposal with no alternative evaluated against it is
  // not a decision, whatever the number attached to it looks like.
  if (certificate.comparisons.length < 2 || certificate.reason === 'no_competitor') {
    out.push({
      inputId: null,
      axis: 'alternatives',
      observed: `${certificate.comparisons.length} action(s) in the problem`,
      requiredForLevel: 'DAL-1',
      required: 'at least one alternative evaluated against the selected action',
    });
  }
  return out;
}

/**
 * Derive the assurance level. Nothing here is asserted by a caller: the level is
 * a function of the dominance certificate and of the kernel profiles of the
 * declared inputs.
 */
export function assessDecisionAssurance(input: {
  readonly certificate: DecisionCertificate;
  readonly inputs: readonly DecisionAssuranceInput[] | unknown;
}): DecisionAssuranceAssessment {
  if (input === null || typeof input !== 'object') throw new Error('decision assurance assessment input must be an object');
  const certificate = input.certificate;
  if (certificate === null || typeof certificate !== 'object') throw new Error('decision assurance requires a decision certificate');
  const inputs = normalizeAssuranceInputs(input.inputs);

  const shortfalls: DecisionAssuranceShortfall[] = [...certificateShortfalls(certificate)];
  const reasons: string[] = [];

  if (inputs.length === 0) {
    // Fail closed. "No input was declared" is not "no problem was found".
    shortfalls.push({
      inputId: null,
      axis: 'declared_inputs',
      observed: 'none',
      requiredForLevel: 'DAL-1',
      required: 'at least one input claim with a kernel claim profile',
    });
    reasons.push('No input claim was declared, so there is no evidence to derive an assurance level from. Unknown stays unknown.');
    return Object.freeze({
      level: 'DAL-0' as const,
      label: DECISION_ASSURANCE_LABELS['DAL-0'],
      rule: 'decision_assurance_level.v1' as const,
      basis: 'derived_from_input_claim_profiles_and_dominance_certificate' as const,
      inputs,
      shortfalls: Object.freeze(shortfalls),
      reasons: Object.freeze(reasons),
      assumptions: ASSURANCE_ASSUMPTIONS,
    });
  }

  let level: DecisionAssuranceLevel = 'DAL-0';
  let blocked = shortfalls.length > 0;
  for (const [candidate, rules] of LEVEL_RULES) {
    const failures: DecisionAssuranceShortfall[] = [];
    for (const item of inputs) {
      for (const rule of rules) {
        if (rule.holds(item.profile)) continue;
        failures.push({
          inputId: item.id,
          axis: rule.axis,
          observed: rule.observed(item.profile),
          requiredForLevel: candidate,
          required: rule.required,
        });
      }
    }
    if (failures.length > 0) shortfalls.push(...failures);
    if (blocked || failures.length > 0) {
      blocked = true;
      continue;
    }
    level = candidate;
  }

  if (certificate.status === 'proven_dominant') {
    reasons.push(`Strict interval dominance selected \`${certificate.action}\` over ${certificate.comparisons.length - 1} evaluated alternative(s).`);
  }
  const capped = shortfalls.filter((item) => LEVEL_INDEX[item.requiredForLevel] === LEVEL_INDEX[level] + 1);
  if (capped.length > 0) {
    const axes = [...new Set(capped.map((item) => item.axis))].sort((a, b) => a.localeCompare(b));
    reasons.push(`Held at ${level} (${DECISION_ASSURANCE_LABELS[level]}) by the weakest declared input on: ${axes.join(', ')}.`);
  } else if (level === 'DAL-3') {
    reasons.push('Every declared input reaches DAL-3 on every axis in the ladder.');
  }

  return Object.freeze({
    level,
    label: DECISION_ASSURANCE_LABELS[level],
    rule: 'decision_assurance_level.v1' as const,
    basis: 'derived_from_input_claim_profiles_and_dominance_certificate' as const,
    inputs,
    shortfalls: Object.freeze(shortfalls),
    reasons: Object.freeze(reasons),
    assumptions: ASSURANCE_ASSUMPTIONS,
  });
}

function remedyFor(shortfalls: readonly DecisionAssuranceShortfall[], required: DecisionAssuranceLevel): readonly string[] {
  const out: string[] = [];
  const relevant = shortfalls.filter((item) => LEVEL_INDEX[item.requiredForLevel] <= LEVEL_INDEX[required]);
  if (relevant.some((item) => item.axis === 'declared_inputs')) {
    out.push('Declare the input claims this decision rests on, with the profiles the kernel already holds for them.');
  }
  if (relevant.some((item) => item.axis === 'alternatives')) {
    out.push('State an objective and evaluate at least one alternative against it; a single proposal is not a decision problem.');
  }
  if (relevant.some((item) => item.axis === 'dominance')) {
    out.push('The intervals do not separate. Narrow them with more evidence, or leave the decision undetermined.');
  }
  if (relevant.some((item) => item.axis === 'causality')) {
    out.push('Assign the alternatives. An observational separation is a property of the observed comparison, not of the options being decided between; the randomized lane in `src/causal/` is what supports a spend change.');
  }
  if (relevant.some((item) => item.axis === 'monetaryBasis')) {
    out.push('Price both sides on one observed money basis. Metered usage, provider-billed cost, allocated cost and realized value are four different claims.');
  }
  if (relevant.some((item) => item.axis === 'coverage' || item.axis === 'measurement' || item.axis === 'scope')) {
    out.push('Close the coverage, measurement-validation or scope gap named in the shortfalls before this decision is used to change spend.');
  }
  if (out.length === 0) out.push('Raise the axes named in the shortfalls, or declare a consequence class this level already supports.');
  return Object.freeze(out);
}

/**
 * The refusal boundary. Read-only and side-effect free: this is the PREVIEW half
 * of preview-then-commit. `buildDecisionKernelIssuance` re-derives the same gate
 * and throws on the commit half, so a caller cannot preview a refusal and then
 * persist anyway.
 */
export function gateDecisionForConsequence(input: {
  readonly certificate: DecisionCertificate;
  readonly inputs: readonly DecisionAssuranceInput[] | unknown;
  readonly consequence: unknown;
}): DecisionAssuranceGate {
  const consequence = normalizeConsequence(input?.consequence);
  const assessment = assessDecisionAssurance({ certificate: input.certificate, inputs: input.inputs });
  const requiredLevel = CONSEQUENCE_REQUIRED_LEVEL[consequence];
  const met = meetsLevel(assessment.level, requiredLevel);

  let refusal: DecisionAssuranceRefusal | null = null;
  if (!met) {
    const code: DecisionAssuranceRefusalCode = assessment.inputs.length === 0
      ? 'no_declared_inputs'
      : consequence === 'undeclared'
        ? 'consequence_not_declared'
        : 'assurance_below_required';
    const subject = consequence === 'undeclared'
      ? 'a decision whose consequence was not declared'
      : consequence === 'changes_spend'
        ? 'a decision that changes spend'
        : `a decision classified \`${consequence}\``;
    refusal = Object.freeze({
      code,
      message:
        `Refused: ${subject} requires decision assurance ${requiredLevel} `
        + `(${DECISION_ASSURANCE_LABELS[requiredLevel]}); the declared inputs reach ${assessment.level} `
        + `(${DECISION_ASSURANCE_LABELS[assessment.level]}).`
        + (assessment.shortfalls.length > 0
          ? ` Shortfalls: ${assessment.shortfalls
            .filter((item) => LEVEL_INDEX[item.requiredForLevel] <= LEVEL_INDEX[requiredLevel])
            .map((item) => `${item.inputId ?? 'certificate'}.${item.axis} is ${item.observed}, needs ${item.required}`)
            .join('; ')}.`
          : ''),
      observedLevel: assessment.level,
      requiredLevel,
      shortfalls: assessment.shortfalls,
      remedy: remedyFor(assessment.shortfalls, requiredLevel),
    });
  }

  return Object.freeze({
    consequence,
    requiredLevel,
    assessment,
    meetsRequirement: met,
    authorizesAction: false as const,
    refusal,
  });
}
