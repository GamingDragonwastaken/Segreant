/**
 * WP-D04 deterministic benchmark harness for contribution-association evidence.
 *
 * Pure and dependency-injectable: the evaluator is the real engine by default
 * (`assessContributionEvidence` / `assessContributionEvidenceForCandidates`),
 * but any conforming evaluator can be injected to prove the harness catches a
 * wrong evaluator. The runner never treats baseline scores as truth: baselines
 * (engine pooled retention, raw same-path line diff) are diagnostic only, and
 * no threshold equates them to the expected verdict.
 *
 * Association-only, never authorship: every score, expected status, and match
 * bit concerns whether the supplied artifacts are ASSOCIATED. None of it
 * establishes who wrote code, whether it succeeded, its quality, or value.
 */

import { createHash } from 'node:crypto';
import {
  assessContributionEvidence,
  assessContributionEvidenceForCandidates,
  type ContributionAssessmentInput,
  type ContributionCandidatesInput,
  type ContributionEvidenceResult,
} from '../../src/git/contribution.ts';
import { acceptanceForCommit, type ProposedFile } from '../../src/value/proposals.ts';
import { CONTRIBUTION_CORPUS, CONTRIBUTION_CORPUS_DIGEST_ALGORITHM, CONTRIBUTION_CORPUS_VERSION, type ContributionCorpusCase } from '../fixtures/contribution-corpus.ts';

export const CONTRIBUTION_BENCHMARK_VERSION = 'wp-d04-benchmark/1';

export function runContributionBenchmark(options: ContributionBenchmarkOptions = {}): ContributionBenchmarkReport {
  const cases = [...(options.cases ?? CONTRIBUTION_CORPUS)].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (cases.length === 0) throw new Error('Empty contribution corpus');
  const ids = new Set<string>();
  for (const entry of cases) {
    if (!entry.id || ids.has(entry.id)) throw new Error('Missing or duplicate case identity');
    ids.add(entry.id);
    if (entry.provenance !== 'synthetic' || !entry.rationale || entry.categories.length === 0) {
      throw new Error(`Missing synthetic provenance or oracle rationale: ${entry.id}`);
    }
  }
  const evaluate = options.evaluate ?? defaultContributionEvaluator;
  const nonClaims = ['ai_authorship', 'outcome_success', 'code_quality', 'realized_value'] as const;
  const honored = { ai_authorship: true, outcome_success: true, code_quality: true, realized_value: true };
  const categoryCounts: Record<string, number> = {};
  const statusConfusionCounts: Record<string, number> = {};
  const digest = corpusDigest(cases);
  const rows = cases.map((entry): ContributionBenchmarkCaseResult => {
    const pooled = baselinePooledRetention(entry.input);
    const simple = baselineSimpleDiffOverlap(entry.input);
    const evidence = evaluate(cloneInput(entry.input));
    const issues: string[] = [];
    if (evidence.status !== entry.expected.status) issues.push('status');
    if (evidence.method !== entry.expected.method) issues.push('method');
    for (const name of nonClaims) {
      if (!evidence.nonClaims.includes(name)) {
        issues.push(`nonClaim:${name}`);
        honored[name] = false;
      }
    }
    if (evidence.limitations.length === 0) issues.push('limitations');
    for (const key of ['quality', 'value', 'success', 'realized', 'aiYield', 'survivalRatio']) {
      if (key in evidence) issues.push(`forbidden:${key}`);
    }
    for (const category of new Set(entry.categories)) categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;
    const cell = `${entry.expected.status}->${evidence.status}`;
    statusConfusionCounts[cell] = (statusConfusionCounts[cell] ?? 0) + 1;
    return {
      id: entry.id, categories: entry.categories, expected: entry.expected,
      actual: { status: evidence.status, method: evidence.method },
      passed: issues.length === 0, issues, rationale: entry.rationale, evidence,
      baselineAcceptancePooledRetention: pooled, baselineSimpleDiffOverlap: simple,
    };
  });
  const passed = rows.filter((row) => row.passed).length;
  return deepFreeze({
    version: CONTRIBUTION_BENCHMARK_VERSION, corpusVersion: CONTRIBUTION_CORPUS_VERSION,
    corpusDigest: digest, total: rows.length, passed, failed: rows.length - passed,
    rows, categoryCounts, statusConfusionCounts, nonClaimsHonored: honored,
    limitations: [
      'Synthetic, hand-authored contract oracles; not independent attribution validation or field evidence.',
      'Association labels are not AI authorship, outcome success, code quality, or realized value.',
      'Pooled retention calls acceptanceForCommit on text additions; it ignores file identity and confounders.',
      'Simple diff overlap is mean same-path raw nonempty-line multiset Dice, not semantic equivalence or Git history.',
      'Baselines return null for candidate sets and unavailable comparisons; scores are not verdicts and no truth threshold is fitted.',
      'Collector-provided patch, hunk and AST identities are synthetic declarations, not computed or authenticated.',
      'Evidence removal cases simulate unavailable input only, not persisted retention or kernel revocation.',
    ],
  });
}

export interface ContributionBenchmarkCaseResult {
  readonly id: string;
  readonly categories: readonly string[];
  readonly expected: { readonly status: string; readonly method: string };
  readonly actual: { readonly status: string; readonly method: string };
  readonly passed: boolean;
  readonly issues: readonly string[];
  readonly rationale: string;
  readonly evidence: ContributionEvidenceResult;
  readonly baselineAcceptancePooledRetention: number | null;
  readonly baselineSimpleDiffOverlap: number | null;
}

