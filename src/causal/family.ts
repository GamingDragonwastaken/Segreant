/**
 * Cross-study inferential-family boundary (WP-E06).
 *
 * This is a planning contract, not a claim issuer. Arbitrary dependence gets
 * Bonferroni. Šidák is available only when the caller explicitly declares
 * independence; a supplied correlation matrix is refused until a validated
 * correlation procedure exists, rather than being treated as evidence.
 */

export interface InferenceFamilyInput {
  readonly familyId: string;
  readonly targetFamilywiseErrorRate: number;
  readonly dependence: 'arbitrary' | 'independent' | 'declared_correlation';
  readonly studies: readonly { readonly studyId: string; readonly plannedActs: number }[];
  readonly correlationUpperBounds?: readonly (readonly number[])[];
}

export interface InferenceFamilyAssessment {
  readonly familyId: string;
  readonly status: 'review_only';
  readonly method: 'bonferroni' | 'sidak_independence';
  readonly studyIds: readonly string[];
  readonly totalPlannedActs: number;
  readonly perActAlpha: number;
  readonly assumptions: readonly string[];
  readonly nonClaims: readonly string[];
}

function identifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value)) throw new Error(`${label} must be a bounded identifier`);
}

export function assessInferenceFamily(input: InferenceFamilyInput): InferenceFamilyAssessment {
  if (input === null || typeof input !== 'object') throw new Error('inference family must be an object');
  identifier(input.familyId, 'familyId');
  if (typeof input.targetFamilywiseErrorRate !== 'number' || !Number.isFinite(input.targetFamilywiseErrorRate)
      || input.targetFamilywiseErrorRate <= 0 || input.targetFamilywiseErrorRate >= 1) {
    throw new Error('targetFamilywiseErrorRate must be in (0,1)');
  }
  if (!['arbitrary', 'independent', 'declared_correlation'].includes(input.dependence)) throw new Error('dependence mode is unsupported');
  if (input.dependence === 'declared_correlation') throw new Error('correlation-adjusted multiplicity is not implemented; refuse rather than infer a matrix model');
  if (!Array.isArray(input.studies) || input.studies.length === 0) throw new Error('studies must be non-empty');
  const seen = new Set<string>();
  let total = 0;
  for (const [index, study] of input.studies.entries()) {
    identifier(study.studyId, `studies[${index}].studyId`);
    if (seen.has(study.studyId)) throw new Error(`duplicate studyId: ${study.studyId}`);
    seen.add(study.studyId);
    if (!Number.isSafeInteger(study.plannedActs) || study.plannedActs <= 0) throw new Error(`studies[${index}].plannedActs must be positive`);
    total += study.plannedActs;
    if (!Number.isSafeInteger(total) || total > 1_000_000) throw new Error('total planned acts exceed bounded family limit');
  }
  const perActAlpha = input.dependence === 'arbitrary'
    ? input.targetFamilywiseErrorRate / total
    : 1 - Math.pow(1 - input.targetFamilywiseErrorRate, 1 / total);
  return Object.freeze({
    familyId: input.familyId,
    status: 'review_only',
    method: input.dependence === 'arbitrary' ? 'bonferroni' : 'sidak_independence',
    studyIds: Object.freeze([...seen].sort()),
    totalPlannedActs: total,
    perActAlpha,
    assumptions: Object.freeze([
      input.dependence === 'arbitrary'
        ? 'Studies and acts may have arbitrary dependence; Bonferroni is the conservative family rule.'
        : 'The caller declares independence among study/act tests; Šidák is used only under that declaration.',
      'Every study contributes its pre-registered planned act count; post-hoc discovery does not expand this family.',
    ]),
    nonClaims: Object.freeze([
      'This is a review-only error-budget plan, not a causal result or a guarantee that the declared dependence assumption holds; independence is not validated here.',
      'No correlation matrix is estimated or trusted; correlation-adjusted multiplicity remains an explicit open method.',
    ]),
  });
}
