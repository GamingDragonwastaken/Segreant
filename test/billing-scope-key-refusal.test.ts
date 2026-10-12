/**
 * A scope reference is durable ledger content, so a key typed into it must be
 * refused before it is stored. Found by driving the dashboard's Close page with
 * a key-shaped organisation id: the preview accepted it, and Declare would have
 * written it to the ledger and the kernel.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newOpenAiScopeDeclaration } from '../src/billing/scope.ts';

const base = 'https://api.openai.com';

test('a key-shaped account or project reference is refused, in either field', () => {
  for (const key of ['sk-proj-abc123', 'sk-admin-xyz', 'SK-svcacct-1', 'rk-live-9', 'Bearer abc']) {
    assert.throws(() => newOpenAiScopeDeclaration({ billingAccountRef: key, providerProjectRef: 'proj_x', upstreamBase: base }), /looks like an API key/, key);
    assert.throws(() => newOpenAiScopeDeclaration({ billingAccountRef: 'org_x', providerProjectRef: key, upstreamBase: base }), /looks like an API key/, key);
  }
});

test('ordinary org and project ids are still accepted', () => {
  const d = newOpenAiScopeDeclaration({ billingAccountRef: 'org_abc', providerProjectRef: 'proj_abc', upstreamBase: base });
  assert.equal(d.billingAccountRef, 'org_abc');
  assert.equal(d.providerProjectRef, 'proj_abc');
  // A reference that merely contains "sk" is not a key.
  assert.equal(newOpenAiScopeDeclaration({ billingAccountRef: 'org_desk-team', upstreamBase: base }).billingAccountRef, 'org_desk-team');
});
