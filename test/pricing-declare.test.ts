import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RequestRow } from '../src/store/db.ts';
import type { Flags } from '../src/cli/flags.ts';

const home = mkdtempSync(join(tmpdir(), 'segreant-pricing-declare-'));
process.env.SEGREANT_HOME = home;
process.env.SEGREANT_DB = '';
process.env.SEGREANT_DEMO = '';

const { Store } = await import('../src/store/db.ts');
const { dbPath } = await import('../src/config.ts');
const { loadPriceOverrides, overridesPath, setPriceOverride } = await import('../src/cost/overrides.ts');
const { legacyPricingEvidence, rateFor } = await import('../src/cost/pricing.ts');
const { cmdPricing } = await import('../src/cli/runCmd.ts');
const { parseFlags } = await import('../src/cli/flags.ts');
const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');

beforeEach(() => {
  process.env.SEGREANT_HOME = mkdtempSync(join(home, 'case-'));
});
after(() => rmSync(home, { recursive: true, force: true }));

function row(requestId: string, model: string, costUsd: number, over: Partial<RequestRow> = {}): RequestRow {
  return {
    requestId, model, costUsd, provider: 'openai', sessionId: null, tsEpochMs: 1000,
    project: 'test', taskWeight: 1, inputTokens: 100, outputTokens: 20,
    cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, estimated: true,
    streamed: false, statusCode: 200, durationMs: 1,
    pricing: { ...legacyPricingEvidence(), costBasis: 'fallback_estimate', rateMatchKind: 'fallback' },
    ...over,
  };
}

function seed(rows: RequestRow[]): void {
  const store = new Store(dbPath());
  try { for (const r of rows) store.insertRequest(r); } finally { store.close(); }
}

async function command(args: string[] | Flags): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log;
  const error = console.error;
  const exit = process.exitCode;
  console.log = (...v: unknown[]) => { out.push(v.join(' ')); };
  console.error = (...v: unknown[]) => { err.push(v.join(' ')); };
  process.exitCode = 0;
  try {
    await cmdPricing(Array.isArray(args) ? parseFlags(args) : args);
    return { code: Number(process.exitCode), stdout: out.join('\n'), stderr: err.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
    process.exitCode = exit;
  }
}

function cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', CLI, ...args], {
      env: { ...process.env, NODE_OPTIONS: '' }, timeout: 30_000,
    }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

test('CLI set stores decimal rates and cache prices, reports all recorded use, and never reprices', async () => {
  seed([
    row('a', 'private-model', 2.25),
    row('b', 'private-model', 1.5, { provider: 'anthropic', via: 'import', estimated: false }),
    row('other', 'other-model', 90),
  ]);
  const before = readFileSync(dbPath());
  const run = await cli(['pricing', 'set', 'private-model', '--input', '0.20', '--output', '0.80', '--cache-read', '0.02', '--cache-write', '0.25']);
  assert.equal(run.code, 0, run.stderr);
  const stored = loadPriceOverrides().models['private-model'];
  assert.equal(stored?.kind, 'rate');
  assert.ok(stored?.kind === 'rate');
  assert.equal(stored.input, '0.20');
  assert.equal(stored.output, '0.80');
  assert.equal(stored.cacheRead, '0.02');
  assert.equal(stored.cacheWrite, '0.25');
  assert.match(run.stdout, /user.declared.*USD per 1M tokens/i);
  assert.match(run.stdout, /0\.02.*cache.read|cache.read.*0\.02/i);
  assert.match(run.stdout, /0\.25.*cache.write|cache.write.*0\.25/i);
  assert.match(run.stdout, /2 recorded requests.*recorded cost \(estimated\).*\$3\.75/i);
  assert.match(run.stdout, /segreant reprice.*preview/i);
  assert.match(run.stdout, /nothing changes without --apply/i);
  assert.deepEqual(readFileSync(dbPath()), before);
  const store = new Store(dbPath());
  try {
    assert.equal(store.summary(0, 2000).costUsd, 93.75);
    assert.deepEqual(store.requestPriceEvents('a'), []);
  } finally { store.close(); }
});

