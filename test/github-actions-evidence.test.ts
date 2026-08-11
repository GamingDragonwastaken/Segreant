import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/db.ts';
import { loadOrCreateKeyPair } from '../src/value/receipt.ts';
import {
  buildGithubActionsOutcome,
  importGithubActionsOutcome,
  signGithubActionsOutcome,
  verifyGithubActionsOutcome,
  type GithubActionsOutcomeInput,
} from '../src/githubActionsEvidence.ts';
import { computeRealization } from '../src/value/realization.ts';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Fiscus Test', GIT_AUTHOR_EMAIL: 'test@fiscus.local', GIT_COMMITTER_NAME: 'Fiscus Test', GIT_COMMITTER_EMAIL: 'test@fiscus.local' },
  }).trim();
}

function makeRepo(): { dir: string; commit: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-github-evidence-'));
  git(dir, ['init']);
  writeFileSync(join(dir, 'app.ts'), 'export const answer = 42;\n');
  git(dir, ['add', 'app.ts']);
  git(dir, ['commit', '-m', 'test: add evidence fixture']);
  return { dir, commit: git(dir, ['rev-parse', 'HEAD']) };
}

function input(commit: string, over: Partial<GithubActionsOutcomeInput> = {}): GithubActionsOutcomeInput {
  return {
    repositoryId: '123456',
    repositoryFullName: 'example/fiscus-fixture',
    commit,
    runId: '987654',
    attempt: 1,
    job: 'fiscus-outcome',
    ref: 'refs/heads/main',
    conclusion: 'success',
    workflowPath: '.github/workflows/ci.yml',
    policyId: 'fiscus-ci-v1',
    workflowDigest: '1'.repeat(64),
    testPlanDigest: '2'.repeat(64),
    observedAt: new Date().toISOString(),
    ...over,
  };
}

function importArgs(artifact: ReturnType<typeof signGithubActionsOutcome>, publicPem: string, repoPath: string, store: Store) {
  return {
    artifact,
    trustedPublicKeyPem: publicPem,
    expectedRepositoryId: '123456',
    allowedRef: 'refs/heads/main',
    expectedWorkflowPath: '.github/workflows/ci.yml',
    expectedPolicyId: 'fiscus-ci-v1',
    expectedWorkflowDigest: '1'.repeat(64),
    expectedTestPlanDigest: '2'.repeat(64),
    repoPath,
    store,
  };
}

