/**
 * Close's remaining gaps, at the route level: the payload names the active
 * declaration and which imported export is in use under it, and the declaration
 * can be cleared with a preview first, exactly as `segreant billing scope clear`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/db.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';

const START = Date.UTC(2026, 6, 1);
const DAY = 86_400_000;
const iso = (offset: number) => new Date(START + offset * DAY).toISOString();

function exportDoc(project: string) {
  return {
    schemaVersion: 1,
    source: { system: 'operator-export', provider: 'openai', exportId: `close-gaps-${project}`, billingAccountRef: 'acct_close', exportedAt: iso(5), periodStart: iso(0), periodEnd: iso(2), coverage: 'complete' },
    records: [0, 1].map((i) => ({ sourceRecordId: `${project}-${i}`, chargePeriodStart: iso(i), chargePeriodEnd: iso(i + 1), observedAt: iso(i + 1), providerProjectRef: project, chargeType: 'usage', currency: 'USD', amount: '2.000000', sku: 'model-usage', service: 'api', model: 'gpt-5', region: null, usageUnit: 'tokens', usageQuantity: '1000' })),
  };
}

test('the billing payload names the declaration and marks the export in use under it, and clearing previews first', async () => {
  const home = mkdtempSync(join(tmpdir(), 'segreant-close-gaps-'));
  const saved = Object.fromEntries(['SEGREANT_HOME', 'SEGREANT_DB', 'SEGREANT_DEMO'].map((k) => [k, process.env[k]]));
  process.env.SEGREANT_HOME = home; delete process.env.SEGREANT_DB; delete process.env.SEGREANT_DEMO;
  const store = new Store(':memory:');
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'close-gaps' });
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const post = async (body: unknown, status = 200) => {
      const res = await fetch(`${base}/api/billing/write`, { method: 'POST', headers: { 'x-segreant-local': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const payload = await res.json() as Record<string, any>;
      assert.equal(res.status, status, JSON.stringify(payload));
      return payload;
    };
    const billing = async () => (await (await fetch(`${base}/api/billing`)).json()) as Record<string, any>;

    assert.equal((await billing()).activeScope, null, 'nothing declared yet');
    const nothing = await post({ op: 'scope-clear' });
    assert.equal(nothing.applied, false);
    assert.match(nothing.message, /nothing to clear/);

    const first = await post({ op: 'scope', accountRef: 'org_close', projectRef: 'proj_first', apply: true });
    const imported = await post({ op: 'import', fileName: 'first.json', contentBase64: Buffer.from(JSON.stringify(exportDoc('proj_first'))).toString('base64'), apply: true });
    let b = await billing();
    assert.equal(b.activeScope.billingAccountRef, 'org_close');
    assert.equal(b.activeScope.providerProjectRef, 'proj_first');
    assert.equal(b.activeScope.declarationId, first.declaration.declarationId);
    assert.equal(b.imports[0].inUse, null, 'imported but not adopted is not in use');

    const adopted = await post({ op: 'adopt', importId: imported.run.importId, apply: true });
    b = await billing();
    assert.deepEqual(b.imports[0].inUse?.observationRunId, adopted.observationRunId, 'the adopted export is in use under this declaration');
    assert.equal(typeof b.imports[0].inUse?.adoptedAtMs, 'number');

    // A new declaration: the same file was adopted for a different project, so
    // it is not in use for this one.
    await post({ op: 'scope', accountRef: 'org_close', projectRef: 'proj_second', apply: true });
    b = await billing();
    assert.equal(b.activeScope.providerProjectRef, 'proj_second');
    assert.equal(b.imports[0].inUse, null, 'an adoption under an earlier declaration does not carry over');

    const preview = await post({ op: 'scope-clear' });
    assert.equal(preview.applied, false);
    assert.equal(preview.active.providerProjectRef, 'proj_second');
    assert.match(preview.message, /Requests already recorded and recorded comparisons are unchanged/);
    assert.notEqual((await billing()).activeScope, null, 'a preview clears nothing');

    const cleared = await post({ op: 'scope-clear', apply: true });
    assert.equal(cleared.applied, true);
    assert.equal(cleared.cleared, true);
    assert.equal((await billing()).activeScope, null);
    assert.equal(store.activeOpenAiScope(), null);
    const again = await post({ op: 'scope-clear', apply: true });
    assert.equal(again.cleared, false);
    assert.match(again.message, /nothing changed/);

    await post({ op: 'scope-clear', extra: 1 }, 400);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(home, { recursive: true, force: true });
  }
});

test('a demo ledger previews clearing but refuses to apply it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'segreant-close-gaps-demo-'));
  const saved = Object.fromEntries(['SEGREANT_HOME', 'SEGREANT_DB', 'SEGREANT_DEMO'].map((k) => [k, process.env[k]]));
  process.env.SEGREANT_HOME = home; delete process.env.SEGREANT_DB; process.env.SEGREANT_DEMO = '1';
  const store = new Store(':memory:');
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'close-gaps-demo' });
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const send = (body: unknown) => fetch(`${base}/api/billing/write`, { method: 'POST', headers: { 'x-segreant-local': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await send({ op: 'scope-clear' })).status, 200);
    assert.equal((await send({ op: 'scope-clear', apply: true })).status, 409);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(home, { recursive: true, force: true });
  }
});
