/**
 * Plans: detected from each tool's own files, priced only by the person.
 * Detection reads plan fields and nothing else; a price in config is strict.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SEGREANT_HOME = mkdtempSync(join(tmpdir(), 'segreant-home-'));
import { detectClaudePlan, detectCodexPlan, planName, suggestedPrice } from '../src/plans/detect.ts';
import { validatePlansConfig, ConfigValidationError } from '../src/config.ts';

test('Claude plan: organizationType and the Max multiple, from ~/.claude.json only', () => {
  const home = mkdtempSync(join(tmpdir(), 'plan-home-'));
  writeFileSync(join(home, '.claude.json'), JSON.stringify({
    oauthAccount: { organizationType: 'claude_max', userRateLimitTier: 'default_claude_max_20x', billingType: 'stripe_subscription', emailAddress: 'someone@example.invalid' },
  }));
  const p = detectClaudePlan(home);
  assert.equal(p.plan, 'max');
  assert.equal(p.tier, '20x');
  assert.equal(p.billing, 'stripe_subscription');
  assert.equal(planName(p), 'Claude Max 20x');
  assert.equal(suggestedPrice(p), 200);
  assert.ok(!JSON.stringify(p).includes('example.invalid'), 'nothing but plan fields is carried');
});

test('Claude plan: signed out or API key means unknown, never a guess', () => {
  const home = mkdtempSync(join(tmpdir(), 'plan-home-'));
  assert.equal(detectClaudePlan(home).plan, null);
  writeFileSync(join(home, '.claude.json'), JSON.stringify({ numStartups: 3 }));
  const p = detectClaudePlan(home);
  assert.equal(p.plan, null);
  assert.equal(suggestedPrice(p), null);
});

test('Codex plan: the last plan_type in the newest session log', () => {
  const root = mkdtempSync(join(tmpdir(), 'plan-codex-'));
  const older = join(root, '2026', '09', '30');
  const newer = join(root, '2026', '10', '01');
  mkdirSync(older, { recursive: true });
  mkdirSync(newer, { recursive: true });
  writeFileSync(join(older, 'rollout-a.jsonl'), '{"rate_limits":{"plan_type":"plus"}}\n');
  writeFileSync(join(newer, 'rollout-b.jsonl'), '{"rate_limits":{"plan_type":"plus"}}\n{"rate_limits":{"plan_type":"pro"}}\n');
  const p = detectCodexPlan(root);
  assert.equal(p.plan, 'pro', 'the newest day, the last mention');
  assert.equal(planName(p), 'ChatGPT Pro');
  assert.equal(detectCodexPlan(join(root, 'missing')).plan, null);
});

test('plan prices in config are exact, bounded and limited to known tools', () => {
  const ok = { 'claude-code': { monthlyUsd: 20, plan: 'pro', setAt: '2026-10-08T00:00:00.000Z' } };
  validatePlansConfig(ok);
  const bad: unknown[] = [
    [],
    { cursor: { monthlyUsd: 20, plan: null, setAt: '2026-10-08' } },
    { codex: { monthlyUsd: -1, plan: null, setAt: '2026-10-08' } },
    { codex: { monthlyUsd: Number.POSITIVE_INFINITY, plan: null, setAt: '2026-10-08' } },
    { codex: { monthlyUsd: 20, plan: null, setAt: 'not a date' } },
    { codex: { monthlyUsd: 20, plan: null, setAt: '2026-10-08', note: 'x' } },
  ];
  for (const value of bad) {
    assert.throws(() => validatePlansConfig(value), ConfigValidationError, JSON.stringify(value));
  }
});
