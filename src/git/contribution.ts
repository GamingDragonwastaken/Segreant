/**
 * Bounded contribution evidence for a source artifact and a target change.
 *
 * This module answers only whether the supplied artifacts are associated. It
 * does not answer whether the target succeeded, is high quality, survived, or
 * created value. Those are separate outcome and value claims with separate
 * evidence contracts.
 *
 * Evidence precedence is deliberately narrow:
 *
 *   exact patch identity -> unique structural text/path overlap
 *   -> declared temporal window -> unresolved
 *
 * The structural comparison is bounded and refuses partial/opaque content. A
 * cap exhaustion, ambiguous candidate, missing path relationship, or invalid
 * time window cannot become a negative attribution claim.
 */

const contributionEvidenceBrand: unique symbol = Symbol('contribution-evidence');

export const CONTRIBUTION_EVIDENCE_STATUSES = ['exact', 'structural', 'temporal', 'unresolved'] as const;
export type ContributionEvidenceStatus = (typeof CONTRIBUTION_EVIDENCE_STATUSES)[number];

export const CONTRIBUTION_EVIDENCE_METHODS = [
  'exact_patch_identity',
  'normalized_text_overlap',
  'temporal_association',
  'unresolved',
] as const;
export type ContributionEvidenceMethod = (typeof CONTRIBUTION_EVIDENCE_METHODS)[number];

export const CONTRIBUTION_FILE_KINDS = ['text', 'generated', 'binary', 'unsupported'] as const;
export type ContributionFileKind = (typeof CONTRIBUTION_FILE_KINDS)[number];

export type ContributionNonClaim = 'outcome_success' | 'code_quality' | 'realized_value';

export interface ContributionTextFile {
  readonly path: string;
  readonly kind: 'text';
  readonly addedLines: readonly string[];
  readonly previousPath?: string | null;
}

export interface ContributionOpaqueFile {
  readonly path: string;
  readonly kind: Exclude<ContributionFileKind, 'text'>;
  readonly previousPath?: string | null;
}

export type ContributionFile = ContributionTextFile | ContributionOpaqueFile;

/** A source or target artifact supplied by a collector. */
export interface ContributionArtifact {
  /** Stable identifier for this artifact, such as a commit or capture id. */
  readonly id: string;
  /** Stable identifier for the collector/source that supplied the artifact. */
  readonly sourceId: string;
  readonly files: readonly ContributionFile[];
  /** Exact identity of the complete patch, when the collector has one. */
  readonly patchIdentity: string | null;
}

/** Explicit temporal evidence. A time value is never inferred from artifact order. */
export interface ContributionTemporalContext {
  readonly sourceObservedAtMs: number;
  readonly targetObservedAtMs: number;
  readonly windowStartMs: number;
  readonly windowEndMs: number;
}

export type ContributionPathRelation = 'same_path' | 'renamed_or_moved';

export interface ContributionPathMapping {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly relation: ContributionPathRelation;
  readonly score: number;
  readonly matchedLines: number;
  readonly sourceLines: number;
  readonly targetLines: number;
}

export interface ContributionExcludedFile {
  readonly side: 'source' | 'target';
  readonly path: string;
  readonly kind: Exclude<ContributionFileKind, 'text'>;
  readonly reason: 'generated_content' | 'binary_content' | 'unsupported_content';
}

/** Similarity evidence only; `score` is not a quality or success score. */
export interface ContributionSimilarity {
  readonly kind: 'patch_identity' | 'normalized_text_overlap' | 'not_available';
  readonly score: number | null;
  readonly compared: boolean;
  readonly pathMappings: readonly ContributionPathMapping[];
  readonly ambiguousPaths: readonly string[];
  readonly excludedFiles: readonly ContributionExcludedFile[];
  readonly unmatchedSourcePaths: readonly string[];
  readonly unmatchedTargetPaths: readonly string[];
}

export interface ContributionAssociation {
  readonly mode: 'none' | 'temporal_window';
  readonly withinWindow: boolean | null;
  /** True only when the source observation strictly precedes the target. */
  readonly sourcePrecedesTarget: boolean | null;
  readonly distanceMs: number | null;
  readonly windowStartMs: number | null;
  readonly windowEndMs: number | null;
}

/**
 * Evidence of contribution association only. The nominal brand prevents a
 * result from being mistaken for a value/quality object by an explicit type
 * assertion-free assignment; a future consumer must write a named bridge.
 */