test('set without a ledger writes only the override, with no implicit cache rates', async () => {
  const run = await command(['set', 'private-rate', '--input', '1', '--output', '2']);
  assert.equal(run.code, 0, run.stderr);
  const price = loadPriceOverrides().models['private-rate'];
  assert.ok(price?.kind === 'rate');
  assert.equal(price.cacheRead, undefined);
  assert.equal(price.cacheWrite, undefined);
  assert.match(run.stdout, /0 recorded requests.*recorded cost \(estimated\).*\$0/);
  assert.equal(existsSync(dbPath()), false);
});

test('set like accepts an exact card model across providers', async () => {
  const run = await command(['set', 'private-like', '--like', 'claude-haiku-4-5']);
  assert.equal(run.code, 0, run.stderr);
  assert.equal(loadPriceOverrides().models['private-like']?.kind, 'like');
  assert.match(run.stdout, /user.declared.*like claude-haiku-4-5/i);
  assert.equal(rateFor('openai', 'private-like').pricing.rateMatchKind, 'user_declared');
});

for (const target of ['no-such-card-model', 'claude-haiku-4-5-20990101', 'private-declared']) {
  test(`set like refuses a target without an exact card entry: ${target}`, async () => {
    setPriceOverride('private-declared', { kind: 'free' });
    const before = readFileSync(overridesPath());
    const run = await command(['set', 'private-like', '--like', target]);
    assert.equal(run.code, 2);
    assert.match(run.stderr, /exact.*card.*segreant pricing --coverage/i);
    assert.deepEqual(readFileSync(overridesPath()), before);
  });
}

test('set free declares a local model and unset restores unresolved status without changing rows', async () => {
  seed([row('local', 'llama3.1:8b', 5)]);
  const before = readFileSync(dbPath());
  const set = await cli(['pricing', 'set', 'llama3.1:8b', '--free']);
  assert.equal(set.code, 0, set.stderr);
  assert.equal(loadPriceOverrides().models['llama3.1:8b']?.kind, 'free');
  assert.match(set.stdout, /user.declared.*free.*\$0/i);
  const unset = await command(['unset', 'llama3.1:8b']);
  assert.equal(unset.code, 0, unset.stderr);
  assert.match(unset.stdout, /removed.*llama3.1:8b/i);
  assert.equal(loadPriceOverrides().models['llama3.1:8b'], undefined);
  assert.equal(rateFor('openai', 'llama3.1:8b').pricing.rateMatchKind, 'fallback');
  assert.deepEqual(readFileSync(dbPath()), before);
  const again = await command(['unset', 'llama3.1:8b']);
  assert.equal(again.code, 0);
  assert.match(again.stdout, /no declared price/i);
});

const refused: Array<[string, string[]]> = [
  ['rate and free', ['--input', '1', '--output', '2', '--free']],
  ['like and free', ['--like', 'claude-haiku-4-5', '--free']],
  ['rate and like', ['--input', '1', '--output', '2', '--like', 'claude-haiku-4-5']],
  ['cache and free', ['--cache-read', '1', '--free']],
  ['cache and like', ['--cache-write', '1', '--like', 'claude-haiku-4-5']],
  ['no form', []],
  ['missing output', ['--input', '1']],
  ['bare input', ['--input', '--output', '2']],
  ['bare like', ['--like']],
  ['free value', ['--free', 'false']],
  ['invalid decimal', ['--input', '1e3', '--output', '2']],
  ['zero rate', ['--input', '0', '--output', '2']],
  ['unsupported option', ['--free', '--aply']],
];
for (const [name, args] of refused) {
  test(`set refuses ${name} with one line, exit 2 and no writes`, async () => {
    const run = await cli(['pricing', 'set', 'private-invalid', ...args]);
    assert.equal(run.code, 2, run.stdout + run.stderr);
    assert.equal(run.stderr.trim().split('\n').length, 1, run.stderr);
    assert.equal(existsSync(overridesPath()), false);
    assert.equal(existsSync(dbPath()), false);
  });
}

