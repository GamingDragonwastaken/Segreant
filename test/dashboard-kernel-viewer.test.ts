/**
 * THE CLAIM INSPECTOR HAS A KERNEL BEHIND IT (WP-I01, D-257).
 *
 * `/api/kernel?node=<id>[&asOf=]` serves one kernel node with its
 * neighbourhood: the record as the ledger holds it, the edges into and out of
 * it, the derivations and assumptions behind a claim, and whether the
 * revocation projection reaches it — live, or as the ledger had it at an
 * instant. The Evidence view renders it as a reader: pick an issued billing
 * claim or type any id, follow an edge to its node, set a boundary.
 *
 * Held here: a billed-total claim rests on the import's evidence and the
 * evidence supports the claim (the DAG, both directions); the billing evidence
 * payload is withheld and says so with its hash; a boundary before the import
 * answers `found: false` for a node that exists now (hindsight-safe); a
 * malformed boundary and a missing id are 400s; the route is GET-only and
 * loopback-guarded like every other; the view binds the route.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { Store } from '../src/store/db.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { createDashboardServer } from '../src/dashboard/server.ts';
import { readBillingImportFile } from '../src/billing/importer.ts';
import type { KernelNodePayload } from '../src/dashboard/shared-types.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures', 'billing', 'openai-operator-export.v1.json');
const ROOT = join(import.meta.dirname, '..');

function boot(store: Store): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createDashboardServer({ store, config: structuredClone(DEFAULT_CONFIG), version: 'test' });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function rawRequest(base: string, path: string, method: string, host: string): Promise<{ status: number; allow: string | undefined }> {
  const url = new URL(path, base);
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: { host } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, allow: typeof res.headers.allow === 'string' ? res.headers.allow : undefined }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('GET /api/kernel serves a claim with its evidence edges both ways, withholds the billing payload, and replays an as-of boundary', async () => {
  const store = new Store(':memory:');
  const imported = readBillingImportFile(FIXTURE).input;
  const run = store.applyBillingImport(imported, 1_777);
  store.issueBillingImportToKernel(run.run.importId);
  const claimId = `claim:billing:billed-total:${run.run.importId}`;
  const srv = await boot(store);
  try {
    const live = await fetch(`${srv.base}/api/kernel?node=${encodeURIComponent(claimId)}`);
    assert.equal(live.status, 200);
    const claim = await live.json() as KernelNodePayload;
    assert.equal(claim.found, true);
    assert.equal(claim.asOf, null);
    assert.equal(claim.node?.kind, 'claim');
    assert.equal(claim.revoked, false);
    assert.ok(claim.restsOn.length >= 1, 'a billed-total claim rests on the import evidence');
    assert.ok(claim.restsOn.every((edge) => edge.to === claimId));
    assert.ok(claim.graphSize.nodes >= 2);
    const record = claim.record as { kind: string; claim: { id: string; proposition: { predicate: string } } };
    assert.equal(record.kind, 'claim');
    assert.equal(record.claim.proposition.predicate, 'billing.billed_period_total');
    assert.deepEqual(claim.derivations, [], 'a direct claim has no derivation behind it');

    // Follow one edge back to its evidence: the other direction of the DAG.
    const evidenceId = claim.restsOn[0]!.from;
    const evidence = await (await fetch(`${srv.base}/api/kernel?node=${encodeURIComponent(evidenceId)}`)).json() as KernelNodePayload;
    assert.equal(evidence.found, true);
    assert.equal(evidence.node?.kind, 'evidence');
    assert.ok(evidence.supports.some((edge) => edge.to === claimId), 'the evidence supports the claim it was cited by');
    const ev = evidence.record as { kind: string; evidence: { evidenceType: string; payloadWithheld: boolean; payload?: unknown; payloadDigest: string | null } };
    assert.equal(ev.kind, 'evidence');
    assert.match(ev.evidence.evidenceType, /^billing\./);
    assert.equal(ev.evidence.payloadWithheld, true, 'operator-supplied billing payloads are withheld');
    assert.equal('payload' in ev.evidence, false);
    assert.match(ev.evidence.payloadDigest ?? '', /^[0-9a-f]{64}$/, 'what is withheld is still named by its canonical digest');

    // A boundary before anything was recorded: the node is not there, and the
    // answer is the same as for a node that never existed.
    const before = await (await fetch(`${srv.base}/api/kernel?node=${encodeURIComponent(claimId)}&asOf=1970-01-01T00:00:00.000Z`)).json() as KernelNodePayload;
    assert.equal(before.found, false);
    assert.equal(before.asOf, '1970-01-01T00:00:00.000Z');
    assert.equal(before.node, null);
    assert.equal(before.graphSize.nodes, 0);
    const never = await (await fetch(`${srv.base}/api/kernel?node=claim:nothing`)).json() as KernelNodePayload;
    assert.equal(never.found, false);
    assert.ok(never.graphSize.nodes >= 2, 'a live not-found still states how much the ledger holds');

    // A boundary after the import replays to the same claim.
    const after = await (await fetch(`${srv.base}/api/kernel?node=${encodeURIComponent(claimId)}&asOf=2100-01-01T00:00:00.000Z`)).json() as KernelNodePayload;
    assert.equal(after.found, true);
    assert.equal(after.asOf, '2100-01-01T00:00:00.000Z');

    assert.equal((await fetch(`${srv.base}/api/kernel`)).status, 400);
    assert.equal((await fetch(`${srv.base}/api/kernel?node=${encodeURIComponent(claimId)}&asOf=yesterday`)).status, 400);
  } finally {
    await srv.close();
    store.close();
  }
});

test('/api/kernel is GET-only and keeps the loopback host protection', async () => {
  const store = new Store(':memory:');
  const srv = await boot(store);
  try {
    const post = await rawRequest(srv.base, '/api/kernel?node=x', 'POST', '127.0.0.1');
    assert.equal(post.status, 405);
    assert.equal(post.allow, 'GET, HEAD');
    const foreign = await rawRequest(srv.base, '/api/kernel?node=x', 'GET', 'evil.example');
    assert.notEqual(foreign.status, 200);
  } finally {
    await srv.close();
    store.close();
  }
});

test('the Evidence view renders the kernel viewer as a reader bound to the route', () => {
  const view = readFileSync(join(ROOT, 'src/dashboard/web/app/views/evidence.ts'), 'utf8');
  assert.match(view, /function kernelPanel\(d: BillingPayload\)/);
  assert.match(view, /api\.kernel\(id, asOf\(\)\.trim\(\) \|\| undefined\)/);
  assert.match(view, /kernelPanel\(d\),/, 'the panel is mounted in the view');
  assert.match(view, /text: 'reads only'/);
  assert.match(view, /payload withheld/);
  assert.doesNotMatch(view.slice(view.indexOf('function kernelPanel')), /openAction\(/, 'the viewer offers no action');
  const api = readFileSync(join(ROOT, 'src/dashboard/web/app/core/api.ts'), 'utf8');
  assert.match(api, /kernel: \(nodeId: string, asOf\?: string\) => request<KernelNodePayload>/);
});