test('github evidence: a valid pinned artifact imports one replay-safe commit-bound tested signal and retains its envelope', async () => {
  const repo = makeRepo();
  const keyDir = mkdtempSync(join(tmpdir(), 'fiscus-github-evidence-key-'));
  const store = new Store(':memory:');
  try {
    const keys = loadOrCreateKeyPair(join(keyDir, 'ci-key.json'));
    const artifact = signGithubActionsOutcome(buildGithubActionsOutcome(input(repo.commit)), keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
    const first = await importGithubActionsOutcome(importArgs(artifact, keys.publicPem, repo.dir, store));
    const second = await importGithubActionsOutcome(importArgs(artifact, keys.publicPem, repo.dir, store));
    assert.equal(first.ok, true);
    assert.equal(first.reason, 'verified evidence imported');
    assert.equal(second.ok, true);
    assert.equal(second.reason, 'verified evidence was already imported');
    const signals = store.signalsForCommit(repo.commit);
    assert.equal(signals.length, 1);
    assert.equal(signals[0]!.kind, 'tested');
    assert.equal(signals[0]!.verdict, 'pass');
    assert.equal(signals[0]!.evidenceSource, 'signed-ci');
    const evidence = store.raw().prepare('SELECT envelope_json AS envelopeJson, policy_id AS policyId FROM gate_evidence WHERE event_id = ?').get(artifact.body.eventId) as { envelopeJson: string; policyId: string };
    assert.equal(evidence.policyId, 'fiscus-ci-v1');
    assert.deepEqual(JSON.parse(evidence.envelopeJson), artifact);
  } finally {
    store.close();
    rmSync(repo.dir, { recursive: true, force: true });
    rmSync(keyDir, { recursive: true, force: true });
  }
});

test('github evidence: a valid failed test artifact overrides a pass through the existing fail-wins realization gate', async () => {
  const repo = makeRepo();
  const keyDir = mkdtempSync(join(tmpdir(), 'fiscus-github-evidence-fail-'));
  const store = new Store(':memory:');
  try {
    const keys = loadOrCreateKeyPair(join(keyDir, 'ci-key.json'));
    const pem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const pass = signGithubActionsOutcome(buildGithubActionsOutcome(input(repo.commit)), pem);
    const fail = signGithubActionsOutcome(buildGithubActionsOutcome(input(repo.commit, { runId: '987655', conclusion: 'failure' })), pem);
    assert.equal((await importGithubActionsOutcome(importArgs(pass, keys.publicPem, repo.dir, store))).ok, true);
    assert.equal((await importGithubActionsOutcome(importArgs(fail, keys.publicPem, repo.dir, store))).ok, true);
    const report = await computeRealization(store, repo.dir, { limit: 1, windowDays: 14 });
    const tested = report.units[0]!.funnel.results.find((result) => result.gate === 'tested');
    assert.equal(tested!.verdict, 'fail');
  } finally {
    store.close();
    rmSync(repo.dir, { recursive: true, force: true });
    rmSync(keyDir, { recursive: true, force: true });
  }
});

test('github evidence: altered payloads, an unpinned key, mismatched policy, and absent commits never write a signal', async () => {
  const repo = makeRepo();
  const keyDir = mkdtempSync(join(tmpdir(), 'fiscus-github-evidence-reject-'));
  const store = new Store(':memory:');
  try {
    const honest = loadOrCreateKeyPair(join(keyDir, 'honest.json'));
    const attacker = loadOrCreateKeyPair(join(keyDir, 'attacker.json'));
    const pem = honest.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const artifact = signGithubActionsOutcome(buildGithubActionsOutcome(input(repo.commit)), pem);
    const altered = { ...artifact, body: { ...artifact.body, repository: { ...artifact.body.repository, fullName: 'attacker/rewrite' } } };
    assert.equal(verifyGithubActionsOutcome(altered, honest.publicPem).valid, false);
    assert.equal(verifyGithubActionsOutcome(artifact, attacker.publicPem).valid, false);
    const wrongPolicy = await importGithubActionsOutcome({ ...importArgs(artifact, honest.publicPem, repo.dir, store), expectedWorkflowDigest: '3'.repeat(64) });
    const absentCommit = signGithubActionsOutcome(buildGithubActionsOutcome(input('a'.repeat(40), { runId: '987656' })), pem);
    const missing = await importGithubActionsOutcome(importArgs(absentCommit, honest.publicPem, repo.dir, store));
    assert.equal(wrongPolicy.ok, false);
    assert.equal(missing.ok, false);
    assert.equal(store.signalsForCommit(repo.commit).length, 0);
    assert.equal((store.raw().prepare('SELECT COUNT(*) AS n FROM gate_evidence').get() as { n: number }).n, 0);
  } finally {
    store.close();
    rmSync(repo.dir, { recursive: true, force: true });
    rmSync(keyDir, { recursive: true, force: true });
  }
});

test('github evidence: cancelled workflow data cannot be coerced into a pass and conflicting replay is rejected', async () => {
  const repo = makeRepo();
  const keyDir = mkdtempSync(join(tmpdir(), 'fiscus-github-evidence-conflict-'));
  const store = new Store(':memory:');
  try {
    const keys = loadOrCreateKeyPair(join(keyDir, 'ci-key.json'));
    const pem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const body = buildGithubActionsOutcome(input(repo.commit));
    const cancelled = { ...body, workflow: { ...body.workflow, conclusion: 'cancelled' } };
    const forged = { body: cancelled, bodyHash: 'a'.repeat(64), keyId: keys.keyId, signature: 'not-a-signature' };
    assert.match(verifyGithubActionsOutcome(forged, keys.publicPem).reason, /unsupported workflow conclusion/);
    const original = signGithubActionsOutcome(body, pem);
    assert.equal((await importGithubActionsOutcome(importArgs(original, keys.publicPem, repo.dir, store))).ok, true);
    const conflicting = signGithubActionsOutcome(buildGithubActionsOutcome(input(repo.commit, { repositoryFullName: 'example/renamed' })), pem);
    const rejected = await importGithubActionsOutcome(importArgs(conflicting, keys.publicPem, repo.dir, store));
    assert.equal(rejected.ok, false);
    assert.match(rejected.reason, /conflicting/);
  } finally {
    store.close();
    rmSync(repo.dir, { recursive: true, force: true });
    rmSync(keyDir, { recursive: true, force: true });
  }
});

test('github evidence: an invalid local evidence-age policy fails closed before it can write', async () => {
  const repo = makeRepo();
  const keyDir = mkdtempSync(join(tmpdir(), 'fiscus-github-evidence-age-'));
  const store = new Store(':memory:');
  try {
    const keys = loadOrCreateKeyPair(join(keyDir, 'ci-key.json'));
    const pem = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const artifact = signGithubActionsOutcome(buildGithubActionsOutcome(input(repo.commit)), pem);
    const rejected = await importGithubActionsOutcome({ ...importArgs(artifact, keys.publicPem, repo.dir, store), maxAgeDays: Number.NaN });
    assert.equal(rejected.ok, false);
    assert.match(rejected.reason, /invalid local evidence age policy/);
    assert.equal(store.signalsForCommit(repo.commit).length, 0);
  } finally {
    store.close();
    rmSync(repo.dir, { recursive: true, force: true });
    rmSync(keyDir, { recursive: true, force: true });
  }
});
