import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  OPENAI_COSTS_ENDPOINT,
  OpenAiCostsPullError,
  collectOpenAiCostsFromResponses,
  parseOpenAiCostsRange,
  previewOpenAiCosts,
  pullOpenAiCosts,
} from '../src/billing/openaiCosts.ts';
import { Store, type RequestRow } from '../src/store/db.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const PAGE_1 = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'openai-costs', 'page-1.json'), 'utf8'));
const PAGE_2 = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'openai-costs', 'page-2.json'), 'utf8'));

function scopedStore(): { store: Store; scopeId: string } {
  const store = new Store(':memory:');
  const scope = store.setOpenAiScope({
    billingAccountRef: 'finance-fixture',
    providerProjectRef: 'proj_fixture',
    upstreamBase: 'https://api.openai.com',
    declaredAtMs: 1,
    activatedAtMs: 1,
  });
  return { store, scopeId: scope.declarationId };
}

function meteredRequest(): RequestRow {
  return {
    requestId: 'metered-stays-separate', sessionId: null, tsEpochMs: 1_767_225_600_000,
    provider: 'openai', model: 'gpt-5', project: 'fixture', taskWeight: 1,
    inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0,
    costUsd: 3.14, estimated: true, streamed: false, statusCode: 200, durationMs: 1,
  };
}

