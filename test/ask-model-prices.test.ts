// The end-of-setup question: the costliest guessed models, at most five,
// interactive terminals only, Enter skips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

process.env.SEGREANT_HOME = mkdtempSync(join(tmpdir(), 'segreant-ask-models-'));
delete process.env.SEGREANT_DB;
delete process.env.SEGREANT_DEMO;

const { Store } = await import('../src/store/db.ts');
const { dbPath } = await import('../src/config.ts');
const { legacyPricingEvidence } = await import('../src/cost/pricing.ts');
import type { RequestRow } from '../src/store/db.ts';
const { askModelPrices } = await import('../src/cli/askModelPrices.ts');
const { loadPriceOverrides } = await import('../src/cost/overrides.ts');

function seed(model: string, count: number, costUsd = 0.6) {
  const store = new Store(dbPath());
  try {
    for (let i = 0; i < count; i++) {
      const row: RequestRow = {
        requestId: `${model}-${i}`, model, costUsd, provider: 'openai', sessionId: null, tsEpochMs: 1000 + i,
        project: 'test', taskWeight: 1, inputTokens: 100, outputTokens: 20, cacheWriteTokens: 0, cacheReadTokens: 0,
        reasoningTokens: 0, estimated: true, streamed: false, statusCode: 200, durationMs: 1,
        pricing: { ...legacyPricingEvidence(), costBasis: 'fallback_estimate', rateMatchKind: 'fallback' },
      };
      store.insertRequest(row);
    }
  } finally {
    store.close();
  }
}

function scripted(answers: string[]) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (d) => {
    text += String(d);
    if (String(d).trimEnd().endsWith(':')) input.write(`${answers.shift() ?? ''}\n`);
  });
  return { io: { input, output, interactive: true }, text: () => text };
}

test('a script, pipe or --json never waits', async () => {
  assert.equal(await askModelPrices(false, { input: new PassThrough(), output: new PassThrough(), interactive: false }), 0);
});

test('asks for the costliest guessed models only, and stores what was answered', async () => {
  seed('acme-private-big', 30);
  seed('acme-private-small', 1, 0.2);
  const s = scripted(['f']);
  const made = await askModelPrices(false, s.io);
  assert.equal(made, 1);
  assert.match(s.text(), /acme-private-big: 30 requests/);
  assert.doesNotMatch(s.text(), /acme-private-small/, 'a model under $0.50 is not worth a question');
  assert.match(s.text(), /segreant reprice/);
  assert.equal(loadPriceOverrides().models['acme-private-big']?.kind, 'free');
});

test('nothing to ask once every guessed model has a price', async () => {
  const s = scripted([]);
  assert.equal(await askModelPrices(false, s.io), 0);
  assert.equal(s.text(), '');
});