test('set/unset enforce model names and positional arity before mutation', async () => {
  for (const args of [
    ['set', '--free'], ['set', 'bad name', '--free'], ['set', 'constructor', '--free'],
    ['set', 'm', 'extra', '--free'], ['unset'], ['unset', 'bad name'], ['unset', 'm', 'extra'],
    ['unset', 'm', '--free'], ['unknown', 'extra'],
  ]) {
    const run = await command(args);
    assert.equal(run.code, 2, args.join(' '));
    assert.equal(existsSync(overridesPath()), false);
  }
});

test('unresolvedModels selects guessed evidence, excludes not_sent, and retains historical match cohorts', () => {
  const store = new Store(':memory:');
  try {
    for (const r of [
      row('a', 'mixed', 3), row('b', 'mixed', 2),
      row('c', 'mixed', 1, { pricing: { ...legacyPricingEvidence(), costBasis: 'local_list_price', rateMatchKind: 'family_cross_provider' } }),
      row('d', 'family', 10, { pricing: { ...legacyPricingEvidence(), costBasis: 'local_list_price', rateMatchKind: 'family_provider' } }),
      row('blocked', 'blocked', 100, { pricing: { ...legacyPricingEvidence(), costBasis: 'not_sent', rateMatchKind: 'family_provider' } }),
      row('legacy', 'legacy', 200, { pricing: legacyPricingEvidence() }),
      row('exact', 'claude-haiku-4-5', 20),
    ]) store.insertRequest(r);
    assert.deepEqual(store.unresolvedModels().map((r) => ({ ...r })), [
      { provider: 'openai', model: 'claude-haiku-4-5', requests: 1, costUsd: 20, rateMatchKind: 'fallback' },
      { provider: 'openai', model: 'family', requests: 1, costUsd: 10, rateMatchKind: 'family_provider' },
      { provider: 'openai', model: 'mixed', requests: 2, costUsd: 5, rateMatchKind: 'fallback' },
      { provider: 'openai', model: 'mixed', requests: 1, costUsd: 1, rateMatchKind: 'family_cross_provider' },
    ]);
  } finally { store.close(); }
});

test('unknown filters current exact and declared prices, combines cohorts, sorts by recorded cost and labels JSON', async () => {
  seed([
    row('a', 'private-unknown', 3),
    row('b', 'private-unknown', 4, { pricing: { ...legacyPricingEvidence(), costBasis: 'fallback_estimate', rateMatchKind: 'family_provider' } }),
    row('c', 'claude-haiku-4-5-20990101', 5, { provider: 'anthropic' }),
    row('d', 'private-unknown', 2, { provider: 'anthropic' }),
    row('known', 'claude-haiku-4-5', 99),
    row('known-provider', 'gpt-4o', 88),
    row('declared', 'private-declared', 80),
    row('like', 'private-like', 70),
    row('dangling', 'private-dangling', 1),
    row('blocked', 'private-blocked', 100, { pricing: { ...legacyPricingEvidence(), costBasis: 'not_sent', rateMatchKind: 'family_provider' } }),
  ]);
  setPriceOverride('private-declared', { kind: 'free' });
  setPriceOverride('private-like', { kind: 'like', like: 'gpt-4o' });
  setPriceOverride('private-dangling', { kind: 'like', like: 'absent-card-model' });
  const run = await cli(['pricing', 'unknown', '--json']);
  assert.equal(run.code, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.costBasis, 'recorded cost (estimated)');
  assert.deepEqual(payload.models, [
    { provider: 'openai', model: 'private-unknown', requests: 2, costUsd: 7, rateMatchKind: 'fallback' },
    { provider: 'anthropic', model: 'claude-haiku-4-5-20990101', requests: 1, costUsd: 5, rateMatchKind: 'family_provider' },
    { provider: 'anthropic', model: 'private-unknown', requests: 1, costUsd: 2, rateMatchKind: 'fallback' },
    { provider: 'openai', model: 'private-dangling', requests: 1, costUsd: 1, rateMatchKind: 'fallback' },
  ]);
  assert.match(payload.nextStep, /--input.*--output.*--like.*--free/);
  const text = await command(['unknown']);
  assert.equal(text.code, 0);
  assert.match(text.stdout, /openai.*private-unknown.*2 recorded requests.*recorded cost \(estimated\).*\$7.*fallback/);
  assert.match(text.stdout.split('\n').at(-1)!, /--input.*--output.*--like.*--free/);
});

