// The one exception to local_locked: Segreant's own GET of the public price
// list. It must be exactly that request and nothing a caller can stretch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PRICE_LIST_URL, MAINTENANCE_RULE_ID, evaluateEgressPolicy } from '../src/egress/policy.ts';
import { DEFAULT_MANIFEST_URL } from '../src/cost/pricing.ts';

const locked = { mode: 'local_locked' as const, rules: [] };
const intent = { purpose: 'pricing_refresh' as const, dataClass: 'pricing_manifest' as const, method: 'GET', url: DEFAULT_PRICE_LIST_URL };

test('the built-in price list is allowed in local_locked, as a public-address target with its own rule id', () => {
  assert.equal(DEFAULT_MANIFEST_URL, DEFAULT_PRICE_LIST_URL, 'pricing and the boundary name the same file');
  const d = evaluateEgressPolicy(locked, intent);
  assert.equal(d.allowed, true);
  assert.equal(d.targetClass, 'controlled_cloud', 'DNS must still resolve to public addresses');
  assert.equal(d.ruleId, MAINTENANCE_RULE_ID);
});

test('nothing else gets through: another file, a query, another method, purpose or data class', () => {
  const denied = [
    { ...intent, url: DEFAULT_PRICE_LIST_URL.replace('model_prices', 'other_file') },
    { ...intent, url: 'https://raw.githubusercontent.com/attacker/repo/main/model_prices_and_context_window.json' },
    { ...intent, url: `${DEFAULT_PRICE_LIST_URL}?x=1` },
    { ...intent, url: `${DEFAULT_PRICE_LIST_URL}#a` },
    { ...intent, url: DEFAULT_PRICE_LIST_URL.replace('https:', 'http:') },
    { ...intent, method: 'POST' },
    { ...intent, purpose: 'alert_delivery' as const },
    { ...intent, dataClass: 'provider_request' as const },
    { ...intent, purpose: 'provider_inference' as const, dataClass: 'provider_request' as const, method: 'POST', url: 'https://api.anthropic.com/v1/messages' },
  ];
  for (const i of denied) {
    const d = evaluateEgressPolicy(locked, i as typeof intent);
    assert.equal(d.allowed, false, `${i.method} ${String(i.url)} ${i.purpose}/${i.dataClass}`);
  }
});

test('controlled_cloud still needs its own exact rule for the price list', () => {
  const d = evaluateEgressPolicy({ mode: 'controlled_cloud', rules: [] }, intent);
  assert.equal(d.allowed, false);
  assert.match(d.reason, /no exact enabled rule/);
});
