/**
 * The dashboard's provider-billing page is a deliberately separate evidence
 * surface. These tests pin the boundary: an operator-supplied report is never
 * silently mixed into request-metered spend, budget enforcement, or ROI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { Store, type RequestRow } from '../src/store/db.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';
import { readBillingImportFile } from '../src/billing/importer.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'billing', 'openai-operator-export.v1.json');

function meteredRequest(): RequestRow {
  return {
    requestId: 'metered-request', sessionId: null, tsEpochMs: Date.now(), provider: 'openai', model: 'gpt-5',
    project: 'local-project', taskWeight: 1, inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0,
    reasoningTokens: 0, costUsd: 2.5, estimated: false, streamed: false, statusCode: 200, durationMs: 1,
  };
}

function boot(store: Store): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'test' });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function rawRequest(base: string, path: string, method: string, host: string): Promise<{ status: number; allow: string | undefined; text: string }> {
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: { host } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        allow: typeof res.headers.allow === 'string' ? res.headers.allow : undefined,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('GET /api/billing: empty evidence remains explicitly separate and unresolved', async () => {
  const store = new Store(':memory:');
  const srv = await boot(store);
  try {
    const res = await fetch(`${srv.base}/api/billing`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      evidence: Record<string, unknown>;
      summary: Record<string, unknown>;
      imports: unknown[];
      mapping: { coverageStatus: string; reconciliationStatus: string; totalRecordCount: number; excludedFrom: string[] };
      directOpenAiCosts: {
        kind: string;
        trust: string;
        reconciliationStatus: string;
        status: { latestRun: unknown };
        coverage: unknown;
      };
      kernel: { kind: string; claims: unknown[] };
    };
    assert.equal(body.evidence.kind, 'provider_billing_evidence');
    assert.equal(body.evidence.trust, 'operator_supplied_unverified');
    assert.equal(body.evidence.reconciliationStatus, 'not_reconciled');
    assert.equal(body.evidence.requestLedgerIncluded, false);
    assert.deepEqual(body.evidence.usedFor, []);
    assert.deepEqual(body.evidence.excludedFrom, [
      'request_metered_spend', 'budget_enforcement', 'outcome_attribution', 'roi', 'model_recommendations',
    ]);
    assert.equal(body.summary.recordCount, 0);
    assert.equal(body.summary.reconciliationStatus, 'not_reconciled');
    assert.deepEqual(body.imports, []);
    assert.equal(body.kernel.kind, 'trusted_epistemic_kernel_billing');
    assert.deepEqual(body.kernel.claims, []);
    assert.equal(body.mapping.coverageStatus, 'no_records');
    assert.equal(body.mapping.reconciliationStatus, 'blocked_no_records');
    assert.equal(body.mapping.totalRecordCount, 0);
    assert.deepEqual(body.mapping.excludedFrom, ['budget_enforcement', 'roi', 'model_recommendations']);
    assert.equal(body.directOpenAiCosts.kind, 'openai_organization_costs_observation');
    assert.equal(body.directOpenAiCosts.trust, 'provider_observation_unreconciled');
    assert.equal(body.directOpenAiCosts.reconciliationStatus, 'not_reconciled');
    assert.equal(body.directOpenAiCosts.status.latestRun, null);
    assert.equal(body.directOpenAiCosts.coverage, null);
  } finally {
    await srv.close();
    store.close();
  }
});

test('GET /api/billing exposes direct OpenAI observation status and local coverage without showing a provider total or variance', async () => {
  const store = new Store(':memory:');
  const start = Date.UTC(2026, 0, 1);
  const end = Date.UTC(2026, 0, 2);
  const scope = store.setOpenAiScope({
    billingAccountRef: 'billing-direct-fixture',
    providerProjectRef: 'proj_billing_fixture',
    upstreamBase: 'https://api.openai.com',
    declaredAtMs: 1,
    activatedAtMs: 1,
  });
  store.recordOpenAiCostsObservation({
    declaredScopeId: scope.declarationId,
    providerProjectRef: 'proj_billing_fixture',
    periodStartMs: start,
    periodEndMs: end,
    fetchedAtMs: 2,
    paginationComplete: true,
    pageCount: 1,
    pageDigestChainSha256: 'a'.repeat(64),
    resultState: 'succeeded',
    failureCode: null,
    observations: [{
      providerProjectRef: 'proj_billing_fixture',
      bucketStartMs: start,
      bucketEndMs: end,
      lineItem: 'completions',
      currency: 'USD',
      amountDecimal: '7.50',
    }],
  });
  store.insertRequest({
    ...meteredRequest(),
    requestId: 'direct-coverage-request',
    tsEpochMs: start + 1,
    scopeCaptureStatus: 'declared_unverified',
    providerScopeDeclarationId: scope.declarationId,
  });
  const srv = await boot(store);
  try {
    const billing = await fetch(`${srv.base}/api/billing`);
    assert.equal(billing.status, 200);
    const body = await billing.json() as {
      directOpenAiCosts: {
        status: { latestRun: { resultState: string; observationsStored: number } };
        coverage: { comparisonStatus: string; varianceStatus: string; capturedOnDeclaredRoute: { requestCount: number; costUsd: number }; observation: Record<string, unknown> };
      };
    };
    assert.equal(body.directOpenAiCosts.status.latestRun.resultState, 'succeeded');
    assert.equal(body.directOpenAiCosts.status.latestRun.observationsStored, 1);
    assert.equal(body.directOpenAiCosts.coverage.comparisonStatus, 'blocked_not_reconciled');
    assert.equal(body.directOpenAiCosts.coverage.varianceStatus, 'not_calculated');
    assert.equal(body.directOpenAiCosts.coverage.capturedOnDeclaredRoute.requestCount, 1);
    assert.equal(body.directOpenAiCosts.coverage.capturedOnDeclaredRoute.costUsd, 2.5);
    assert.equal('providerAmount' in body.directOpenAiCosts.coverage.observation, false);

    const overview = await fetch(`${srv.base}/api/overview?range=all`);
    const overviewBody = await overview.json() as { summary: { costUsd: number; requests: number } };
    assert.equal(overviewBody.summary.costUsd, 2.5, 'provider observation has no path into request-metered spend');
    assert.equal(overviewBody.summary.requests, 1);
  } finally {
    await srv.close();
    store.close();
  }
});

test('GET /api/billing: imported evidence has provenance but never changes overview request spend', async () => {
  const store = new Store(':memory:');
  store.insertRequest(meteredRequest());
  const imported = readBillingImportFile(FIXTURE).input;
  const importedRun = store.applyBillingImport(imported, 1_777);
  store.issueBillingImportToKernel(importedRun.run.importId);
  const srv = await boot(store);
  try {
    const billing = await fetch(`${srv.base}/api/billing`);
    assert.equal(billing.status, 200);
    const body = await billing.json() as {
      summary: { importCount: number; recordCount: number; providerReportedUsdMicros: number };
      imports: Array<{ sourceExportId: string; billingAccountRef: string; trust: string; rawRetention: string }>;
      mapping: {
        coverageStatus: string;
        reconciliationStatus: string;
        totalRecordCount: number;
        mappedRecordCount: number;
        residualMicros: number;
        excludedFrom: string[];
      };
      kernel: { kind: string; claims: Array<{ proposition: { predicate: string }; profile: { monetaryBasis: string; authenticity: string }; evidenceIds: string[] }> };
    };
    assert.deepEqual(body.summary, {
      importCount: 1,
      recordCount: 2,
      providerReportedUsdMicros: 11_345_678,
      lastImportedAtMs: 1_777,
      reconciliationStatus: 'not_reconciled',
    });
    assert.equal(body.imports.length, 1);
    assert.equal(body.imports[0]!.sourceExportId, imported.document.source.exportId);
    assert.equal(body.imports[0]!.billingAccountRef, imported.document.source.billingAccountRef);
    assert.equal(body.imports[0]!.trust, 'operator_supplied_unverified');
    assert.equal(body.imports[0]!.rawRetention, 'digest_only');
    assert.equal(body.mapping.coverageStatus, 'unmapped');
    assert.equal(body.mapping.reconciliationStatus, 'blocked_incomplete_mapping');
    assert.equal(body.mapping.totalRecordCount, 2);
    assert.equal(body.mapping.mappedRecordCount, 0);
    assert.equal(body.mapping.residualMicros, 11_345_678);
    assert.deepEqual(body.mapping.excludedFrom, ['budget_enforcement', 'roi', 'model_recommendations']);
    assert.equal(body.kernel.kind, 'trusted_epistemic_kernel_billing');
    assert.equal(body.kernel.claims.length, 1);
    assert.equal(body.kernel.claims[0]!.proposition.predicate, 'billing.billed_period_total');
    assert.equal(body.kernel.claims[0]!.profile.monetaryBasis, 'billed');
    assert.equal(body.kernel.claims[0]!.profile.authenticity, 'self_asserted');
    assert.equal(body.kernel.claims[0]!.evidenceIds.length, 2);

    const overview = await fetch(`${srv.base}/api/overview?range=all`);
    assert.equal(overview.status, 200);
    const overviewBody = await overview.json() as { summary: { costUsd: number; requests: number } };
    assert.equal(overviewBody.summary.costUsd, 2.5, 'provider report does not merge into request-metered spend');
    assert.equal(overviewBody.summary.requests, 1);
  } finally {
    await srv.close();
    store.close();
  }
});

test('/api/billing is read-only and retains the dashboard loopback host protection', async () => {
  const store = new Store(':memory:');
  const srv = await boot(store);
  try {
    const post = await rawRequest(srv.base, '/api/billing', 'POST', '127.0.0.1');
    assert.equal(post.status, 405);
    assert.equal(post.allow, 'GET');
    assert.equal(post.text, 'method not allowed');

    const rebound = await rawRequest(srv.base, '/api/billing', 'GET', 'untrusted.example');
    assert.equal(rebound.status, 403);
    assert.equal(rebound.text, 'forbidden');
  } finally {
    await srv.close();
    store.close();
  }
});

test('Billing dashboard client is a manual, separate view with no fabricated demo evidence', async () => {
  const previousDemo = process.env.FISCUS_DEMO;
  process.env.FISCUS_DEMO = '1';
  const store = new Store(':memory:');
  const srv = await boot(store);
  try {
    const res = await fetch(`${srv.base}/api/billing`);
    const body = await res.json() as { demo: boolean; summary: { recordCount: number; importCount: number } };
    assert.equal(body.demo, true);
    assert.equal(body.summary.recordCount, 0, 'demo mode does not fabricate billing charge lines');
    assert.equal(body.summary.importCount, 0, 'demo mode does not fabricate billing import provenance');

    const html = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard', 'web', 'classic.html'), 'utf8');
    assert.match(html, /data-view="billing"/);
    assert.match(html, /fetch\('\/api\/billing'\)/);
    assert.match(html, /NOT RECONCILED/);
    assert.match(html, /Direct OpenAI Costs observations/);
    assert.match(html, /No provider line-item total or provider\/request variance is displayed/);
    assert.match(html, /CURRENT_VIEW === 'overview'/);
    assert.doesNotMatch(html, /setInterval\(load, 4000\)/, 'Billing does not inherit the overview polling loop');
    const evidenceSource = readFileSync(join(import.meta.dirname, '..', 'src', 'dashboard', 'web', 'app', 'views', 'evidence.ts'), 'utf8');
    assert.match(evidenceSource, /Imported-record mapping/);
    assert.match(evidenceSource, /excluded from/);
  } finally {
    await srv.close();
    store.close();
    if (previousDemo === undefined) delete process.env.FISCUS_DEMO;
    else process.env.FISCUS_DEMO = previousDemo;
  }
});
