/**
 * CONTRIBUTION EVIDENCE REACHES THE OPERATOR (WP-D03, D-246).
 *
 * `contributionEvidence` has ridden on every matured work unit since D-193,
 * and the JSON form of `segreant value realize` carried it per unit — but the
 * human output printed nothing about it, so an operator reading the terminal
 * could not learn that the association was structural, temporal or unresolved,
 * nor that a confounder was declared. This gate holds the summary the CLI
 * prints to the same discipline the result carries: counts by status and
 * method are observations; the non-claim sentence is printed with them; an
 * unassessed unit is counted, never folded into "unresolved".
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assessContributionEvidence,
  contributionEvidenceLines,
  summarizeContributionEvidence,
  type ContributionArtifact,
  type ContributionEvidenceResult,
} from '../src/git/contribution.ts';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

function artifact(id: string, sourceId: string, addedLines: string[]): ContributionArtifact {
  return { id, sourceId, patchIdentity: null, files: [{ kind: 'text', path: 'src.ts', addedLines }] };
}

function structural(): ContributionEvidenceResult {
  return assessContributionEvidence({
    source: artifact('proposal-1', 'proposal', ['export const answer = 42;', 'export const other = 1;']),
    target: artifact('commit-1', 'git', ['export const answer = 42;', 'export const other = 1;']),
  });
}

function confounded(): ContributionEvidenceResult {
  return assessContributionEvidence({
    source: artifact('proposal-2', 'proposal', ['a']),
    target: { ...artifact('commit-2', 'git', ['a']), confounders: ['concurrent_human_edit'] },
  });
}

test('the summary counts by status and method, keeps unassessed units apart, and surfaces declared confounders', () => {
  const units = [
    { contributionEvidence: structural() },
    { contributionEvidence: structural() },
    { contributionEvidence: confounded() },
    {},
  ];
  const summary = summarizeContributionEvidence(units);
  assert.equal(summary.units, 4);
  assert.equal(summary.assessed, 3);
  assert.equal(summary.unassessed, 1);
  assert.equal(summary.byStatus.unresolved + summary.byStatus.structural + summary.byStatus.exact + summary.byStatus.temporal, 3);
  assert.ok(summary.byStatus.unresolved >= 1, 'a confounded comparison stays unresolved');
  assert.equal(summary.confounded, 1);
  assert.deepEqual(summary.nonClaims, ['ai_authorship', 'code_quality', 'outcome_success', 'realized_value']);
  const totalByMethod = Object.values(summary.byMethod).reduce((a, b) => a + b, 0);
  assert.equal(totalByMethod, 3, 'every assessed unit has exactly one method');
});

test('the printed lines carry the counts and the non-claim sentence, and say nothing when nothing was assessed', () => {
  const lines = contributionEvidenceLines(summarizeContributionEvidence([{ contributionEvidence: structural() }, {}]));
  assert.ok(lines.length >= 2);
  assert.match(lines[0]!, /1 of 2 units assessed/);
  assert.match(lines[0]!, /1 unassessed/);
  assert.match(lines.join('\n'), /never AI authorship, code quality, outcome success, or realized value/);
  assert.match(lines.join('\n'), /association/);
  assert.deepEqual(contributionEvidenceLines(summarizeContributionEvidence([{}, {}])), [], 'no evidence, no line — not a zero dressed as a finding');
});

test('segreant value realize prints the summary on its human path', () => {
  const src = readFileSync(join(ROOT, 'src/cli/valueCmd.ts'), 'utf8');
  assert.ok(src.includes('contributionEvidenceLines(summarizeContributionEvidence(report.units))'), 'the CLI must print the contribution evidence summary');
});