export interface ContributionEvidenceResult {
  readonly [contributionEvidenceBrand]: 'contribution_evidence';
  readonly status: ContributionEvidenceStatus;
  readonly method: ContributionEvidenceMethod;
  /** Collector/source identifiers, sorted and deduplicated for stable output. */
  readonly sourceIds: readonly string[];
  /** Artifact identifiers, kept separate from collector/source provenance. */
  readonly artifactIds: readonly string[];
  readonly similarity: ContributionSimilarity;
  readonly association: ContributionAssociation;
  /** Limits and evidence gaps that prevent stronger interpretation. */
  readonly limitations: readonly string[];
  /** Claims this result can never establish on its own. */
  readonly nonClaims: readonly ContributionNonClaim[];
}

export interface ContributionAssessmentInput {
  readonly source: ContributionArtifact;
  readonly target: ContributionArtifact;
  readonly temporal?: ContributionTemporalContext;
}

/** Fixed ceilings keep hostile or accidental input from turning comparison into an unbounded scan. */
export const CONTRIBUTION_LIMITS = Object.freeze({
  maxFilesPerArtifact: 256,
  maxTotalLinesPerArtifact: 50_000,
  maxLineCharacters: 16_384,
  maxPathCharacters: 2_048,
});

const STRUCTURAL_MIN_SCORE = 0.75;
const SCORE_EPSILON = 1e-12;

function freezeArray<T>(items: readonly T[]): readonly T[] {
  return Object.freeze([...items]);
}

function freezeObject<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function hasText(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim().length > 0;
}

function stableIds(values: readonly string[]): readonly string[] {
  return freezeArray([...new Set(values)].sort());
}

function normalizedPath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

function pathRelation(source: ContributionFile, target: ContributionFile): ContributionPathRelation | null {
  const sourcePath = normalizedPath(source.path);
  const targetPath = normalizedPath(target.path);
  if (sourcePath === targetPath) return 'same_path';
  if (target.previousPath !== undefined && target.previousPath !== null
      && normalizedPath(target.previousPath) === sourcePath) return 'renamed_or_moved';
  if (source.previousPath !== undefined && source.previousPath !== null
      && normalizedPath(source.previousPath) === targetPath) return 'renamed_or_moved';
  return null;
}

function normalizedLines(lines: readonly string[]): string[] | null {
  const out: string[] = [];
  for (const line of lines) {
    if (line.length > CONTRIBUTION_LIMITS.maxLineCharacters) return null;
    const normalized = line.replace(/\s+/g, ' ').trim();
    if (normalized.length > 0) out.push(normalized);
  }
  return out;
}

function multisetOverlap(source: readonly string[], target: readonly string[]): number {
  const counts = new Map<string, number>();
  for (const line of target) counts.set(line, (counts.get(line) ?? 0) + 1);
  let matched = 0;
  for (const line of source) {
    const remaining = counts.get(line) ?? 0;
    if (remaining === 0) continue;
    matched += 1;
    counts.set(line, remaining - 1);
  }
  return matched;
}

function similarityScore(source: readonly string[], target: readonly string[]): { score: number; matchedLines: number } | null {
  if (source.length === 0 || target.length === 0) return null;
  const matchedLines = multisetOverlap(source, target);
  if (matchedLines === 0) return null;
  // Dice overlap rewards content retained on both sides and avoids treating a
  // single generic line in a large file as a strong contribution match.
  return {
    score: (2 * matchedLines) / (source.length + target.length),
    matchedLines,
  };
}

function baseSimilarity(): ContributionSimilarity {
  return {
    kind: 'not_available',
    score: null,
    compared: false,
    pathMappings: [],
    ambiguousPaths: [],
    excludedFiles: [],
    unmatchedSourcePaths: [],
    unmatchedTargetPaths: [],
  };
}

function baseAssociation(): ContributionAssociation {
  return {
    mode: 'none',
    withinWindow: null,
    sourcePrecedesTarget: null,
    distanceMs: null,
    windowStartMs: null,
    windowEndMs: null,
  };
}

function commonLimitations(): string[] {
  return [
    'Source and patch identities are supplied metadata; no collector authentication or external attestation is performed.',
    'Text similarity is syntactic and bounded; it is not semantic equivalence or authorship proof.',
    'Contribution evidence does not establish outcome success.',
    'Contribution evidence does not establish code quality.',
    'Contribution evidence does not establish realized value.',
  ];
}