export interface ContributionBenchmarkReport {
  readonly version: string;
  readonly corpusVersion: string;
  readonly corpusDigest: string;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly rows: readonly ContributionBenchmarkCaseResult[];
  readonly categoryCounts: Readonly<Record<string, number>>;
  readonly statusConfusionCounts: Readonly<Record<string, number>>;
  readonly nonClaimsHonored: {
    readonly ai_authorship: boolean;
    readonly outcome_success: boolean;
    readonly code_quality: boolean;
    readonly realized_value: boolean;
  };
  readonly limitations: readonly string[];
}

export interface ContributionBenchmarkOptions {
  readonly cases?: readonly ContributionCorpusCase[];
  readonly evaluate?: (input: ContributionAssessmentInput | ContributionCandidatesInput) => ContributionEvidenceResult;
}

export function defaultContributionEvaluator(
  input: ContributionAssessmentInput | ContributionCandidatesInput,
): ContributionEvidenceResult {
  return 'candidates' in input
    ? assessContributionEvidenceForCandidates(input as ContributionCandidatesInput)
    : assessContributionEvidence(input);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

export function corpusDigest(cases: readonly ContributionCorpusCase[]): string {
  const canonicalCases = [...cases].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return createHash(CONTRIBUTION_CORPUS_DIGEST_ALGORITHM).update(canonicalJson(canonicalCases)).digest('hex');
}

function cloneInput(input: ContributionAssessmentInput | ContributionCandidatesInput): ContributionAssessmentInput | ContributionCandidatesInput {
  const revive = <T>(value: T): T =>
    value === null || typeof value !== 'object'
      ? value
      : Array.isArray(value)
        ? (value as unknown[]).map(revive) as unknown as T
        : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, revive(item)])) as T;
  return revive(input);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== 'object') return value as Readonly<T>;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

export function frozenCorpus(cases: readonly ContributionCorpusCase[] = CONTRIBUTION_CORPUS): readonly ContributionCorpusCase[] {
  return deepFreeze(structuredClone(cases));
}

function pairView(input: ContributionAssessmentInput | ContributionCandidatesInput): {
  readonly proposals: ProposedFile[];
  readonly committedAddedByFile: Map<string, string[]>;
  readonly samePathPairs: { readonly source: ProposedFile; readonly target: ProposedFile }[];
} {
  if ('candidates' in input) {
    const proposals = input.candidates.flatMap((candidate) => candidate.source.files
      .filter((file): file is Extract<typeof file, { kind: 'text' }> => file.kind === 'text')
      .map((file) => ({ path: file.path, addedLines: [...file.addedLines] })));
    const committedAddedByFile = new Map<string, string[]>();
    for (const file of input.target.files) {
      if (file.kind !== 'text' || file.path === null) continue;
      committedAddedByFile.set(file.path, [...file.addedLines]);
    }
    return { proposals, committedAddedByFile, samePathPairs: [] };
  }
  const proposals: ProposedFile[] = input.source.files
    .filter((file): file is Extract<typeof file, { kind: 'text' }> => file.kind === 'text')
    .map((file) => ({ path: file.path, addedLines: [...file.addedLines] }));
  const committedAddedByFile = new Map<string, string[]>();
  for (const file of input.target.files) {
    if (file.kind !== 'text' || file.path === null) continue;
    committedAddedByFile.set(file.path, [...file.addedLines]);
  }
  const samePathPairs: { source: ProposedFile; target: ProposedFile }[] = [];
  for (const sourceFile of proposals) {
    for (const targetFile of committedAddedByFile) {
      const [path, addedLines] = targetFile;
      if (sourceFile.path !== null && sourceFile.path === path) {
        samePathPairs.push({ source: sourceFile, target: { path, addedLines } });
      }
    }
  }
  return { proposals, committedAddedByFile, samePathPairs };
}

export function baselinePooledRetention(
  input: ContributionAssessmentInput | ContributionCandidatesInput,
): number | null {
  const view = pairView(input);
  const candidates = 'candidates' in input;
  return candidates
    ? null
    : acceptanceForCommit(view.proposals, view.committedAddedByFile);
}

export function baselineSimpleDiffOverlap(
  input: ContributionAssessmentInput | ContributionCandidatesInput,
): number | null {
  const view = pairView(input);
  if (view.samePathPairs.length === 0) return null;
  const normalize = (line: string): string => line;
  const scores: number[] = [];
  for (const pair of view.samePathPairs) {
    const source = pair.source.addedLines.map(normalize).filter((line) => line.length > 0);
    const target = pair.target.addedLines.map(normalize).filter((line) => line.length > 0);
    if (source.length === 0 || target.length === 0) continue;
    const targetCounts = new Map<string, number>();
    for (const line of target) targetCounts.set(line, (targetCounts.get(line) ?? 0) + 1);
    let matched = 0;
    for (const line of source) {
      const remaining = targetCounts.get(line) ?? 0;
      if (remaining === 0) continue;
      matched += 1;
      targetCounts.set(line, remaining - 1);
    }
    scores.push((2 * matched) / (source.length + target.length));
  }
  return scores.length === 0 ? null : scores.reduce((sum, value) => sum + value, 0) / scores.length;
}
