import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/db.ts';
import { computeRealization } from '../src/value/realization.ts';
import { projectName } from '../src/git/correlate.ts';

function git(cwd: string, args: string[], env: Record<string, string> = {}): void {
  execFileSync('git', args, { cwd, env: { ...process.env, ...env }, stdio: 'ignore' });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-contribution-consumer-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.invalid']);
  git(dir, ['config', 'user.name', 'Fiscus test']);
  return dir;
}

function commit(dir: string, iso: string): void {
  writeFileSync(join(dir, 'src.ts'), 'export const answer = 42;\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-qm', 'feature: attributed proposal', `--date=${iso}`], { GIT_COMMITTER_DATE: iso });
}

test('realization consumes contribution evidence without laundering it into outcome realization', async () => {
  const repo = makeRepo();
  const storeWithoutProposal = new Store(':memory:');
  const storeWithProposal = new Store(':memory:');
  try {
    const commitMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const commitIso = new Date(commitMs).toISOString();
    commit(repo, commitIso);
    const project = await projectName(repo);

    const withoutProposal = await computeRealization(storeWithoutProposal, repo, {
      limit: 1,
      windowDays: 14,
      gitScanBudgetMs: 10_000,
    });

    storeWithProposal.insertProposal({
      proposalId: 'proposal-consumer-1',
      requestId: 'request-consumer-1',
      sessionId: 'session-consumer-1',
      tsEpochMs: commitMs - 1_000,
      provider: 'openai',
      model: 'gpt-test',
      project,
      files: [{ path: 'src.ts', addedLines: ['export const answer = 42;'] }],
      captureCoverage: 'complete',
    });

    const withProposal = await computeRealization(storeWithProposal, repo, {
      limit: 1,
      windowDays: 14,
      gitScanBudgetMs: 10_000,
    });
    const unit = withProposal.units[0]!;
    const evidence = unit.contributionEvidence;

    assert.ok(evidence, 'the live realization path exposes contribution evidence');
    assert.equal(evidence!.status, 'structural');
    assert.equal(evidence!.method, 'normalized_text_overlap');
    assert.ok(evidence!.nonClaims.includes('outcome_success'));
    assert.ok(evidence!.nonClaims.includes('code_quality'));
    assert.equal('realized' in evidence!, false);
    assert.equal('quality' in evidence!, false);
    assert.equal('value' in evidence!, false);

    // The proposal association may support proposal/acceptance observations, but
    // it must not bypass the independent tested/merged/shipped/survived/clean
    // outcome gates. With no lifecycle signals, both reports remain unresolved.
    assert.equal(unit.funnel.realized, false);
    assert.equal(unit.funnel.results.find((result) => result.gate === 'tested')!.verdict, 'unknown');
    assert.equal(unit.funnel.results.find((result) => result.gate === 'merged')!.verdict, 'unknown');
    assert.equal(unit.funnel.results.find((result) => result.gate === 'shipped')!.verdict, 'unknown');
    assert.equal(withProposal.matured.realizedUnits, withoutProposal.matured.realizedUnits);
    assert.equal(withProposal.matured.realizationRate, withoutProposal.matured.realizationRate);
  } finally {
    storeWithoutProposal.close();
    storeWithProposal.close();
    rmSync(repo, { recursive: true, force: true });
  }
});