function result(
  input: ContributionAssessmentInput,
  status: ContributionEvidenceStatus,
  method: ContributionEvidenceMethod,
  similarity: ContributionSimilarity,
  association: ContributionAssociation,
  limitations: readonly string[],
): ContributionEvidenceResult {
  return freezeObject({
    [contributionEvidenceBrand]: 'contribution_evidence' as const,
    status,
    method,
    sourceIds: stableIds([input.source.sourceId, input.target.sourceId]),
    artifactIds: stableIds([input.source.id, input.target.id]),
    similarity: freezeObject({
      ...similarity,
      pathMappings: freezeArray(similarity.pathMappings.map((mapping) => freezeObject({ ...mapping }))),
      ambiguousPaths: freezeArray(similarity.ambiguousPaths),
      excludedFiles: freezeArray(similarity.excludedFiles.map((file) => freezeObject({ ...file }))),
      unmatchedSourcePaths: freezeArray(similarity.unmatchedSourcePaths),
      unmatchedTargetPaths: freezeArray(similarity.unmatchedTargetPaths),
    }),
    association: freezeObject({ ...association }),
    limitations: freezeArray([...limitations, ...commonLimitations()]),
    nonClaims: freezeArray(['outcome_success', 'code_quality', 'realized_value'] as const),
  });
}

function invalidTemporal(context: ContributionTemporalContext | undefined): boolean {
  if (context === undefined) return true;
  return ![context.sourceObservedAtMs, context.targetObservedAtMs, context.windowStartMs, context.windowEndMs]
    .every((value) => Number.isFinite(value)) || context.windowStartMs >= context.windowEndMs;
}

function temporalAssociation(
  input: ContributionAssessmentInput,
): { association: ContributionAssociation; valid: boolean; limitation: string | null } {
  const context = input.temporal;
  if (invalidTemporal(context)) {
    return {
      association: baseAssociation(),
      valid: false,
      limitation: context === undefined
        ? 'No explicit temporal window was supplied.'
        : 'The temporal window or observation timestamps are invalid.',
    };
  }
  const sourceObservedAtMs = context!.sourceObservedAtMs;
  const targetObservedAtMs = context!.targetObservedAtMs;
  const withinWindow = sourceObservedAtMs >= context!.windowStartMs
    && sourceObservedAtMs < context!.windowEndMs
    && targetObservedAtMs >= context!.windowStartMs
    && targetObservedAtMs < context!.windowEndMs;
  const sourcePrecedesTarget = sourceObservedAtMs < targetObservedAtMs;
  return {
    association: {
      mode: withinWindow && sourcePrecedesTarget ? 'temporal_window' : 'none',
      withinWindow,
      sourcePrecedesTarget,
      distanceMs: Math.abs(targetObservedAtMs - sourceObservedAtMs),
      windowStartMs: context!.windowStartMs,
      windowEndMs: context!.windowEndMs,
    },
    valid: withinWindow && sourcePrecedesTarget,
    limitation: !withinWindow
      ? 'The source and target observations fall outside the supplied half-open temporal window.'
      : !sourcePrecedesTarget
        ? 'The source observation does not strictly precede the target, so temporal attribution is unresolved.'
        : 'Temporal association is window-only; it does not establish content contribution beyond ordering.',
  };
}

function exceedsBounds(artifact: ContributionArtifact): boolean {
  if (artifact.files.length > CONTRIBUTION_LIMITS.maxFilesPerArtifact) return true;
  let totalLines = 0;
  for (const file of artifact.files) {
    if (file.path.length > CONTRIBUTION_LIMITS.maxPathCharacters) return true;
    if (file.previousPath !== undefined && file.previousPath !== null
        && file.previousPath.length > CONTRIBUTION_LIMITS.maxPathCharacters) return true;
    if (file.kind !== 'text') continue;
    if (file.addedLines.some((line) => line.length > CONTRIBUTION_LIMITS.maxLineCharacters)) return true;
    totalLines += file.addedLines.length;
    if (totalLines > CONTRIBUTION_LIMITS.maxTotalLinesPerArtifact) return true;
  }
  return false;
}

function unsupportedReason(kind: Exclude<ContributionFileKind, 'text'>): ContributionExcludedFile['reason'] {
  if (kind === 'generated') return 'generated_content';
  if (kind === 'binary') return 'binary_content';
  return 'unsupported_content';
}

