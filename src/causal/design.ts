/**
 * Protocol-linked causal design evidence (WP-E04).
 *
 * The v1/v2 committed protocol bytes remain immutable and backward compatible.
 * This separate, hash-bound declaration is the design boundary for missingness,
 * attrition, interference and exposure mapping. It qualifies a declared design
 * only; it never turns a declaration into observed missing-data evidence or a
 * measured absence of interference.
 */

export const CAUSAL_DESIGN_TYPE = 'fiscus.causal-design' as const;
export const CAUSAL_DESIGN_VERSION = 1 as const;

type Digest = `sha256:${string}`;
type Identifier = string;

export type MissingnessMechanism = 'mcAR' | 'mar' | 'mnar' | 'unknown' | 'not_applicable';
export type InterferenceAssumption = 'none_declared' | 'clustered' | 'not_established';
export type CausalDesignEstimand = 'itt' | 'cluster_itt' | 'exposure_effect';

export interface CausalDesignPlan {
  readonly type: typeof CAUSAL_DESIGN_TYPE;
  readonly version: typeof CAUSAL_DESIGN_VERSION;
  readonly designId: Identifier;
  /** Must equal the committed causal protocol's structural hash. */
  readonly protocolHash: Digest;
  readonly targetPopulation: {
    readonly populationId: Identifier;
    readonly scope: string;
  };
  readonly missingness: {
    readonly mechanism: MissingnessMechanism;
    readonly indicatorIds: readonly Identifier[];
    readonly reasonCodes: readonly Identifier[];
    /** Declared attrition sensitivity range, not an estimated probability. */
    readonly attritionSensitivity: { readonly low: number; readonly high: number };
  };
  readonly interference: {
    readonly assumption: InterferenceAssumption;
    readonly clusterIdSource: Identifier | null;
    readonly exposureMapping: {
      readonly mappingId: Identifier;
      readonly variables: readonly Identifier[];
      readonly digest: Digest;
    } | null;
  };
  readonly estimands: readonly CausalDesignEstimand[];
}

export interface CausalDesignAssessment {
  readonly type: typeof CAUSAL_DESIGN_TYPE;
  readonly version: typeof CAUSAL_DESIGN_VERSION;
  readonly designId: Identifier;
  readonly protocolHash: Digest;
  readonly status: 'qualified' | 'withheld';
  readonly estimands: readonly CausalDesignEstimand[];
  readonly targetPopulation: CausalDesignPlan['targetPopulation'];
  readonly missingness: CausalDesignPlan['missingness'];
  readonly interference: CausalDesignPlan['interference'];
  readonly reasons: readonly string[];
  readonly limitations: readonly string[];
  readonly nonClaims: readonly string[];
}

export class CausalDesignValidationError extends Error {
  readonly code = 'CAUSAL_DESIGN_INVALID';

  constructor(message: string) {
    super(`CAUSAL_DESIGN_INVALID: ${message}`);
    this.name = 'CausalDesignValidationError';
  }
}

function fail(message: string): never {
  throw new CausalDesignValidationError(message);
}

function identifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value)) fail(`${label} must be a bounded identifier`);
}

function digest(value: unknown, label: string): asserts value is Digest {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value)) fail(`${label} must be a lowercase SHA-256 digest`);
}

function stringList(value: unknown, label: string, required: boolean): readonly string[] {
  if (!Array.isArray(value) || (!required && value.length === 0)) {
    if (required) fail(`${label} must be a non-empty identifier list`);
    return Object.freeze([]);
  }
  const values = value.map((item, index) => {
    identifier(item, `${label}[${index}]`);
    return item;
  });
  if (new Set(values).size !== values.length) fail(`${label} must not contain duplicates`);
  if (required && values.length === 0) fail(`${label} must be a non-empty identifier list`);
  return Object.freeze(values);
}

function range(value: unknown, label: string): { readonly low: number; readonly high: number } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const low = (value as { low?: unknown }).low;
  const high = (value as { high?: unknown }).high;
  if (typeof low !== 'number' || !Number.isFinite(low) || typeof high !== 'number' || !Number.isFinite(high)
      || low < 0 || high > 1 || low > high) {
    fail(`${label} must be finite with 0 <= low <= high <= 1`);
  }
  return Object.freeze({ low, high });
}

