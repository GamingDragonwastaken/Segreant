/**
 * Signed GitHub Actions outcome evidence.
 *
 * This is deliberately a LOCAL import boundary, not a GitHub integration. A
 * protected workflow emits a small signed artifact; Fiscus verifies the pinned
 * signing key, repository/branch policy, and local commit binding before it
 * writes the existing gate_signals ledger. No workflow logs, source, prompts,
 * credentials, or API calls are involved.
 */

import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import type { Store } from './store/db.ts';
import { projectName, resolveCommit } from './git/correlate.ts';
import { canonical, keyIdForPem } from './value/receipt.ts';

export const GITHUB_ACTIONS_OUTCOME_TYPE = 'fiscus.github-actions.outcome' as const;

/** v1 intentionally instruments only the CI/test gate. */
export type GithubActionsOutcomeKind = 'tested';
export type GithubActionsConclusion = 'success' | 'failure';

export interface GithubActionsOutcomeBody {
  v: 1;
  type: typeof GITHUB_ACTIONS_OUTCOME_TYPE;
  /** v1 only accepts a protected push workflow, never a PR or manual dispatch. */
  event: 'push';
  /** Stable across artifact download/retry, so it is also the ledger signal ID. */
  eventId: string;
  repository: { id: string; fullName: string };
  /** Full, lowercase Git object ID that must resolve locally at import time. */
  commit: string;
  kind: GithubActionsOutcomeKind;
  verdict: 'pass' | 'fail';
  observedAt: string;
  policy: {
    id: string;
    /** SHA-256 of the approved workflow source that emitted this artifact. */
    workflowDigest: string;
    /** SHA-256 of the declared test-plan/command contract. */
    testPlanDigest: string;
  };
  workflow: {
    runId: string;
    attempt: number;
    job: string;
    /** v1 only accepts a named branch, never a fork PR or tag ref. */
    ref: string;
    conclusion: GithubActionsConclusion;
    workflowPath: string;
  };
}

/** The public artifact deliberately does NOT embed a public key. Import pins one locally. */
export interface SignedGithubActionsOutcome {
  body: GithubActionsOutcomeBody;
  bodyHash: string;
  keyId: string;
  signature: string;
}

export interface GithubActionsOutcomeInput {
  repositoryId: string;
  repositoryFullName: string;
  commit: string;
  runId: string;
  attempt: number;
  job: string;
  ref: string;
  conclusion: GithubActionsConclusion;
  workflowPath: string;
  policyId: string;
  workflowDigest: string;
  testPlanDigest: string;
  observedAt?: string;
}

export interface GithubActionsEvidenceVerification {
  valid: boolean;
  reason: string;
  keyId: string;
}

export interface GithubActionsEvidenceImport {
  artifact: SignedGithubActionsOutcome;
  trustedPublicKeyPem: string;
  expectedRepositoryId: string;
  allowedRef: string;
  expectedWorkflowPath: string;
  expectedPolicyId: string;
  expectedWorkflowDigest: string;
  expectedTestPlanDigest: string;
  /** Evidence older than this cannot silently update a current outcome. */
  maxAgeDays?: number;
  repoPath: string;
  store: Store;
}

export interface GithubActionsEvidenceImportResult {
  ok: boolean;
  reason: string;
  signalId?: string;
  commit?: string;
  project?: string;
  keyId?: string;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function safeText(value: unknown, max = 256): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000\r\n]/.test(value);
}