function structuralSimilarity(
  source: ContributionArtifact,
  target: ContributionArtifact,
): ContributionSimilarity {
  const excludedFiles: ContributionExcludedFile[] = [];
  const sourceText = source.files.filter((file): file is ContributionTextFile => {
    if (file.kind === 'text') return true;
    excludedFiles.push({ side: 'source', path: file.path, kind: file.kind, reason: unsupportedReason(file.kind) });
    return false;
  });
  const targetText = target.files.filter((file): file is ContributionTextFile => {
    if (file.kind === 'text') return true;
    excludedFiles.push({ side: 'target', path: file.path, kind: file.kind, reason: unsupportedReason(file.kind) });
    return false;
  });

  const normalizedSource = new Map<ContributionTextFile, string[]>();
  const normalizedTarget = new Map<ContributionTextFile, string[]>();
  const unmatchedSourcePaths: string[] = [];
  const unmatchedTargetPaths: string[] = [];
  for (const file of sourceText) {
    const lines = normalizedLines(file.addedLines);
    if (lines === null) {
      unmatchedSourcePaths.push(file.path);
      continue;
    }
    normalizedSource.set(file, lines);
  }
  for (const file of targetText) {
    const lines = normalizedLines(file.addedLines);
    if (lines === null) {
      unmatchedTargetPaths.push(file.path);
      continue;
    }
    normalizedTarget.set(file, lines);
  }

  type Candidate = {
    source: ContributionTextFile;
    target: ContributionTextFile;
    relation: ContributionPathRelation;
    score: number;
    matchedLines: number;
    sourceLines: number;
    targetLines: number;
  };
  const candidatesBySource = new Map<ContributionTextFile, Candidate[]>();
  for (const sourceFile of sourceText) {
    const sourceLines = normalizedSource.get(sourceFile);
    if (sourceLines === undefined) continue;
    const candidates: Candidate[] = [];
    for (const targetFile of targetText) {
      const targetLines = normalizedTarget.get(targetFile);
      if (targetLines === undefined) continue;
      const relation = pathRelation(sourceFile, targetFile);
      if (relation === null) continue;
      const score = similarityScore(sourceLines, targetLines);
      if (score === null || score.score < STRUCTURAL_MIN_SCORE) continue;
      candidates.push({
        source: sourceFile,
        target: targetFile,
        relation,
        score: score.score,
        matchedLines: score.matchedLines,
        sourceLines: sourceLines.length,
        targetLines: targetLines.length,
      });
    }
    candidates.sort((a, b) => b.score - a.score || a.target.path.localeCompare(b.target.path));
    candidatesBySource.set(sourceFile, candidates);
  }

  const ambiguousPaths = new Set<string>();
  const selected: Candidate[] = [];
  for (const [sourceFile, candidates] of candidatesBySource) {
    const best = candidates[0];
    if (best === undefined) {
      unmatchedSourcePaths.push(sourceFile.path);
      continue;
    }
    const tied = candidates.filter((candidate) => Math.abs(candidate.score - best.score) <= SCORE_EPSILON);
    if (tied.length > 1) {
      ambiguousPaths.add(sourceFile.path);
      continue;
    }
    selected.push(best);
  }

  const targetUsers = new Map<ContributionTextFile, Candidate[]>();
  for (const candidate of selected) {
    const users = targetUsers.get(candidate.target) ?? [];
    users.push(candidate);
    targetUsers.set(candidate.target, users);
  }
  for (const users of targetUsers.values()) {
    if (users.length < 2) continue;
    for (const candidate of users) ambiguousPaths.add(candidate.source.path);
  }

  const selectedTargets = new Set(selected.filter((candidate) => !ambiguousPaths.has(candidate.source.path)).map((candidate) => candidate.target));
  for (const targetFile of targetText) {
    if (!normalizedTarget.has(targetFile)) continue;
    if (!selectedTargets.has(targetFile)) unmatchedTargetPaths.push(targetFile.path);
  }

  const pathMappings = selected
    .filter((candidate) => !ambiguousPaths.has(candidate.source.path))
    .map((candidate): ContributionPathMapping => ({
      sourcePath: candidate.source.path,
      targetPath: candidate.target.path,
      relation: candidate.relation,
      score: candidate.score,
      matchedLines: candidate.matchedLines,
      sourceLines: candidate.sourceLines,
      targetLines: candidate.targetLines,
    }));
  const scores = pathMappings.map((mapping) => mapping.score);
  const score = scores.length === 0 ? null : scores.reduce((sum, value) => sum + value, 0) / scores.length;

  return {
    kind: pathMappings.length > 0 ? 'normalized_text_overlap' : 'not_available',
    score,
    compared: normalizedSource.size > 0 && normalizedTarget.size > 0,
    pathMappings,
    ambiguousPaths: [...ambiguousPaths].sort(),
    excludedFiles,
    unmatchedSourcePaths: [...new Set(unmatchedSourcePaths)].sort(),
    unmatchedTargetPaths: [...new Set(unmatchedTargetPaths)].sort(),
  };
}

