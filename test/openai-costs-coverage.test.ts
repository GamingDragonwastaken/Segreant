import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Store, type RequestRow } from '../src/store/db.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const START = Date.UTC(2026, 0, 1);
const END = Date.UTC(2026, 0, 3);

function request(overrides: Partial<RequestRow> = {}): RequestRow {
  return {
    requestId: `request-${Math.random()}`,
    sessionId: null,
    tsEpochMs: START + 1,
    provider: 'openai',
    model: 'gpt-5',
    project: 'coverage-fixture',
    taskWeight: 1,
    inputTokens: 10,
    outputTokens: 20,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    costUsd: 0.25,
    estimated: false,
    streamed: false,
    statusCode: 200,
    durationMs: 1,
    via: 'proxy',
    ...overrides,
  };
}

function seedCoverage(store: Store): string {
  const scope = store.setOpenAiScope({
    billingAccountRef: 'finance-coverage',
    providerProjectRef: 'proj_coverage',
    upstreamBase: 'https://api.openai.com',
    declaredAtMs: 1,
    activatedAtMs: 1,
  });
  store.recordOpenAiCostsObservation({
    declaredScopeId: scope.declarationId,
    providerProjectRef: 'proj_coverage',
    periodStartMs: START,
    periodEndMs: END,
    fetchedAtMs: 99,
    paginationComplete: true,
    pageCount: 1,
    pageDigestChainSha256: 'a'.repeat(64),
    resultState: 'succeeded',
    failureCode: null,
    observations: [{
      providerProjectRef: 'proj_coverage',
      bucketStartMs: START,
      bucketEndMs: START + 86_400_000,
      lineItem: 'completions',
      currency: 'USD',
      amountDecimal: '1.25',
    }],
  });
  store.insertRequest(request({
    requestId: 'matching-proxy',
    costUsd: 1.25,
    scopeCaptureStatus: 'declared_unverified',
    providerScopeDeclarationId: scope.declarationId,
  }));
  store.insertRequest(request({ requestId: 'imported', via: 'import', costUsd: 2 }));
  store.insertRequest(request({ requestId: 'unscoped', costUsd: 3, estimated: true }));
  store.insertRequest(request({
    requestId: 'other-declared-scope',
    costUsd: 4,
    scopeCaptureStatus: 'declared_unverified',
    providerScopeDeclarationId: 'a-different-declaration',
  }));
  store.insertRequest(request({ requestId: 'other-provider', provider: 'anthropic', costUsd: 5 }));
  return scope.declarationId;
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

test('OpenAI Costs capture coverage partitions the local ledger without producing a provider total or variance', () => {
  const store = new Store(':memory:');
  try {
    const scopeId = seedCoverage(store);
    const coverage = store.openAiCostsCaptureCoverage();
    assert.ok(coverage);
    assert.equal(coverage.comparisonStatus, 'blocked_not_reconciled');
    assert.equal(coverage.varianceStatus, 'not_calculated');
    assert.equal(coverage.trust, 'operator_declared_unverified');
    assert.equal(coverage.observation.declaredScopeId, scopeId);
    assert.deepEqual(coverage.observation.currencies, ['USD']);
    assert.equal('providerAmount' in coverage.observation, false);
    assert.equal(coverage.capturedOnDeclaredRoute.requestCount, 1);
    assert.equal(coverage.capturedOnDeclaredRoute.costUsd, 1.25);
    assert.equal(coverage.excludedFromDeclaredRoute.importedOrNative.costUsd, 2);
    assert.equal(coverage.excludedFromDeclaredRoute.unscopedOrLegacyOpenAiProxy.costUsd, 3);
    assert.equal(coverage.excludedFromDeclaredRoute.unscopedOrLegacyOpenAiProxy.estimatedRequestCount, 1);
    assert.equal(coverage.excludedFromDeclaredRoute.differentDeclaredOpenAiScope.costUsd, 4);
    assert.equal(coverage.excludedFromDeclaredRoute.otherProvider.costUsd, 5);
    assert.equal(coverage.allLocalLedgerRowsInPeriod.requestCount, 5);
    assert.equal(coverage.allLocalLedgerRowsInPeriod.costUsd, 15.25);
    assert.deepEqual(coverage.blockers, [
      'local_route_scope_is_not_provider_verified',
      'off_path_provider_usage_is_not_observable',
      'provider_finality_is_undocumented',
      'provider_line_items_do_not_join_to_requests_or_models',
      'local_request_amounts_are_rate_card_estimates',
    ]);
  } finally {
    store.close();
  }
});

test('OpenAI Costs coverage is local-only and refuses a variance when no complete observation exists', async () => {
  const empty = new Store(':memory:');
  try {
    assert.equal(empty.openAiCostsCaptureCoverage(), null);
  } finally {
    empty.close();
  }

  const dir = mkdtempSync(join(tmpdir(), 'fiscus-openai-coverage-cli-'));
  const dbPath = join(dir, 'fiscus.db');
  const store = new Store(dbPath);
  try {
    seedCoverage(store);
  } finally {
    store.close();
  }
  try {
    const result = await runCli(['billing', 'openai-costs', 'coverage', '--json'], dbPath, {
      OPENAI_ADMIN_API_KEY: 'must-not-be-read-for-coverage',
    });
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as {
      networkAttempted: boolean;
      credentialRead: boolean;
      reconciliationStatus: string;
      coverage: { comparisonStatus: string; varianceStatus: string; capturedOnDeclaredRoute: { requestCount: number } };
    };
    assert.equal(payload.networkAttempted, false);
    assert.equal(payload.credentialRead, false);
    assert.equal(payload.reconciliationStatus, 'not_reconciled');
    assert.equal(payload.coverage.comparisonStatus, 'blocked_not_reconciled');
    assert.equal(payload.coverage.varianceStatus, 'not_calculated');
    assert.equal(payload.coverage.capturedOnDeclaredRoute.requestCount, 1);
    assert.doesNotMatch(result.stdout + result.stderr, /must-not-be-read-for-coverage/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
