/**
 * The Lift judge trust-ladder gate (src/judge/tier.ts): adversarial coverage. This
 * is the single security/privacy-critical decision point for the whole judge
 * feature — every test here is either "does the honest path work" or "can a
 * partial/malformed/adversarial config trick it into sending more than it
 * should." No tier above algorithmic may activate on anything less than its full,
 * documented set of independent opt-ins, and no tier's "send full content" flag
 * may affect any OTHER tier's behavior.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveJudgeTier, hasHostedJudgeApiKey, type JudgeTierDecision } from '../src/judge/tier.ts';
import type { JudgeConfig } from '../src/config.ts';

function cfg(overrides: Partial<JudgeConfig> = {}): JudgeConfig {
  return {
    localBaseUrl: null,
    localModel: null,
    localSendFullContent: false,
    hostedEnabled: false,
    hostedBaseUrl: null,
    hostedModel: null,
    hostedSendFullContent: false,
    ...overrides,
  };
}

function assertOff(d: JudgeTierDecision) {
  assert.equal(d.tier, 'algorithmic');
  assert.equal(d.confidence, 'algorithmic');
  assert.equal(d.sendsContentOffDevice, false);
}

test('resolveJudgeTier: default (all off) config is the algorithmic tier', () => {
  assertOff(resolveJudgeTier(cfg(), false));
});

test('resolveJudgeTier: localBaseUrl alone is sufficient for local-structural', () => {
  const d = resolveJudgeTier(cfg({ localBaseUrl: 'http://localhost:11434' }), false);
  assert.equal(d.tier, 'local-structural');
  assert.equal(d.confidence, 'local-llm');
  assert.equal(d.sendsContentOffDevice, false);
});

test('resolveJudgeTier: localBaseUrl + localSendFullContent → local-full, no hosted tier selected', () => {
  const d = resolveJudgeTier(cfg({ localBaseUrl: 'http://localhost:11434', localSendFullContent: true }), false);
  assert.equal(d.tier, 'local-full');
  assert.equal(d.confidence, 'local-llm', 'local structural and full share one confidence tag — same trust boundary');
  assert.equal(d.sendsContentOffDevice, false);
});

test('resolveJudgeTier: an empty-string or whitespace-only localBaseUrl is treated as unset, not as an opt-in', () => {
  assertOff(resolveJudgeTier(cfg({ localBaseUrl: '' }), false));
  assertOff(resolveJudgeTier(cfg({ localBaseUrl: '   ' }), false));
});

test('resolveJudgeTier: hostedEnabled alone (no API key) never activates hosted judging', () => {
  const d = resolveJudgeTier(cfg({ hostedEnabled: true, hostedBaseUrl: 'https://api.example.com' }), false);
  assertOff(d);
  assert.ok(d.notes.some((n) => n.includes('FISCUS_JUDGE_API_KEY is not set')));
});

test('resolveJudgeTier: an API key alone (hostedEnabled false) never activates hosted judging — the adversarial case', () => {
  // This is the important one: an env var set by accident, by a stale shell
  // profile, or by something else on the machine must NEVER be sufficient on
  // its own to start sending session data to a hosted API.
  const d = resolveJudgeTier(cfg({ hostedBaseUrl: 'https://api.example.com' }), true);
  assertOff(d);
  assert.ok(d.notes.some((n) => n.includes('judge.hostedEnabled is false')));
});

test('resolveJudgeTier: hostedEnabled + API key but no hostedBaseUrl falls back to algorithmic, not a broken hosted call', () => {
  const d = resolveJudgeTier(cfg({ hostedEnabled: true }), true);
  assertOff(d);
  assert.ok(d.notes.some((n) => n.includes('judge.hostedBaseUrl is not')));
});

test('resolveJudgeTier: all three hosted preconditions met → hosted-structural, never full content by default', () => {
  const d = resolveJudgeTier(cfg({ hostedEnabled: true, hostedBaseUrl: 'https://api.example.com' }), true);
  assert.equal(d.tier, 'hosted-structural');
  assert.equal(d.confidence, 'hosted-llm-structural');
  assert.equal(d.sendsContentOffDevice, true);
});

test('resolveJudgeTier: hosted-full requires its OWN explicit flag on top of the other two hosted opt-ins', () => {
  const d = resolveJudgeTier(
    cfg({ hostedEnabled: true, hostedBaseUrl: 'https://api.example.com', hostedSendFullContent: true }),
    true,
  );
  assert.equal(d.tier, 'hosted-full');
  assert.equal(d.confidence, 'hosted-llm-full');
  assert.equal(d.sendsContentOffDevice, true);
});

test('resolveJudgeTier: localSendFullContent never leaks into a hosted decision when local is off', () => {
  // A stray/leftover local flag must have zero effect once localBaseUrl is unset.
  const d = resolveJudgeTier(
    cfg({ localSendFullContent: true, hostedEnabled: true, hostedBaseUrl: 'https://api.example.com' }),
    true,
  );
  assert.equal(d.tier, 'hosted-structural', 'localSendFullContent must not upgrade the hosted tier to full');
});

test('resolveJudgeTier: hostedSendFullContent never leaks into a local decision when hosted is active alongside it', () => {
  const d = resolveJudgeTier(
    cfg({
      localBaseUrl: 'http://localhost:11434',
      hostedEnabled: true,
      hostedBaseUrl: 'https://api.example.com',
      hostedSendFullContent: true,
    }),
    true,
  );
  assert.equal(d.tier, 'local-structural', 'hostedSendFullContent must not upgrade the local tier to full');
});

test('resolveJudgeTier: when both local and hosted are fully configured, local wins (the more conservative default)', () => {
  const d = resolveJudgeTier(
    cfg({ localBaseUrl: 'http://localhost:11434', hostedEnabled: true, hostedBaseUrl: 'https://api.example.com' }),
    true,
  );
  assert.equal(d.tier, 'local-structural');
  assert.equal(d.sendsContentOffDevice, false, 'local precedence selects no hosted destination even though hosted is also configured');
  assert.ok(d.notes.some((n) => n.includes('using local')));
});

test('resolveJudgeTier: sendsContentOffDevice is true for exactly the two hosted tiers and no others', () => {
  const algorithmic = resolveJudgeTier(cfg(), false);
  const localStructural = resolveJudgeTier(cfg({ localBaseUrl: 'http://x' }), false);
  const localFull = resolveJudgeTier(cfg({ localBaseUrl: 'http://x', localSendFullContent: true }), false);
  const hostedStructural = resolveJudgeTier(cfg({ hostedEnabled: true, hostedBaseUrl: 'http://x' }), true);
  const hostedFull = resolveJudgeTier(cfg({ hostedEnabled: true, hostedBaseUrl: 'http://x', hostedSendFullContent: true }), true);

  assert.equal(algorithmic.sendsContentOffDevice, false);
  assert.equal(localStructural.sendsContentOffDevice, false);
  assert.equal(localFull.sendsContentOffDevice, false);
  assert.equal(hostedStructural.sendsContentOffDevice, true);
  assert.equal(hostedFull.sendsContentOffDevice, true);
});

test('hasHostedJudgeApiKey: reads FISCUS_JUDGE_API_KEY, and treats empty/whitespace as unset', () => {
  const prev = process.env.FISCUS_JUDGE_API_KEY;
  try {
    delete process.env.FISCUS_JUDGE_API_KEY;
    assert.equal(hasHostedJudgeApiKey(), false);

    process.env.FISCUS_JUDGE_API_KEY = '';
    assert.equal(hasHostedJudgeApiKey(), false);

    process.env.FISCUS_JUDGE_API_KEY = '   ';
    assert.equal(hasHostedJudgeApiKey(), false);

    process.env.FISCUS_JUDGE_API_KEY = 'sk-test-key-123';
    assert.equal(hasHostedJudgeApiKey(), true);
  } finally {
    if (prev === undefined) delete process.env.FISCUS_JUDGE_API_KEY;
    else process.env.FISCUS_JUDGE_API_KEY = prev;
  }
});