function exactSimilarity(): ContributionSimilarity {
  return {
    ...baseSimilarity(),
    kind: 'patch_identity',
    score: 1,
    compared: true,
  };
}

function excludedFilesForArtifact(
  artifact: ContributionArtifact,
  side: ContributionExcludedFile['side'],
): ContributionExcludedFile[] {
  return artifact.files
    .filter((file) => file.kind !== 'text')
    .map((file) => ({
      side,
      path: file.path,
      kind: file.kind,
      reason: unsupportedReason(file.kind),
    }));
}

/**
 * Assess only contribution association between two supplied artifacts.
 *
 * The returned status is not an outcome verdict. In particular, `unresolved`
 * means that this association layer did not establish a link; it does not mean
 * that the target was not produced, useful, correct, or unsuccessful.
 */
export function assessContributionEvidence(input: ContributionAssessmentInput): ContributionEvidenceResult {
  const { source, target } = input;

  if (hasText(source.patchIdentity) && source.patchIdentity === target.patchIdentity) {
    const excludedFiles = [
      ...excludedFilesForArtifact(source, 'source'),
      ...excludedFilesForArtifact(target, 'target'),
    ];
    const limitations = [
      'Exact patch identity is the only contribution link used; file contents were not interpreted.',
      ...(excludedFiles.length > 0 ? ['Generated, binary, or unsupported files remain content-uninterpreted.'] : []),
    ];
    return result(
      input,
      'exact',
      'exact_patch_identity',
      { ...exactSimilarity(), excludedFiles },
      baseAssociation(),
      limitations,
    );
  }

  const temporal = temporalAssociation(input);
  const bounded = exceedsBounds(source) || exceedsBounds(target);
  if (bounded) {
    const limitations = [
      'The structural comparison exceeded a fixed file, path, line, or line-length bound.',
      'The bounded comparison was withheld rather than treating partial input as unresolved negative evidence.',
      ...(source.patchIdentity !== null || target.patchIdentity !== null
        ? ['The supplied patch identities did not match exactly.']
        : []),
      ...(temporal.limitation === null ? [] : [temporal.limitation]),
    ];
    if (temporal.valid) {
      return result(input, 'temporal', 'temporal_association', baseSimilarity(), temporal.association, limitations);
    }
    return result(input, 'unresolved', 'unresolved', baseSimilarity(), temporal.association, limitations);
  }

  const similarity = structuralSimilarity(source, target);
  const identityMismatch = source.patchIdentity !== null || target.patchIdentity !== null;
  if (similarity.pathMappings.length > 0 && similarity.ambiguousPaths.length === 0) {
    const limitations = [
      'Structural evidence is limited to unique normalized text overlap on the declared path relationship.',
      ...(similarity.unmatchedSourcePaths.length > 0 || similarity.unmatchedTargetPaths.length > 0
        ? ['Some source or target files had no qualifying structural match.']
        : []),
      ...(identityMismatch ? ['The supplied patch identities did not match exactly, so this is not exact evidence.'] : []),
    ];
    return result(
      input,
      'structural',
      'normalized_text_overlap',
      { ...similarity, compared: true },
      baseAssociation(),
      limitations,
    );
  }

  const limitations = [
    similarity.ambiguousPaths.length > 0
      ? 'Structural candidates were ambiguous, so no candidate was selected.'
      : 'No unique structural text/path match met the minimum similarity threshold.',
    ...(similarity.excludedFiles.length > 0 ? ['Generated, binary, or unsupported files were excluded from text comparison.'] : []),
    ...(identityMismatch ? ['The supplied patch identities did not match exactly.'] : []),
    ...(temporal.limitation === null ? [] : [temporal.limitation]),
  ];
  if (temporal.valid) {
    return result(input, 'temporal', 'temporal_association', similarity, temporal.association, limitations);
  }
  return result(input, 'unresolved', 'unresolved', similarity, temporal.association, limitations);
}