/** Return a human-readable reason rather than accepting a loosely-shaped JSON blob. */
export function validateGithubActionsOutcomeBody(value: unknown): string | null {
  if (!isRecord(value) || !exactKeys(value, ['v', 'type', 'event', 'eventId', 'repository', 'commit', 'kind', 'verdict', 'observedAt', 'policy', 'workflow'])) {
    return 'invalid artifact body shape';
  }
  if (value.v !== 1 || value.type !== GITHUB_ACTIONS_OUTCOME_TYPE) return 'unsupported artifact version or type';
  if (value.event !== 'push') return 'unsupported workflow event';
  if (!isRecord(value.repository) || !exactKeys(value.repository, ['id', 'fullName'])) return 'invalid repository shape';
  if (typeof value.repository.id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value.repository.id)) return 'invalid repository id';
  if (!safeText(value.repository.fullName, 300) || !/^[^/\s]+\/[^/\s]+$/.test(value.repository.fullName)) return 'invalid repository name';
  if (typeof value.commit !== 'string' || !/^[a-f0-9]{40}$/.test(value.commit)) return 'invalid commit';
  if (value.kind !== 'tested') return 'unsupported outcome kind';
  if (value.verdict !== 'pass' && value.verdict !== 'fail') return 'invalid outcome verdict';
  if (typeof value.observedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.observedAt) || !Number.isFinite(Date.parse(value.observedAt))) {
    return 'invalid observed timestamp';
  }
  if (!isRecord(value.policy) || !exactKeys(value.policy, ['id', 'workflowDigest', 'testPlanDigest'])) return 'invalid evidence policy';
  if (!safeText(value.policy.id, 128) || !/^[A-Za-z0-9._-]+$/.test(value.policy.id)) return 'invalid evidence policy id';
  if (typeof value.policy.workflowDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.policy.workflowDigest)) return 'invalid workflow digest';
  if (typeof value.policy.testPlanDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.policy.testPlanDigest)) return 'invalid test-plan digest';
  if (!isRecord(value.workflow) || !exactKeys(value.workflow, ['runId', 'attempt', 'job', 'ref', 'conclusion', 'workflowPath'])) return 'invalid workflow shape';
  if (typeof value.workflow.runId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(value.workflow.runId)) return 'invalid workflow run id';
  if (typeof value.workflow.attempt !== 'number' || !Number.isInteger(value.workflow.attempt) || value.workflow.attempt < 1 || value.workflow.attempt > 1000) return 'invalid workflow attempt';
  if (!safeText(value.workflow.job) || !safeText(value.workflow.ref) || !safeText(value.workflow.workflowPath, 500)) return 'invalid workflow metadata';
  if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(value.workflow.ref)) return 'unsupported workflow ref';
  if (!/^\.github\/workflows\/[A-Za-z0-9._/-]+\.(?:yml|yaml)$/.test(value.workflow.workflowPath)) return 'invalid workflow path';
  if (value.workflow.conclusion !== 'success' && value.workflow.conclusion !== 'failure') return 'unsupported workflow conclusion';
  if ((value.workflow.conclusion === 'success' && value.verdict !== 'pass') || (value.workflow.conclusion === 'failure' && value.verdict !== 'fail')) {
    return 'workflow conclusion and verdict disagree';
  }
  const expectedEventId = `gha:${value.repository.id}:${value.workflow.runId}:${value.workflow.attempt}:tested:${value.commit}`;
  if (value.eventId !== expectedEventId) return 'event id does not bind the repository, run, attempt, kind, and commit';
  return null;
}

function validateSignedGithubActionsOutcome(value: unknown): string | null {
  if (!isRecord(value) || !exactKeys(value, ['body', 'bodyHash', 'keyId', 'signature'])) return 'invalid signed artifact shape';
  const bodyError = validateGithubActionsOutcomeBody(value.body);
  if (bodyError) return bodyError;
  if (typeof value.bodyHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.bodyHash)) return 'invalid artifact body hash';
  if (typeof value.keyId !== 'string' || !/^[a-f0-9]{16}$/.test(value.keyId)) return 'invalid artifact key id';
  if (typeof value.signature !== 'string' || value.signature.length === 0 || value.signature.length > 16_384) return 'invalid artifact signature';
  return null;
}

/** Build a v1 tested outcome. Verdict derives from conclusion so callers cannot lie about success. */
export function buildGithubActionsOutcome(input: GithubActionsOutcomeInput): GithubActionsOutcomeBody {
  const observedAt = input.observedAt ?? new Date().toISOString();
  const body: GithubActionsOutcomeBody = {
    v: 1,
    type: GITHUB_ACTIONS_OUTCOME_TYPE,
    event: 'push',
    eventId: `gha:${input.repositoryId}:${input.runId}:${input.attempt}:tested:${input.commit}`,
    repository: { id: input.repositoryId, fullName: input.repositoryFullName },
    commit: input.commit,
    kind: 'tested',
    verdict: input.conclusion === 'success' ? 'pass' : 'fail',
    observedAt,
    policy: { id: input.policyId, workflowDigest: input.workflowDigest, testPlanDigest: input.testPlanDigest },
    workflow: {
      runId: input.runId,
      attempt: input.attempt,
      job: input.job,
      ref: input.ref,
      conclusion: input.conclusion,
      workflowPath: input.workflowPath,
    },
  };
  const error = validateGithubActionsOutcomeBody(body);
  if (error) throw new Error(error);
  return body;
}

/** Sign a validated artifact with a dedicated CI private key. */
export function signGithubActionsOutcome(body: GithubActionsOutcomeBody, privateKeyPem: string): SignedGithubActionsOutcome {
  const error = validateGithubActionsOutcomeBody(body);
  if (error) throw new Error(error);
  const privateKey = createPrivateKey(privateKeyPem);
  const publicPem = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();
  const encoded = canonical(body);
  return {
    body,
    bodyHash: sha256Hex(encoded),
    keyId: keyIdForPem(publicPem),
    signature: cryptoSign(null, Buffer.from(encoded), privateKey).toString('base64'),
  };
}