function runCli(args: string[], dbPath: string, env: Record<string, string | undefined> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], {
      env: { ...process.env, FISCUS_DB: dbPath, OPENAI_ADMIN_API_KEY: undefined, NODE_OPTIONS: '', ...env },
    }, (err, stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
        ? (err as unknown as { code: number }).code : err ? 1 : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

test('OpenAI Costs preview validates only the exact declared direct OpenAI project scope and UTC day range', () => {
  const { store } = scopedStore();
  try {
    const preview = previewOpenAiCosts(store.activeOpenAiScope(), '2026-01-01', '2026-01-03');
    assert.equal(preview.endpoint, OPENAI_COSTS_ENDPOINT);
    assert.equal(preview.range.bucketCount, 2);
    assert.equal(preview.projectRef, 'proj_fixture');
    assert.equal(preview.requestLedgerIncluded, false);
    assert.throws(() => previewOpenAiCosts(store.activeOpenAiScope(), '2026-01-01T00:00:00Z', '2026-01-02'), /UTC calendar date/i);
    assert.throws(() => previewOpenAiCosts(store.activeOpenAiScope(), '2026-01-04', '2026-01-03'), /after from/i);
    assert.throws(() => parseOpenAiCostsRange('2026-01-01', '2026-07-01'), /180/i);
  } finally {
    store.close();
  }
  const nonDirect = new Store(':memory:');
  try {
    nonDirect.setOpenAiScope({ billingAccountRef: 'x', providerProjectRef: 'proj_fixture', upstreamBase: 'https://gateway.example' });
    assert.throws(() => previewOpenAiCosts(nonDirect.activeOpenAiScope(), '2026-01-01', '2026-01-02'), /exactly https:\/\/api\.openai\.com/i);
  } finally {
    nonDirect.close();
  }
});

test('OpenAI Costs pull is a fixed GET-only, paginated fixture collector and does not leak authorization', async () => {
  const { store } = scopedStore();
  try {
    const preview = previewOpenAiCosts(store.activeOpenAiScope(), '2026-01-01', '2026-01-03');
    const collected = await collectOpenAiCostsFromResponses({
      preview,
      now: () => 777,
      responses: [
        new Response(JSON.stringify(PAGE_1), { status: 200, headers: { 'content-type': 'application/json' } }),
        new Response(JSON.stringify(PAGE_2), { status: 200, headers: { 'content-type': 'application/json' } }),
      ],
    });
    assert.equal(collected.pageCount, 2);
    assert.equal(collected.observations.length, 2);
    assert.equal(collected.observations[0]!.amountDecimal, '1.25');
    assert.equal(collected.observations[1]!.currency, 'USD');
    assert.doesNotMatch(JSON.stringify(collected), /secret-admin-key-never-persisted/);
  } finally {
    store.close();
  }
});

test('pagination loop and malformed responses create no usable collected observation result', async () => {
  const { store } = scopedStore();
  try {
    const preview = previewOpenAiCosts(store.activeOpenAiScope(), '2026-01-01', '2026-01-03');
    const looping = { ...PAGE_1, next_page: 'same-cursor' };
    await assert.rejects(
      collectOpenAiCostsFromResponses({ preview, responses: [
        new Response(JSON.stringify(looping), { status: 200 }),
        new Response(JSON.stringify(looping), { status: 200 }),
        new Response(JSON.stringify(looping), { status: 200 }),
      ] }),
      (error: unknown) => error instanceof OpenAiCostsPullError && error.failure.failureCode === 'pagination_loop',
    );
    await assert.rejects(
      collectOpenAiCostsFromResponses({ preview, responses: [new Response('{not-json', { status: 200 })] }),
      (error: unknown) => error instanceof OpenAiCostsPullError && error.failure.failureCode === 'malformed_response',
    );
  } finally {
    store.close();
  }
});

test('default OpenAI Costs transport refuses a corrupt receipt history before DNS or socket creation', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fiscus-openai-costs-receipt-refusal-'));
  const previousHome = process.env.FISCUS_HOME;
  process.env.FISCUS_HOME = home;
  const { store } = scopedStore();
  try {
    const preview = previewOpenAiCosts(store.activeOpenAiScope(), '2026-01-01', '2026-01-03');
    writeFileSync(join(home, 'egress-receipts.jsonl'), '{"version":1}\n', 'utf8');
    await assert.rejects(
      pullOpenAiCosts({ preview, apiKey: 'never-sent' }),
      (error: unknown) => error instanceof OpenAiCostsPullError && error.failure.failureCode === 'egress_receipt_integrity_failed' && /repair\/restore/i.test(error.message),
    );
  } finally {
    store.close();
    if (previousHome === undefined) delete process.env.FISCUS_HOME;
    else process.env.FISCUS_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('direct Costs snapshots are immutable, failures are retained, and neither changes request spend', () => {
  const { store, scopeId } = scopedStore();
  try {
    store.insertRequest(meteredRequest());
    const before = store.summary(0, Date.now() + 1).costUsd;
    const base = {
      declaredScopeId: scopeId,
      providerProjectRef: 'proj_fixture',
      periodStartMs: 1_767_225_600_000,
      periodEndMs: 1_767_398_400_000,
      fetchedAtMs: 100,
      paginationComplete: true,
      pageCount: 2,
      pageDigestChainSha256: 'a'.repeat(64),
      resultState: 'succeeded' as const,
      failureCode: null,
      observations: [
        { providerProjectRef: 'proj_fixture', bucketStartMs: 1_767_225_600_000, bucketEndMs: 1_767_312_000_000, lineItem: 'completions', currency: 'USD', amountDecimal: '1.25' },
      ],
    };
    const first = store.recordOpenAiCostsObservation(base);
    const changed = store.recordOpenAiCostsObservation({
      ...base,
      fetchedAtMs: 200,
      pageDigestChainSha256: 'b'.repeat(64),
      observations: [{ ...base.observations[0]!, amountDecimal: '1.50' }],
    });
    const failed = store.recordOpenAiCostsObservation({
      ...base,
      fetchedAtMs: 300,
      paginationComplete: false,
      pageCount: 1,
      pageDigestChainSha256: 'c'.repeat(64),
      resultState: 'failed',
      failureCode: 'http_429',
      observations: [],
    });
    assert.notEqual(first.observationRunId, changed.observationRunId);
    assert.equal(failed.observationsStored, 0);
    assert.equal(store.openAiCostsObservationRuns().length, 3);
    assert.equal(store.latestCompleteOpenAiCostsObservation()!.observations[0]!.amountDecimal, '1.50');
    assert.equal(store.openAiCostsObservationStatus().latestRun!.failureCode, 'http_429');
    assert.equal(store.summary(0, Date.now() + 1).costUsd, before, 'provider observations must not merge into request spend');
    assert.equal(store.billingEvidenceRecords().length, 0, 'direct Costs must not reuse the operator-import ledger');
  } finally {
    store.close();
  }
});

test('CLI preview never reads a credential or calls the network; dry pull is also non-operational', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-openai-costs-cli-'));
  const dbPath = join(dir, 'fiscus.db');
  const store = new Store(dbPath);
  try {
    store.setOpenAiScope({ billingAccountRef: 'finance-cli', providerProjectRef: 'proj_fixture', upstreamBase: 'https://api.openai.com' });
  } finally {
    store.close();
  }
  try {
    const preview = await runCli(['billing', 'openai-costs', 'preview', '--from', '2026-01-01', '--to', '2026-01-03', '--json'], dbPath, {
      OPENAI_ADMIN_API_KEY: 'must-not-appear-or-be-read',
    });
    assert.equal(preview.code, 0, preview.stderr);
    const previewPayload = JSON.parse(preview.stdout) as {
      applied: boolean; networkAttempted: boolean; credentialRead: boolean;
      preview: { projectRef: string }; message: string;
    };
    assert.equal(previewPayload.applied, false);
    assert.equal(previewPayload.networkAttempted, false);
    assert.equal(previewPayload.credentialRead, false);
    assert.equal(previewPayload.preview.projectRef, 'proj_fixture');
    assert.doesNotMatch(preview.stdout + preview.stderr, /must-not-appear-or-be-read/);

    const dryPull = await runCli(['billing', 'openai-costs', 'pull', '--from', '2026-01-01', '--to', '2026-01-03', '--json'], dbPath);
    assert.equal(dryPull.code, 0, dryPull.stderr);
    assert.equal((JSON.parse(dryPull.stdout) as { applied: boolean; networkAttempted: boolean }).networkAttempted, false);

    const missingCredential = await runCli(['billing', 'openai-costs', 'pull', '--from', '2026-01-01', '--to', '2026-01-03', '--apply', '--json'], dbPath);
    assert.equal(missingCredential.code, 1, missingCredential.stderr);
    const missingPayload = JSON.parse(missingCredential.stdout) as { resultState: string; run: { failureCode: string; observationsStored: number } };
    assert.equal(missingPayload.resultState, 'failed');
    assert.equal(missingPayload.run.failureCode, 'missing_credential');
    assert.equal(missingPayload.run.observationsStored, 0);

    const status = await runCli(['billing', 'openai-costs', 'status', '--json'], dbPath);
    assert.equal(status.code, 0, status.stderr);
    assert.equal((JSON.parse(status.stdout) as { status: { latestRun: { failureCode: string } } }).status.latestRun.failureCode, 'missing_credential');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI billing preserves receipt refusal category and repair action instead of collapsing to network failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-openai-costs-cli-receipt-'));
  const dbPath = join(dir, 'fiscus.db');
  const home = join(dir, 'home');
  const store = new Store(dbPath);
  try {
    store.setOpenAiScope({ billingAccountRef: 'finance-cli', providerProjectRef: 'proj_fixture', upstreamBase: 'https://api.openai.com' });
  } finally {
    store.close();
  }
  try {
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'egress-receipts.jsonl'), '{"version":1}\n', 'utf8');
    const result = await runCli(
      ['billing', 'openai-costs', 'pull', '--from', '2026-01-01', '--to', '2026-01-03', '--apply', '--json'],
      dbPath,
      { FISCUS_HOME: home, OPENAI_ADMIN_API_KEY: 'credential-is-not-retained' },
    );
    assert.equal(result.code, 1, result.stderr);
    const payload = JSON.parse(result.stdout) as { run: { failureCode?: string }; action?: string; error?: string };
    assert.equal(payload.run.failureCode, 'egress_receipt_integrity_failed');
    assert.match(payload.action ?? payload.error ?? '', /repair.*restore/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
