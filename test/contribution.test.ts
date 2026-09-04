import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessContributionEvidence,
  type ContributionArtifact,
  type ContributionEvidenceResult,
} from '../src/git/contribution.ts';
import type { CommitQuality } from '../src/git/quality.ts';
import type { RealizationReport } from '../src/value/realization.ts';

function artifact(
  id: string,
  sourceId: string,
  files: ContributionArtifact['files'],
  patchIdentity: string | null = null,
): ContributionArtifact {
  return { id, sourceId, files, patchIdentity };
}

function text(path: string, addedLines: string[], previousPath: string | null = null): ContributionArtifact['files'][number] {
  return { path, kind: 'text', addedLines, previousPath };
}

const temporal = {
  sourceObservedAtMs: 1_500,
  targetObservedAtMs: 2_000,
  windowStartMs: 1_000,
  windowEndMs: 2_500,
};

function assertBoundary(result: ContributionEvidenceResult): void {
  assert.ok(result.sourceIds.length > 0);
  assert.ok(result.method.length > 0);
  assert.ok(result.limitations.length > 0);
  assert.ok(result.nonClaims.includes('outcome_success'));
  assert.ok(result.nonClaims.includes('code_quality'));
  assert.ok(result.nonClaims.includes('realized_value'));
  assert.equal('realized' in result, false);
  assert.equal('quality' in result, false);
  assert.equal('value' in result, false);
  assert.equal('success' in result, false);
}

test('contribution evidence recognizes exact patch identity without making an outcome claim', () => {
  const result = assessContributionEvidence({
    source: artifact('proposal-1', 'proxy:session-1', [text('src/app.ts', ['const answer = 42;'])], 'patch:abc'),
    target: artifact('commit-1', 'git:commit-1', [text('src/app.ts', ['const answer = 42;'])], 'patch:abc'),
  });

  assert.equal(result.status, 'exact');
  assert.equal(result.method, 'exact_patch_identity');
  assert.deepEqual(result.sourceIds, ['git:commit-1', 'proxy:session-1']);
  assert.equal(result.similarity.kind, 'patch_identity');
  assert.equal(result.similarity.score, 1);
  assert.equal(result.association.mode, 'none');
  assert.ok(result.limitations.some((limitation) => /does not establish.*quality/i.test(limitation)));
  assertBoundary(result);
});

test('contribution evidence falls back to a declared temporal window when patches cannot be compared', () => {
  const result = assessContributionEvidence({
    source: artifact('proposal-2', 'proxy:session-2', [{ path: 'image.bin', kind: 'binary' }]),
    target: artifact('commit-2', 'git:commit-2', [{ path: 'image.bin', kind: 'binary' }]),
    temporal,
  });

  assert.equal(result.status, 'temporal');
  assert.equal(result.method, 'temporal_association');
  assert.equal(result.similarity.kind, 'not_available');
  assert.equal(result.similarity.score, null);
  assert.equal(result.association.mode, 'temporal_window');
  assert.equal(result.association.withinWindow, true);
  assert.equal(result.association.sourcePrecedesTarget, true);
  assert.equal(result.association.distanceMs, 500);
  assert.ok(result.limitations.some((limitation) => /temporal.*only/i.test(limitation)));
  assert.ok(result.limitations.some((limitation) => /binary/i.test(limitation)));
  assertBoundary(result);
});

test('contribution evidence treats a unique rename or move as structural, not exact', () => {
  const result = assessContributionEvidence({
    source: artifact('proposal-3', 'proxy:session-3', [text('old/name.ts', ['export const answer = 42;'])]),
    target: artifact('commit-3', 'git:commit-3', [text('new/name.ts', ['export const answer = 42;'], 'old/name.ts')]),
  });

  assert.equal(result.status, 'structural');
  assert.equal(result.method, 'normalized_text_overlap');
  assert.equal(result.similarity.score, 1);
  assert.equal(result.similarity.pathMappings[0]!.relation, 'renamed_or_moved');
  assert.equal(result.similarity.pathMappings[0]!.sourcePath, 'old/name.ts');
  assert.equal(result.similarity.pathMappings[0]!.targetPath, 'new/name.ts');
  assert.ok(result.limitations.some((limitation) => /rename|move|path/i.test(limitation)));
  assertBoundary(result);
});