/** Verify integrity and an explicit local trust anchor. The artifact never self-authenticates. */
export function verifyGithubActionsOutcome(value: unknown, trustedPublicKeyPem: string): GithubActionsEvidenceVerification {
  const shapeError = validateSignedGithubActionsOutcome(value);
  if (shapeError) return { valid: false, reason: shapeError, keyId: '' };
  const artifact = value as SignedGithubActionsOutcome;
  const encoded = canonical(artifact.body);
  if (sha256Hex(encoded) !== artifact.bodyHash) return { valid: false, reason: 'artifact body hash mismatch', keyId: '' };
  let pinnedKeyId: string;
  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    pinnedKeyId = keyIdForPem(trustedPublicKeyPem);
    publicKey = createPublicKey(trustedPublicKeyPem);
  } catch {
    return { valid: false, reason: 'unreadable pinned public key', keyId: '' };
  }
  if (artifact.keyId !== pinnedKeyId) return { valid: false, reason: 'artifact key is not the pinned key', keyId: pinnedKeyId };
  try {
    const valid = cryptoVerify(null, Buffer.from(encoded), publicKey, Buffer.from(artifact.signature, 'base64'));
    return valid
      ? { valid: true, reason: 'valid pinned signature', keyId: pinnedKeyId }
      : { valid: false, reason: 'invalid artifact signature', keyId: pinnedKeyId };
  } catch {
    return { valid: false, reason: 'unreadable artifact signature', keyId: pinnedKeyId };
  }
}

/**
 * Verify a signed artifact, enforce the explicit local policy, resolve its
 * commit in the selected checkout, and finally write the normal Fiscus gate
 * signal. Failures return before touching the ledger.
 */
export async function importGithubActionsOutcome(input: GithubActionsEvidenceImport): Promise<GithubActionsEvidenceImportResult> {
  const verified = verifyGithubActionsOutcome(input.artifact, input.trustedPublicKeyPem);
  if (!verified.valid) return { ok: false, reason: verified.reason, keyId: verified.keyId || undefined };
  const body = input.artifact.body;
  if (body.repository.id !== input.expectedRepositoryId) return { ok: false, reason: 'artifact repository does not match the pinned repository policy', keyId: verified.keyId };
  if (body.workflow.ref !== input.allowedRef) return { ok: false, reason: 'artifact workflow ref does not match the pinned ref policy', keyId: verified.keyId };
  if (body.workflow.workflowPath !== input.expectedWorkflowPath) return { ok: false, reason: 'artifact workflow path does not match the pinned workflow policy', keyId: verified.keyId };
  if (body.policy.id !== input.expectedPolicyId || body.policy.workflowDigest !== input.expectedWorkflowDigest || body.policy.testPlanDigest !== input.expectedTestPlanDigest) {
    return { ok: false, reason: 'artifact evidence policy does not match the pinned policy', keyId: verified.keyId };
  }
  const maxAgeDays = input.maxAgeDays ?? 90;
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0 || maxAgeDays > 3650) {
    return { ok: false, reason: 'invalid local evidence age policy', keyId: verified.keyId };
  }
  const ageMs = Date.now() - Date.parse(body.observedAt);
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  if (ageMs > maxAgeMs || ageMs < -5 * 60 * 1000) return { ok: false, reason: 'artifact timestamp is stale or implausibly in the future', keyId: verified.keyId };
  const resolved = await resolveCommit(input.repoPath, body.commit);
  if (resolved !== body.commit) return { ok: false, reason: 'artifact commit is unavailable in the selected local repository', keyId: verified.keyId };
  const project = await projectName(input.repoPath);
  const write = input.store.insertVerifiedGateEvidence({
    eventId: body.eventId,
    source: 'github-actions',
    evidenceClass: 'signed-ci',
    commitHash: body.commit,
    repositoryId: body.repository.id,
    policyId: body.policy.id,
    bodyHash: input.artifact.bodyHash,
    signerKeyId: verified.keyId,
    envelopeJson: JSON.stringify(input.artifact),
    verifiedAtMs: Date.now(),
    signal: {
      kind: body.kind,
      project,
      tsEpochMs: Date.parse(body.observedAt),
      verdict: body.verdict,
      detail: JSON.stringify({
      v: 1,
      source: GITHUB_ACTIONS_OUTCOME_TYPE,
      eventId: body.eventId,
      bodyHash: input.artifact.bodyHash,
      keyId: verified.keyId,
      repositoryId: body.repository.id,
      policyId: body.policy.id,
      workflowRunId: body.workflow.runId,
      workflowAttempt: body.workflow.attempt,
      workflowPath: body.workflow.workflowPath,
      workflowRef: body.workflow.ref,
      }),
    },
  });
  if (write === 'conflict') return { ok: false, reason: 'a conflicting event or signed body is already recorded', keyId: verified.keyId };
  return { ok: true, reason: write === 'duplicate' ? 'verified evidence was already imported' : 'verified evidence imported', signalId: body.eventId, commit: body.commit, project, keyId: verified.keyId };
}
