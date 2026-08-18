import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CAPABILITIES, paritySummary } from '../src/dashboard/web/app/core/registry.ts';

test('every non-full GUI capability names the gap and a safe alternative', () => {
  for (const cap of CAPABILITIES) {
    if (cap.coverage === 'full') continue;
    assert.ok(cap.gapReason?.trim(), `${cap.id} missing gapReason`);
    assert.ok(cap.safeAlternative?.trim(), `${cap.id} missing safeAlternative`);
  }
});

test('report is represented as a local evidence mutation, not a read-only period report', () => {
  const report = CAPABILITIES.find((c) => c.id === 'report');
  assert.equal(report?.consequence, 'local');
  assert.equal(report?.territory, 'value');
  assert.match(report?.plain ?? '', /Attach|outcome/i);
});

test('safe budget recommendation is now fully readable in the GUI without applying anything', () => {
  const cap = CAPABILITIES.find((c) => c.id === 'budget-recommend');
  assert.equal(cap?.coverage, 'full');
  const p = paritySummary();
  assert.equal(p.total, CAPABILITIES.length);
  assert.ok(p.full >= 25);
});

test('network wording never says Fiscus has only one egress path', () => {
  const reg = readFileSync(new URL('../src/dashboard/web/app/core/registry.ts', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../src/dashboard/web/app/main.ts', import.meta.url), 'utf8');
  assert.ok(!reg.includes('only action in Fiscus that sends data off this machine'));
  assert.ok(!main.includes('Nothing is sent anywhere.'));
});

test('budget drawer describes live enforcement rather than a restart requirement', () => {
  const actions = readFileSync(new URL('../src/dashboard/web/app/core/actions.ts', import.meta.url), 'utf8');
  assert.ok(!actions.includes('on proxy restart'));
  assert.ok(!actions.includes('Restart Fiscus for the proxy'));
  assert.match(actions, /immediately for future in-path requests/);
});
