/**
 * POST /api/billing/write: the GUI's route to `segreant billing`.
 *
 * Provider billing stays a separate evidence surface, so these pin what the
 * endpoint must not blur: a preview writes nothing, an apply writes exactly what
 * the CLI writes, a reconciliation is refused until its inputs exist, the
 * local-only gate holds, and demo mode refuses every apply.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store/db.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';
import { parseBillingImportText, readBillingImportFile } from '../src/billing/importer.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'billing', 'openai-operator-export.v1.json');
const FIXTURE_NAME = basename(FIXTURE);
const FIXTURE_TEXT = readFileSync(FIXTURE, 'utf8');

async function listen(server: http.Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Runs `body` against a dashboard over `store`, with SEGREANT_HOME pointed at a
 * fresh temp directory (the scope route reads the config from it) and
 * SEGREANT_DEMO set to `demo`, restoring both afterwards.
 */
async function withDashboard(store: Store, demo: boolean, body: (base: string) => Promise<void>): Promise<void> {
  const saved = { home: process.env.SEGREANT_HOME, demo: process.env.SEGREANT_DEMO };
  const home = mkdtempSync(join(tmpdir(), 'segreant-billing-write-'));
  process.env.SEGREANT_HOME = home;
  if (demo) process.env.SEGREANT_DEMO = '1';
  else delete process.env.SEGREANT_DEMO;
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'test' });
  try {
    const base = await listen(server);
    await body(base);
  } finally {
    await close(server);
    if (saved.home === undefined) delete process.env.SEGREANT_HOME;
    else process.env.SEGREANT_HOME = saved.home;
    if (saved.demo === undefined) delete process.env.SEGREANT_DEMO;
    else process.env.SEGREANT_DEMO = saved.demo;
    rmSync(home, { recursive: true, force: true });
  }
}

