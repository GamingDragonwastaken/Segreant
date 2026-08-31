/** Local emit/import commands for signed CI outcome evidence. */

import { createPrivateKey } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { dbPath } from '../config.ts';
import { Store } from '../store/db.ts';
import type { Flags } from './flags.ts';
import {
  buildGithubActionsOutcome,
  importGithubActionsOutcome,
  signGithubActionsOutcome,
  type GithubActionsConclusion,
  type SignedGithubActionsOutcome,
} from '../githubActionsEvidence.ts';
import { readBoundedUtf8File, RESOURCE_LIMITS } from '../util/resource-limits.ts';

function value(flags: Flags, name: string): string | null {
  const raw = flags[name];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

function required(flags: Flags, name: string): string {
  const found = value(flags, name);
  if (!found) throw new Error(`--${name} is required`);
  return found;
}

function printUsage(): void {
  console.error('  Usage: fiscus evidence github emit --repository-id <id> --repository <owner/repo> --commit <40-char-sha> --run-id <id> --attempt <n> --job <name> --ref refs/heads/main --conclusion success|failure --workflow .github/workflows/ci.yml --policy <id> --workflow-digest <sha256> --test-plan-digest <sha256> --private-key <pem> [--out <artifact.json>]');
  console.error('         fiscus evidence github import --file <artifact.json> --repo <local-repo> --repository-id <id> --ref refs/heads/main --workflow .github/workflows/ci.yml --policy <id> --workflow-digest <sha256> --test-plan-digest <sha256> --public-key <pinned-public.pem>');
}

function readJsonArtifact(path: string): SignedGithubActionsOutcome {
  try {
    return JSON.parse(readBoundedUtf8File(path, RESOURCE_LIMITS.evidenceArtifactBytes, 'evidence_artifact_bytes')) as SignedGithubActionsOutcome;
  } catch (error) {
    throw new Error(`could not read evidence artifact: ${String(error)}`);
  }
}

async function cmdGithubEmit(flags: Flags): Promise<void> {
  const conclusion = required(flags, 'conclusion');
  if (conclusion !== 'success' && conclusion !== 'failure') throw new Error('--conclusion must be success or failure');
  const privateKeyPath = required(flags, 'private-key');
  let privateKeyPem: string;
  try {
    privateKeyPem = readFileSync(privateKeyPath, 'utf8');
    createPrivateKey(privateKeyPem); // Fail before constructing an artifact.
  } catch (error) {
    throw new Error(`could not read dedicated CI private key: ${String(error)}`);
  }
  const body = buildGithubActionsOutcome({
    repositoryId: required(flags, 'repository-id'),
    repositoryFullName: required(flags, 'repository'),
    commit: required(flags, 'commit'),
    runId: required(flags, 'run-id'),
    attempt: Number(required(flags, 'attempt')),
    job: required(flags, 'job'),
    ref: required(flags, 'ref'),
    conclusion: conclusion as GithubActionsConclusion,
    workflowPath: required(flags, 'workflow'),
    policyId: required(flags, 'policy'),
    workflowDigest: required(flags, 'workflow-digest'),
    testPlanDigest: required(flags, 'test-plan-digest'),
    observedAt: value(flags, 'observed-at') ?? undefined,
  });
  const artifact = signGithubActionsOutcome(body, privateKeyPem);
  const out = value(flags, 'out');
  if (out) {
    if (existsSync(out)) throw new Error(`refusing to overwrite existing artifact: ${out}`);
    if (!existsSync(dirname(out))) throw new Error(`artifact directory does not exist: ${dirname(out)}`);
    writeFileSync(out, JSON.stringify(artifact, null, 2) + '\n', 'utf8');
    console.log(`  Wrote signed Fiscus test-evidence artifact: ${out}`);
    console.log(`  Key ${artifact.keyId} must be pinned out of band before import.`);
    return;
  }
  process.stdout.write(JSON.stringify(artifact, null, 2) + '\n');
}

async function cmdGithubImport(flags: Flags): Promise<void> {
  const artifact = readJsonArtifact(required(flags, 'file'));
  const publicKeyPath = required(flags, 'public-key');
  let publicKeyPem: string;
  try {
    publicKeyPem = readFileSync(publicKeyPath, 'utf8');
  } catch (error) {
    throw new Error(`could not read pinned public key: ${String(error)}`);
  }
  const maxAgeRaw = value(flags, 'max-age-days');
  const maxAgeDays = maxAgeRaw === null ? undefined : Number(maxAgeRaw);
  if (maxAgeDays !== undefined && (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0 || maxAgeDays > 3650)) {
    throw new Error('--max-age-days must be a finite number between 0 and 3650');
  }
  const store = new Store(dbPath());
  try {
    const result = await importGithubActionsOutcome({
      artifact,
      trustedPublicKeyPem: publicKeyPem,
      expectedRepositoryId: required(flags, 'repository-id'),
      allowedRef: required(flags, 'ref'),
      expectedWorkflowPath: required(flags, 'workflow'),
      expectedPolicyId: required(flags, 'policy'),
      expectedWorkflowDigest: required(flags, 'workflow-digest'),
      expectedTestPlanDigest: required(flags, 'test-plan-digest'),
      maxAgeDays,
      repoPath: value(flags, 'repo') ?? process.cwd(),
      store,
    });
    if (!result.ok) throw new Error(`evidence rejected: ${result.reason}`);
    if (flags.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      console.log(`  Imported verified signed-CI tested=${artifact.body.verdict} evidence for ${result.commit!.slice(0, 12)}.`);
      console.log(`  Event ${result.signalId} is replay-safe; conflicting re-use is rejected.`);
    }
  } finally {
    store.close();
  }
}

export async function cmdEvidence(flags: Flags): Promise<void> {
  const platform = flags._[0];
  const action = flags._[1];
  if (platform !== 'github' || (action !== 'emit' && action !== 'import')) {
    printUsage();
    process.exitCode = 1;
    return;
  }
  if (action === 'emit') await cmdGithubEmit(flags);
  else await cmdGithubImport(flags);
}
