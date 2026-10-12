/**
 * A month closed entirely through the dashboard's write route: declare the
 * provider project, import the operator export, adopt it as the provider
 * observation, then preview and record the reconciliation.
 *
 * The endpoint's own tests cover each op's gate and refusals. This one walks
 * the order the engine needs, ending at the path no other test reached through
 * HTTP: a reconciliation that is ready, previewed without a write, then
 * recorded and visible on /api/billing. It also pins that the dashboard and the
 * CLI hash an export identically, so the same file imported once from each
 * surface is recognised as one file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, type RequestRow } from '../src/store/db.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';
import { readBillingImportFile } from '../src/billing/importer.ts';

const DAY = 24 * 60 * 60 * 1000;
const D0 = Date.UTC(2026, 6, 1);
const PROJECT = 'proj_close_fixture';
const day = (i: number): string => new Date(D0 + i * DAY).toISOString();

/** An operator export for two days, with a BOM so a text round-trip would change its bytes. */
function exportBytes(): Buffer {
  const doc = {
    schemaVersion: 1,
    source: {
      system: 'operator-export', provider: 'openai', exportId: 'export-close-1', billingAccountRef: 'acct-close',
      exportedAt: day(10), periodStart: day(0), periodEnd: day(2), coverage: 'complete',
    },
    records: [0, 1].map((i) => ({
      sourceRecordId: `line-${i}`, chargePeriodStart: day(i), chargePeriodEnd: day(i + 1), observedAt: day(i + 1),
      providerProjectRef: PROJECT, chargeType: 'usage', currency: 'USD', amount: '2.000000', sku: 'model-usage',
      service: 'api', model: 'gpt-5', region: null, usageUnit: 'tokens', usageQuantity: '1000',
    })),
  };
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(doc), 'utf8')]);
}

function proxyRow(id: string, scopeId: string, tsEpochMs: number, costUsd: number): RequestRow {
  return {
    requestId: id, sessionId: null, tsEpochMs, provider: 'openai', model: 'gpt-5', project: 'p', taskWeight: 1,
    inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, costUsd,
    estimated: false, streamed: false, statusCode: 200, durationMs: 1,
    scopeCaptureStatus: 'declared_unverified', providerScopeDeclarationId: scopeId,
  };
}

test('a month closes through /api/billing/write: scope, import, adopt, reconcile preview, record', async () => {
  const saved = { home: process.env.SEGREANT_HOME, demo: process.env.SEGREANT_DEMO };
  const home = mkdtempSync(join(tmpdir(), 'segreant-close-'));
  process.env.SEGREANT_HOME = home;
  delete process.env.SEGREANT_DEMO;
  const store = new Store(':memory:');
  const server: http.Server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'test' });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = async (body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> => {
      const res = await fetch(`${base}/api/billing/write`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-segreant-local': '1' }, body: JSON.stringify(body),
      });
      return { status: res.status, json: await res.json() as Record<string, unknown> };
    };

    // Before anything: the comparison refuses and says what is missing.
    const early = await post({ op: 'reconcile' });
    assert.equal(early.status, 409);
    assert.equal(early.json.status, 'not_ready');

    // 1. Declare the provider project this machine meters.
    const scope = await post({ op: 'scope', accountRef: 'org_close', projectRef: PROJECT, apply: true });
    assert.equal(scope.status, 200, JSON.stringify(scope.json));
    const scopeId = (scope.json.declaration as { declarationId: string }).declarationId;

    // 2. Import the export as raw bytes; preview writes nothing, apply writes the lines.
    const bytes = exportBytes();
    const body = { op: 'import', fileName: 'costs.json', contentBase64: bytes.toString('base64') };
    const preview = await post(body);
    assert.equal(preview.status, 200, JSON.stringify(preview.json));
    assert.equal(store.billingImportRuns(5).length, 0, 'an import preview writes nothing');
    const imported = await post({ ...body, apply: true });
    assert.equal(imported.status, 200, JSON.stringify(imported.json));
    const importId = (imported.json.run as { importId: string }).importId;

    // The CLI reads the same file and computes the same digest, so the store
    // recognises it as the file it already holds.
    const dir = mkdtempSync(join(tmpdir(), 'segreant-close-file-'));
    writeFileSync(join(dir, 'costs.json'), bytes);
    const cli = readBillingImportFile(join(dir, 'costs.json'));
    assert.equal(cli.preview.fileSha256, (imported.json.preview as { fileSha256: string }).fileSha256, 'GUI and CLI hash the same bytes');
    assert.equal(store.applyBillingImport(cli.input).duplicateFile, true, 'the CLI import of the same file is a duplicate');
    rmSync(dir, { recursive: true, force: true });

    // 3. Adopt it as the provider observation.
    const adoptPreview = await post({ op: 'adopt', importId });
    assert.equal(adoptPreview.status, 200, JSON.stringify(adoptPreview.json));
    assert.equal(adoptPreview.json.observationRunId, null);
    const adopted = await post({ op: 'adopt', importId, apply: true });
    assert.equal(adopted.status, 200, JSON.stringify(adopted.json));
    assert.equal(typeof adopted.json.observationRunId, 'string');

    // Live proxy traffic on the declared route, for both provider days.
    store.insertRequest(proxyRow('close-a', scopeId, D0 + DAY / 2, 1.5));
    store.insertRequest(proxyRow('close-b', scopeId, D0 + DAY + DAY / 2, 1.75));

    // 4. Preview the comparison: a result, nothing recorded.
    const recPreview = await post({ op: 'reconcile' });
    assert.equal(recPreview.status, 200, JSON.stringify(recPreview.json));
    const result = recPreview.json.result as { providerReportedMicros: number; localCapturedMicros: number; unexplainedVarianceMicros: number; status: string };
    assert.equal(result.status, 'reconciled_with_residual');
    assert.equal(result.providerReportedMicros, 4_000_000);
    assert.equal(result.localCapturedMicros, 3_250_000);
    assert.equal(result.unexplainedVarianceMicros, 750_000);
    assert.equal(recPreview.json.reconciliationRunId, null);
    assert.equal(store.reconciliationRuns(5).length, 0, 'a reconciliation preview records nothing');

    // ...then record it, and the billing read shows the run.
    const recorded = await post({ op: 'reconcile', apply: true });
    assert.equal(recorded.status, 200, JSON.stringify(recorded.json));
    assert.equal(typeof recorded.json.reconciliationRunId, 'string');
    const billing = await (await fetch(`${base}/api/billing`)).json() as { reconciliation: { runs: unknown[] }; imports: Array<{ importId: string }> };
    assert.equal(billing.reconciliation.runs.length, 1);
    assert.equal(billing.imports[0]!.importId, importId, 'the declared imports field carries the id the Close view adopts');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    if (saved.home === undefined) delete process.env.SEGREANT_HOME; else process.env.SEGREANT_HOME = saved.home;
    if (saved.demo !== undefined) process.env.SEGREANT_DEMO = saved.demo;
    rmSync(home, { recursive: true, force: true });
  }
});