test('unknown with no ledger prints an empty result and the three ways to declare a price', async () => {
  const run = await command(['unknown']);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /no.*unresolved/i);
  assert.match(run.stdout, /--input.*--output.*--like.*--free/);
  assert.equal(existsSync(dbPath()), false);
});

test('prompt skips Enter/s and saves each declaration form with a scripted io', async () => {
  const { promptForUnknownModels } = await import('../src/cli/pricingDeclareCmd.ts');
  const answers = ['', 's', 'l claude-haiku-4-5', 'p 0.2 0.8', 'f'];
  const questions: string[] = [];
  const printed: string[] = [];
  const made = await promptForUnknownModels(
    ['skip-enter', 'skip-s', 'prompt-like', 'prompt-rate', 'llama3.1:8b'].map((model) => ({ model })),
    { ask: async (q) => { questions.push(q); return answers.shift()!; }, print: (s) => { printed.push(s); } },
  );
  assert.deepEqual(made.map(({ model, kind }) => ({ model, kind })), [
    { model: 'prompt-like', kind: 'like' }, { model: 'prompt-rate', kind: 'rate' }, { model: 'llama3.1:8b', kind: 'free' },
  ]);
  assert.equal(questions.length, 5);
  assert.equal(questions[0], 'price for skip-enter? [Enter] skip  l <model> like another  p <in> <out> price per 1M  f free');
  assert.deepEqual(Object.keys(loadPriceOverrides().models).sort(), ['llama3.1:8b', 'prompt-like', 'prompt-rate']);
  assert.ok(made.every((d) => typeof d.declaredAt === 'string'));
  assert.match(printed.join('\n'), /user.declared/i);
  assert.equal(existsSync(dbPath()), false);
});

test('prompt re-asks invalid syntax, invalid prices and non-exact likes once, then skips', async () => {
  const { promptForUnknownModels } = await import('../src/cli/pricingDeclareCmd.ts');
  const answers = ['p 1', 'p 1 2', 'p 0 2', 'l no-such-card-model', 'l claude-haiku-4-5-20990101', 's', 'f extra', '', 'f'];
  const questions: string[] = [];
  const printed: string[] = [];
  const made = await promptForUnknownModels(
    ['retry-good', 'twice-invalid', 'retry-skip', 'retry-enter', 'next-model'].map((model) => ({ model })),
    { ask: async (q) => { questions.push(q); return answers.shift()!; }, print: (s) => { printed.push(s); } },
  );
  assert.deepEqual(made.map((d) => d.model), ['retry-good', 'next-model']);
  assert.equal(questions.length, 9);
  assert.equal(answers.length, 0);
  assert.match(printed.join('\n'), /skipped/i);
  assert.match(printed.join('\n'), /exact.*card/i);
});

test('full CLI help advertises set, unset and unknown', async () => {
  const run = await cli(['help', 'all']);
  assert.equal(run.code, 0, run.stderr);
  assert.match(run.stdout, /pricing set <model>.*--input.*--output/);
  assert.match(run.stdout, /--cache-read.*--cache-write/);
  assert.match(run.stdout, /pricing set <model> --like/);
  assert.match(run.stdout, /pricing set <model> --free/);
  assert.match(run.stdout, /pricing unset <model>/);
  assert.match(run.stdout, /pricing unknown.*--json/);
});