test('contribution evidence with tied structural candidates stays unresolved', () => {
  const result = assessContributionEvidence({
    source: artifact('proposal-4', 'proxy:session-4', [text('generated-name.ts', ['same line'])]),
    target: artifact('commit-4', 'git:commit-4', [
      text('src/one.ts', ['same line'], 'generated-name.ts'),
      text('src/two.ts', ['same line'], 'generated-name.ts'),
    ]),
  });

  assert.equal(result.status, 'unresolved');
  assert.equal(result.method, 'unresolved');
  assert.deepEqual(result.similarity.ambiguousPaths, ['generated-name.ts']);
  assert.equal(result.association.mode, 'none');
  assert.ok(result.limitations.some((limitation) => /ambiguous/i.test(limitation)));
  assertBoundary(result);
});

test('generated, binary, and unsupported content are never treated as comparable text', () => {
  for (const kind of ['generated', 'binary', 'unsupported'] as const) {
    const result = assessContributionEvidence({
      source: artifact(`proposal-${kind}`, `proxy:${kind}`, [{ path: `file.${kind}`, kind }]),
      target: artifact(`commit-${kind}`, `git:${kind}`, [{ path: `file.${kind}`, kind }]),
    });

    assert.equal(result.status, 'unresolved', `${kind} content must remain unresolved`);
    assert.equal(result.similarity.kind, 'not_available');
    assert.equal(result.similarity.compared, false);
    assert.ok(result.similarity.excludedFiles.some((file) => file.kind === kind));
    assert.ok(result.limitations.some((limitation) => limitation.toLowerCase().includes(kind)));
    assertBoundary(result);
  }
});

test('bounded or out-of-window comparisons withhold attribution rather than inventing a negative', () => {
  const oversized = Array.from({ length: 50_001 }, (_, index) => `line-${index}`);
  const bounded = assessContributionEvidence({
    source: artifact('proposal-bounded', 'proxy:bounded', [text('src/big.ts', oversized)]),
    target: artifact('commit-bounded', 'git:bounded', [text('src/big.ts', oversized)]),
    temporal: { ...temporal, sourceObservedAtMs: 5_000, targetObservedAtMs: 5_001 },
  });
  assert.equal(bounded.status, 'unresolved');
  assert.equal(bounded.method, 'unresolved');
  assert.equal(bounded.association.mode, 'none');
  assert.ok(bounded.limitations.some((limitation) => /bound/i.test(limitation)));
  assertBoundary(bounded);

  const outside = assessContributionEvidence({
    source: artifact('proposal-outside', 'proxy:outside', [{ path: 'opaque.bin', kind: 'binary' }]),
    target: artifact('commit-outside', 'git:outside', [{ path: 'opaque.bin', kind: 'binary' }]),
    temporal: { ...temporal, sourceObservedAtMs: 3_000, targetObservedAtMs: 4_000 },
  });
  assert.equal(outside.status, 'unresolved');
  assert.equal(outside.association.withinWindow, false);
  assert.equal(outside.association.sourcePrecedesTarget, true);
  assert.equal(outside.association.mode, 'none');
  assert.ok(outside.limitations.some((limitation) => /outside.*window/i.test(limitation)));
  assertBoundary(outside);

  const reversed = assessContributionEvidence({
    source: artifact('proposal-reversed', 'proxy:reversed', [{ path: 'opaque.bin', kind: 'binary' }]),
    target: artifact('commit-reversed', 'git:reversed', [{ path: 'opaque.bin', kind: 'binary' }]),
    temporal: { ...temporal, sourceObservedAtMs: 2_000, targetObservedAtMs: 1_500 },
  });
  assert.equal(reversed.status, 'unresolved');
  assert.equal(reversed.association.withinWindow, true);
  assert.equal(reversed.association.sourcePrecedesTarget, false);
  assert.equal(reversed.association.mode, 'none');
  assert.ok(reversed.limitations.some((limitation) => /strictly precede/i.test(limitation)));
  assertBoundary(reversed);
});

test('contribution evidence is nominally separate from outcome and quality result shapes', () => {
  type ForbiddenKeys = Extract<keyof ContributionEvidenceResult, 'realized' | 'quality' | 'value' | 'success' | 'survivalRatio' | 'aiYield'>;
  const noOutcomeKeys: ForbiddenKeys extends never ? true : never = true;
  assert.equal(noOutcomeKeys, true);

  const result = assessContributionEvidence({
    source: artifact('proposal-boundary', 'proxy:boundary', [text('src/app.ts', ['const answer = 42;'])]),
    target: artifact('commit-boundary', 'git:boundary', [text('src/app.ts', ['const answer = 42;'])]),
  });
  // The nominal brand is the compile-time bridge guard. These assignments must
  // remain errors until a caller writes an explicit outcome adapter.
  // @ts-expect-error Contribution evidence is not a CommitQuality result.
  const quality: CommitQuality = result;
  // @ts-expect-error Contribution evidence is not a RealizationReport.
  const realization: RealizationReport = result;
  void quality;
  void realization;
});
