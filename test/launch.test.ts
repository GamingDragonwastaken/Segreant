/**
 * `segreant launch`: metered while the proxy is up, unmetered with a warning
 * when it is down, and refused when a budget cap is set (fail closed) unless
 * the operator explicitly allows an unmetered start.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.SEGREANT_HOME = mkdtempSync(join(tmpdir(), 'segreant-home-'));
import { planLaunch } from '../src/cli/launchCmd.ts';
import { DEFAULT_CONFIG, type SegreantConfig } from '../src/config.ts';

const noCap: SegreantConfig = { ...DEFAULT_CONFIG, port: 18123 };
const withCap: SegreantConfig = { ...noCap, budget: { ...noCap.budget, dailyUsd: 25 } };

test('proxy up: the child gets both base URLs on loopback', () => {
  const plan = planLaunch({ kind: 'up' }, noCap, false);
  assert.equal(plan.refuse, false);
  assert.deepEqual(plan.env, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:18123', OPENAI_BASE_URL: 'http://127.0.0.1:18123/v1' });
});

test('proxy down, no cap: starts unmetered and says so', () => {
  const plan = planLaunch({ kind: 'down' }, noCap, false);
  assert.equal(plan.refuse, false);
  assert.deepEqual(plan.env, {});
  assert.match(plan.notice, /without metering/);
});

test('proxy down with a cap: refuses, because the cap could not be enforced', () => {
  const plan = planLaunch({ kind: 'down' }, withCap, false);
  assert.equal(plan.refuse, true);
  assert.match(plan.notice, /budget cap is set/);
});

test('proxy down with a cap and --allow-unmetered: starts, still saying no cap applies', () => {
  const plan = planLaunch({ kind: 'down' }, withCap, true);
  assert.equal(plan.refuse, false);
  assert.match(plan.notice, /no cap applies/);
});

test('a refused health check is not treated as up', () => {
  const plan = planLaunch({ kind: 'blocked_by_egress', code: 'policy_denied', message: 'x', action: 'y' } as never, withCap, false);
  assert.equal(plan.refuse, true);
});

test('Windows command lines keep a spaced prompt as one argument', async () => {
  const { cmdQuote } = await import('../src/cli/launchCmd.ts');
  assert.equal(cmdQuote('opencode'), 'opencode');
  assert.equal(cmdQuote('opencode/big-pickle'), 'opencode/big-pickle');
  assert.equal(cmdQuote('fix the bug'), '"fix the bug"');
  assert.equal(cmdQuote('say "hi" & exit'), '"say ""hi"" & exit"');
  assert.equal(cmdQuote(''), '""');
});
