import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOpenAiUpstream } from '../src/billing/scope.ts';
import { Store, type RequestRow } from '../src/store/db.ts';

function request(overrides: Partial<RequestRow> = {}): RequestRow {
  return {
    requestId: `request-${Math.random()}`,
    sessionId: null,
    tsEpochMs: 1_760_000_000_000,
    provider: 'openai',
    model: 'gpt-5',
    project: 'local-project',
    taskWeight: 1,
    inputTokens: 1,
    outputTokens: 1,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    costUsd: 0.01,
    estimated: false,
    streamed: false,
    statusCode: 200,
    durationMs: 1,
    ...overrides,
  };
}

test('OpenAI scope is credential-free, immutable, idempotent, and only matches the exact configured endpoint', () => {
  const canonical = normalizeOpenAiUpstream('https://api.openai.com/v1/?ignored=1#discarded');
  assert.equal(canonical.display, 'https://api.openai.com/v1');
  assert.throws(() => normalizeOpenAiUpstream('https://key:secret@api.openai.com/v1'), /credentials/i);
  const store = new Store(':memory:');
  try {
    const first = store.setOpenAiScope({
      billingAccountRef: 'finops-production',
      upstreamBase: 'https://api.openai.com/v1/?ignored=1',
      declaredAtMs: 100,
      activatedAtMs: 101,
    });
    const second = store.setOpenAiScope({
      billingAccountRef: 'finops-production',
      upstreamBase: 'https://api.openai.com/v1',
      declaredAtMs: 102,
      activatedAtMs: 103,
    });
    assert.equal(second.declarationId, first.declarationId, 'same immutable declaration is reused');
    assert.equal(store.activeOpenAiScope()?.declarationId, first.declarationId);
    assert.equal(store.matchingOpenAiScope('https://api.openai.com/v1/')?.declarationId, first.declarationId);
    assert.equal(store.matchingOpenAiScope('https://other.example/v1'), null);

    store.insertRequest(request({
      scopeCaptureStatus: 'declared_unverified',
      providerScopeDeclarationId: first.declarationId,
    }));
    store.insertRequest(request({ requestId: 'native-import', via: 'import' }));
    store.insertRequest(request({ requestId: 'new-unscoped' }));
    const captured = store.recent(10);
    assert.equal(captured.find((r) => r.requestId === 'native-import')?.scopeCaptureStatus, 'not_observed');
    assert.equal(captured.find((r) => r.requestId === 'new-unscoped')?.scopeCaptureStatus, 'unscoped');
    assert.equal(captured.find((r) => r.requestId === first.declarationId), undefined);
    assert.equal(captured.find((r) => r.providerScopeDeclarationId === first.declarationId)?.scopeCaptureStatus, 'declared_unverified');

    assert.equal(store.clearOpenAiScope(), true);
    assert.equal(store.activeOpenAiScope(), null);
    assert.equal(store.matchingOpenAiScope('https://api.openai.com/v1'), null);
    assert.equal(store.recent(10).find((r) => r.providerScopeDeclarationId === first.declarationId)?.scopeCaptureStatus, 'declared_unverified', 'historical capture is not rewritten');
  } finally {
    store.close();
  }
});
