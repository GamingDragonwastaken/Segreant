/**
 * scan --setup asks once for each detected plan's price: interactive terminals
 * only, Enter skips, an answer is saved through the validated config path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

// A home with a Claude Max 5x account and no Codex logs.
const fakeHome = mkdtempSync(join(tmpdir(), 'plan-ask-home-'));
writeFileSync(join(fakeHome, '.claude.json'), JSON.stringify({ oauthAccount: { organizationType: 'claude_max', userRateLimitTier: 'default_claude_max_5x' } }));
process.env.HOME = fakeHome;
process.env.USERPROFILE = fakeHome;
process.env.SEGREANT_HOME = mkdtempSync(join(tmpdir(), 'segreant-home-'));
const { askPlanPrices } = await import('../src/cli/planCmd.ts');
const { loadConfig } = await import('../src/config.ts');

function io(answers: string, interactive = true) {
  const input = new PassThrough();
  input.end(answers);
  const output = new PassThrough();
  let text = '';
  output.on('data', (c) => { text += String(c); });
  return { io: { input, output, interactive }, text: () => text };
}

test('a non-interactive run never asks and saves nothing', async () => {
  const s = io('', false);
  assert.equal(await askPlanPrices(false, s.io), 0);
  assert.equal(s.text(), '');
  assert.deepEqual(loadConfig().plans, {});
});

test('an answer is saved with the detected plan; the public price is offered as a hint only', async () => {
  const s = io('100\n');
  assert.equal(await askPlanPrices(false, s.io), 1);
  assert.match(s.text(), /Claude Max 5x, dollars per month \(public price 100\)/);
  const saved = loadConfig().plans['claude-code'];
  assert.equal(saved?.monthlyUsd, 100);
  assert.equal(saved?.plan, 'max');
  // Asked once: with a price set, it does not ask again.
  const again = io('');
  assert.equal(await askPlanPrices(false, again.io), 0);
  assert.equal(again.text(), '');
});