function validatePlan(plan: CausalDesignPlan): void {
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) fail('design plan must be an object');
  if (plan.type !== CAUSAL_DESIGN_TYPE || plan.version !== CAUSAL_DESIGN_VERSION) fail('design type or version is unsupported');
  identifier(plan.designId, 'designId');
  digest(plan.protocolHash, 'protocolHash');
  if (plan.targetPopulation === null || typeof plan.targetPopulation !== 'object' || Array.isArray(plan.targetPopulation)) fail('targetPopulation is invalid');
  identifier(plan.targetPopulation.populationId, 'targetPopulation.populationId');
  if (typeof plan.targetPopulation.scope !== 'string' || plan.targetPopulation.scope.trim() === '') fail('targetPopulation.scope is required');

  const missingness = plan.missingness;
  if (missingness === null || typeof missingness !== 'object' || Array.isArray(missingness)) fail('missingness declaration is required');
  if (!['mcAR', 'mar', 'mnar', 'unknown', 'not_applicable'].includes(missingness.mechanism)) fail('missingness.mechanism is unsupported');
  stringList(missingness.indicatorIds, 'missingness.indicatorIds', true);
  stringList(missingness.reasonCodes, 'missingness.reasonCodes', true);
  range(missingness.attritionSensitivity, 'missingness.attritionSensitivity');

  const interference = plan.interference;
  if (interference === null || typeof interference !== 'object' || Array.isArray(interference)) fail('interference declaration is required');
  if (!['none_declared', 'clustered', 'not_established'].includes(interference.assumption)) fail('interference.assumption is unsupported');
  if (interference.clusterIdSource !== null) identifier(interference.clusterIdSource, 'interference.clusterIdSource');
  if (interference.exposureMapping !== null) {
    identifier(interference.exposureMapping.mappingId, 'interference.exposureMapping.mappingId');
    stringList(interference.exposureMapping.variables, 'interference.exposureMapping.variables', true);
    digest(interference.exposureMapping.digest, 'interference.exposureMapping.digest');
  }
  if (!Array.isArray(plan.estimands) || plan.estimands.length === 0) fail('estimands must be non-empty');
  const allowed = new Set<CausalDesignEstimand>(['itt', 'cluster_itt', 'exposure_effect']);
  for (const estimand of plan.estimands) if (!allowed.has(estimand)) fail(`unsupported estimand: ${String(estimand)}`);
  if (new Set(plan.estimands).size !== plan.estimands.length) fail('estimands must not contain duplicates');
}

export function assessCausalDesign(plan: CausalDesignPlan): CausalDesignAssessment {
  validatePlan(plan);
  const reasons: string[] = [];
  const limitations: string[] = [
    'This assessment qualifies declared design prerequisites only; it does not establish missingness, attrition, cluster effects, exposure validity, or target-population coverage from records.',
    'Attrition sensitivity is a declared range for planning and reporting; no imputation, reweighting, or complete-case substitution is authorized by this contract.',
  ];
  const needsExposureMapping = plan.estimands.includes('exposure_effect');
  const needsCluster = plan.estimands.includes('cluster_itt') || needsExposureMapping;
  let status: CausalDesignAssessment['status'] = 'qualified';
  if (plan.interference.assumption === 'not_established') {
    reasons.push('interference is not established; an ordinary ITT may be reported only with this limitation, while interference-sensitive estimands are withheld');
    status = 'withheld';
  }
  if (needsCluster && plan.interference.assumption !== 'clustered') {
    reasons.push('the requested estimand requires a clustered interference declaration');
    status = 'withheld';
  }
  if (needsCluster && plan.interference.clusterIdSource === null) {
    reasons.push('cluster-sensitive estimands require a declared cluster identity source');
    status = 'withheld';
  }
  if (needsExposureMapping && plan.interference.exposureMapping === null) {
    reasons.push('exposure_effect requires a versioned exposure mapping');
    status = 'withheld';
  }
  if (plan.missingness.mechanism === 'unknown') {
    limitations.push('The missingness mechanism is unknown; indicators and reason codes are retained for later sensitivity analysis, not interpreted as MAR, MCAR, or MNAR evidence.');
  }
  if (plan.interference.assumption === 'none_declared') {
    limitations.push('The no-interference declaration is an assumption and does not establish absence of cross-unit effects.');
  }
  return Object.freeze({
    type: CAUSAL_DESIGN_TYPE,
    version: CAUSAL_DESIGN_VERSION,
    designId: plan.designId,
    protocolHash: plan.protocolHash,
    status,
    estimands: Object.freeze([...plan.estimands]),
    targetPopulation: Object.freeze({ ...plan.targetPopulation }),
    missingness: Object.freeze({
      ...plan.missingness,
      indicatorIds: stringList(plan.missingness.indicatorIds, 'missingness.indicatorIds', true),
      reasonCodes: stringList(plan.missingness.reasonCodes, 'missingness.reasonCodes', true),
      attritionSensitivity: range(plan.missingness.attritionSensitivity, 'missingness.attritionSensitivity'),
    }),
    interference: Object.freeze({
      ...plan.interference,
      ...(plan.interference.exposureMapping === null ? { exposureMapping: null } : {
        exposureMapping: Object.freeze({
          ...plan.interference.exposureMapping,
          variables: stringList(plan.interference.exposureMapping.variables, 'interference.exposureMapping.variables', true),
        }),
      }),
    }),
    reasons: Object.freeze(reasons),
    limitations: Object.freeze(limitations),
    nonClaims: Object.freeze([
      'Not a missingness diagnosis or attrition estimate.',
      'Not evidence that interference is absent or that an exposure mapping is valid in the world.',
      'Not a causal effect, transportability result, or target-population coverage certificate.',
    ]),
  });
}
