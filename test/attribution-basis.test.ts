/**
 * Attribution provenance — every project label records HOW it was obtained.
 *
 * Money is reported per project, so "which project does this cost belong to" is
 * a financial claim. Before this, a header a client set itself, a folder
 * basename, and a request that declared nothing were stored identically. These
 * tests pin the distinctions, and in particular that adding the basis moved no
 * money: the same dollars must still roll up the same way.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, type RequestRow } from '../src/store/db.ts';
import { projectKeyWithBasis, isDeclaredAttribution } from '../src/value/characterization.ts';
import { requestsToCsv } from '../src/export/csv.ts';

const row = (
  id: string,
  project: string,
  basis: RequestRow['attributionBasis'],
  costUsd = 1,
): RequestRow => ({
  requestId: id, sessionId: null, tsEpochMs: 1000, provider: 'openai', model: 'gpt', project,
  attributionBasis: basis, taskWeight: 1, inputTokens: 1, outputTokens: 1, cacheWriteTokens: 0,
  cacheReadTokens: 0, reasoningTokens: 0, costUsd, estimated: false, streamed: false,
  statusCode: 200, durationMs: 1,
});

test('projectKeyWithBasis: a real path infers, an unusable one falls back to the tool name', () => {
  assert.deepEqual(projectKeyWithBasis('/home/me/backend-api', 'codex'), { project: 'backend-api', basis: 'tool_log_inferred' });
  assert.deepEqual(projectKeyWithBasis('C:\\work\\backend-api', 'codex'), { project: 'backend-api', basis: 'tool_log_inferred' });
  assert.deepEqual(projectKeyWithBasis('', 'codex'), { project: 'codex', basis: 'tool_log_fallback' });
  assert.deepEqual(projectKeyWithBasis(null, 'codex'), { project: 'codex', basis: 'tool_log_fallback' });
});

test('projectKeyWithBasis: a directory genuinely named after its tool is INFERRED, not a fallback', () => {
  // The label is identical to the fallback, so a naive `project === fallback`
  // check would misreport real evidence as a placeholder.
  assert.deepEqual(projectKeyWithBasis('/home/me/codex', 'codex'), { project: 'codex', basis: 'tool_log_inferred' });
});

test('attribution: an undeclared request is distinguishable from a project named "default"', () => {
  const store = new Store(':memory:');
  store.insertRequest(row('a', 'default', 'unattributed', 2));
  store.insertRequest(row('b', 'default', 'client_declared', 3));
  const ev = store.attributionEvidenceByProject(0, 5000);
  const bases = new Map(ev.map((e) => [e.attributionBasis, e.costUsd]));
  assert.equal(ev.length, 2, 'one label, two bases — never merged into a single row');
  assert.equal(bases.get('unattributed'), 2);
  assert.equal(bases.get('client_declared'), 3);
  store.close();
});

test('attribution: the basis moves no money — evidence totals equal byProject exactly', () => {
  const store = new Store(':memory:');
  store.insertRequest(row('a', 'api', 'client_declared', 2));
  store.insertRequest(row('b', 'api', 'unattributed', 3));
  store.insertRequest(row('c', 'web', 'tool_log_inferred', 4));
  const rollup = new Map(store.byProject(0, 5000).map((b) => [b.label, b.costUsd]));
  const evidence = new Map<string, number>();
  for (const e of store.attributionEvidenceByProject(0, 5000)) {
    evidence.set(e.project, (evidence.get(e.project) ?? 0) + e.costUsd);
  }
  assert.deepEqual([...evidence].sort(), [...rollup].sort());
  assert.equal(rollup.get('api'), 5);
  store.close();
});

test('attribution: evidence rolls up under the alias canonical, like byProject', () => {
  const store = new Store(':memory:');
  store.insertRequest(row('a', 'aegisflow-ts', 'client_declared', 1));
  store.insertRequest(row('b', 'aegisflow', 'client_declared', 2));
  store.setProjectAlias('aegisflow-ts', 'aegisflow');
  const ev = store.attributionEvidenceByProject(0, 5000);
  assert.equal(ev.length, 1, 'both rows share a canonical label and one basis');
  assert.equal(ev[0]!.project, 'aegisflow');
  assert.equal(ev[0]!.costUsd, 3);
  store.close();
});

test('attribution: a row written before the basis existed stays legacy_unknown — never backfilled', () => {
  const store = new Store(':memory:');
  // Simulate a pre-migration row: the writer supplies no basis at all.
  const legacy = { ...row('old', 'api', undefined) };
  delete (legacy as { attributionBasis?: unknown }).attributionBasis;
  store.insertRequest(legacy as RequestRow);
  const [ev] = store.attributionEvidenceByProject(0, 5000);
  assert.equal(ev!.attributionBasis, 'legacy_unknown', 'guessing here would manufacture certainty');
  assert.equal(isDeclaredAttribution('legacy_unknown'), false);
  store.close();
});

test('attribution: an unrecognized stored basis reads as legacy_unknown, not passed through', () => {
  const store = new Store(':memory:');
  store.insertRequest({ ...row('a', 'api', 'client_declared'), attributionBasis: 'totally_made_up' as never });
  const [r] = store.requestsInRange(0, 5000);
  assert.equal(r!.attributionBasis, 'legacy_unknown', 'an uninterpretable label must not look like a real basis');
  store.close();
});

test('attribution: only a deliberate attribution counts as declared — and none of them is verified', () => {
  assert.equal(isDeclaredAttribution('client_declared'), true);
  assert.equal(isDeclaredAttribution('tool_log_inferred'), true);
  assert.equal(isDeclaredAttribution('tool_log_fallback'), false, 'a tool-name placeholder is not attribution');
  assert.equal(isDeclaredAttribution('unattributed'), false);
  assert.equal(isDeclaredAttribution('synthetic_demo'), false, 'demo data is never a real attribution');
  assert.equal(isDeclaredAttribution('legacy_unknown'), false);
});

test('attribution: the export carries the basis alongside the label', () => {
  const store = new Store(':memory:');
  store.insertRequest(row('a', 'default', 'unattributed'));
  const csv = requestsToCsv(store.requestsInRange(0, 5000));
  const [header, first] = csv.trim().split('\r\n');
  assert.ok(header!.includes('project,projectCanonical,attributionBasis'));
  assert.ok(first!.includes(',default,default,unattributed,'));
  store.close();
});