function post(base: string, payload: unknown, headers: Record<string, string> = { 'x-segreant-local': '1' }): Promise<Response> {
  return fetch(`${base}/api/billing/write`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
}

test('POST /api/billing/write without x-segreant-local is refused and writes nothing', async () => {
  const store = new Store(':memory:');
  await withDashboard(store, false, async (base) => {
    const res = await post(base, { op: 'import', fileName: FIXTURE_NAME, contentBase64: Buffer.from(FIXTURE_TEXT, 'utf8').toString('base64'), apply: true }, {});
    assert.equal(res.status, 403);
    assert.equal(store.billingImportRuns().length, 0);
  });
  store.close();
});

test('billing import: a preview writes nothing; apply records the file and is idempotent on replay', async () => {
  const store = new Store(':memory:');
  await withDashboard(store, false, async (base) => {
    const preview = await post(base, { op: 'import', fileName: FIXTURE_NAME, contentBase64: Buffer.from(FIXTURE_TEXT, 'utf8').toString('base64') });
    assert.equal(preview.status, 200);
    const previewBody = await preview.json() as { applied: boolean; preview: { recordsSeen: number; fileSha256: string; reconciliationStatus: string }; message: string };
    assert.equal(previewBody.applied, false);
    assert.equal(previewBody.preview.recordsSeen, 2);
    assert.match(previewBody.preview.fileSha256, /^[0-9a-f]{64}$/);
    assert.equal(previewBody.preview.reconciliationStatus, 'not_reconciled');
    assert.equal(store.billingImportRuns().length, 0, 'a preview must not record an import');

    const applied = await post(base, { op: 'import', fileName: FIXTURE_NAME, contentBase64: Buffer.from(FIXTURE_TEXT, 'utf8').toString('base64'), apply: true });
    assert.equal(applied.status, 200);
    const appliedBody = await applied.json() as {
      applied: boolean; duplicateFile: boolean; message: string;
      run: { importId: string; recordsInserted: number };
      kernel: { total: { coefficient: unknown; scale: unknown } };
    };
    assert.equal(appliedBody.applied, true);
    assert.equal(appliedBody.duplicateFile, false);
    assert.equal(appliedBody.run.recordsInserted, 2);
    assert.equal(typeof appliedBody.kernel.total.coefficient, 'string', 'the kernel total must travel as a string coefficient');
    assert.match(appliedBody.message, /Status remains not_reconciled/);
    assert.equal(store.billingImportRuns().length, 1);

    const replay = await post(base, { op: 'import', fileName: FIXTURE_NAME, contentBase64: Buffer.from(FIXTURE_TEXT, 'utf8').toString('base64'), apply: true });
    const replayBody = await replay.json() as { duplicateFile: boolean };
    assert.equal(replayBody.duplicateFile, true);
    assert.equal(store.billingImportRuns().length, 1, 'an identical file must not record a second import');
  });
  store.close();
});

test('billing reconcile on an empty store is 409 not_ready with the readiness report', async () => {
  const store = new Store(':memory:');
  await withDashboard(store, false, async (base) => {
    const res = await post(base, { op: 'reconcile' });
    assert.equal(res.status, 409);
    const body = await res.json() as { ok: boolean; op: string; status: string; readiness: { ready: boolean; missing: unknown[] } };
    assert.equal(body.ok, false);
    assert.equal(body.op, 'reconcile');
    assert.equal(body.status, 'not_ready');
    assert.equal(body.readiness.ready, false);
    assert.ok(body.readiness.missing.length > 0);
  });
  store.close();
});

test('billing write: an unknown field and an unknown op are refused with 400', async () => {
  const store = new Store(':memory:');
  await withDashboard(store, false, async (base) => {
    const unknownField = await post(base, { op: 'import', fileName: FIXTURE_NAME, contentBase64: Buffer.from(FIXTURE_TEXT, 'utf8').toString('base64'), colour: 'red' });
    assert.equal(unknownField.status, 400);
    assert.match(((await unknownField.json()) as { error: string }).error, /unknown field/);

    const unknownOp = await post(base, { op: 'delete_everything' });
    assert.equal(unknownOp.status, 400);

    const dirtyName = await post(base, { op: 'import', fileName: '../secrets/export.json', contentBase64: Buffer.from(FIXTURE_TEXT, 'utf8').toString('base64') });
    assert.equal(dirtyName.status, 400);
    assert.match(((await dirtyName.json()) as { error: string }).error, /basename/);
    assert.equal(store.billingImportRuns().length, 0);
  });
  store.close();
});

test('demo mode: every apply is refused with 409 and a preview is allowed', async () => {
  const store = new Store(':memory:');
  await withDashboard(store, true, async (base) => {
    const preview = await post(base, { op: 'import', fileName: FIXTURE_NAME, contentBase64: Buffer.from(FIXTURE_TEXT, 'utf8').toString('base64') });
    assert.equal(preview.status, 200);
    assert.equal(((await preview.json()) as { applied: boolean }).applied, false);

    const importApply = await post(base, { op: 'import', fileName: FIXTURE_NAME, contentBase64: Buffer.from(FIXTURE_TEXT, 'utf8').toString('base64'), apply: true });
    assert.equal(importApply.status, 409);
    assert.match(((await importApply.json()) as { error: string }).error, /Demo mode holds sample data only/);

    const scopeApply = await post(base, { op: 'scope', accountRef: 'acct-example-001', apply: true });
    assert.equal(scopeApply.status, 409);

    const reconcileApply = await post(base, { op: 'reconcile', apply: true });
    assert.equal(reconcileApply.status, 409);

    assert.equal(store.billingImportRuns().length, 0);
    assert.equal(store.activeOpenAiScope(), null);
  });
  store.close();
});

test('CLI parity: readBillingImportFile and parseBillingImportText give the same preview for the same bytes', () => {
  const fromFile = readBillingImportFile(FIXTURE);
  const fromText = parseBillingImportText(readFileSync(FIXTURE), basename(FIXTURE));
  assert.deepEqual(fromText.preview, fromFile.preview);
  assert.deepEqual(fromText.input, fromFile.input);
  assert.equal(fromText.preview.fileSizeBytes, readFileSync(FIXTURE).byteLength);
});

test('billing scope and adopt: scope is required before adoption, and adoption is recorded only on apply', async () => {
  const store = new Store(':memory:');
  await withDashboard(store, false, async (base) => {
    const scopePreview = await post(base, { op: 'scope', accountRef: 'acct-example-001', projectRef: 'proj_alpha' });
    assert.equal(scopePreview.status, 200);
    assert.equal(((await scopePreview.json()) as { applied: boolean }).applied, false);
    assert.equal(store.activeOpenAiScope(), null, 'a scope preview must not declare a scope');

    const noScope = await post(base, { op: 'adopt', importId: 'missing', apply: true });
    assert.equal(noScope.status, 409);
    assert.match(((await noScope.json()) as { error: string }).error, /Declare the route scope first/);

    const scopeApply = await post(base, { op: 'scope', accountRef: 'acct-example-001', projectRef: 'proj_alpha', apply: true });
    assert.equal(scopeApply.status, 200);
    assert.equal(((await scopeApply.json()) as { applied: boolean }).applied, true);
    assert.ok(store.activeOpenAiScope());

    const noImport = await post(base, { op: 'adopt', importId: 'missing', apply: true });
    assert.equal(noImport.status, 409);
    assert.match(((await noImport.json()) as { error: string }).error, /No OpenAI billing export has been imported/);

    const imported = await post(base, { op: 'import', fileName: FIXTURE_NAME, contentBase64: Buffer.from(FIXTURE_TEXT, 'utf8').toString('base64'), apply: true });
    assert.equal(imported.status, 200);
    const importId = store.billingImportRuns()[0]!.importId;

    const plan = await post(base, { op: 'adopt', importId });
    assert.equal(plan.status, 200);
    const planBody = await plan.json() as { applied: boolean; observationRunId: string | null; networkAttempted: boolean; credentialRead: boolean };
    assert.equal(planBody.applied, false);
    assert.equal(planBody.observationRunId, null);
    assert.equal(planBody.networkAttempted, false);
    assert.equal(planBody.credentialRead, false);

    const adopted = await post(base, { op: 'adopt', importId, apply: true });
    assert.equal(adopted.status, 200);
    const adoptedBody = await adopted.json() as { applied: boolean; observationRunId: string | null };
    assert.equal(adoptedBody.applied, true);
    assert.equal(typeof adoptedBody.observationRunId, 'string');
  });
  store.close();
});

test('billing scope: a malformed reference is refused with 400 and nothing is declared', async () => {
  const store = new Store(':memory:');
  await withDashboard(store, false, async (base) => {
    const empty = await post(base, { op: 'scope', accountRef: '', apply: true });
    assert.equal(empty.status, 400);

    // A multi-line value is how a pasted key or a stray secret would arrive; the scope module refuses it.
    const multiline = await post(base, { op: 'scope', accountRef: 'acct-example-001', projectRef: 'proj\nsecret', apply: true });
    assert.equal(multiline.status, 400);
    assert.match(((await multiline.json()) as { error: string }).error, /single-line reference/);

    const tooLong = await post(base, { op: 'scope', accountRef: 'a'.repeat(201), apply: true });
    assert.equal(tooLong.status, 400);

    assert.equal(store.activeOpenAiScope(), null);
  });
  store.close();
});
