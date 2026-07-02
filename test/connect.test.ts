import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  SOURCE_HEADER,
  opencodeProviderBlock,
  stripJsonc,
  mergeOpencodeConfig,
  resolveOpencodeConfigPath,
  listOpencodeProviders,
  wrapOpencodeProvider,
} from '../src/connect/connectors.ts';

const REAL_CONFIG = `{
  // my providers
  "provider": {
    "featherless": { "npm": "@ai-sdk/openai-compatible", "options": { "baseURL": "https://api.featherless.ai/v1", "apiKey": "{env:FW}" } },
    "zen": { "npm": "@ai-sdk/anthropic", "options": { "apiKey": "{env:ZEN}" } }
  }
}`;

test('listOpencodeProviders: reports each provider and whether it is wrappable (has a baseURL)', () => {
  const ps = listOpencodeProviders(REAL_CONFIG);
  const by = Object.fromEntries(ps.map((p) => [p.name, p]));
  assert.equal(by.featherless!.wrappable, true);
  assert.equal(by.featherless!.baseUrl, 'https://api.featherless.ai/v1');
  assert.equal(by.zen!.wrappable, false); // hosted/managed — no baseURL to route
  assert.equal(by.zen!.baseUrl, null);
});

test('wrapOpencodeProvider: routes an existing provider through the proxy, preserves its key, returns the real upstream', () => {
  const res = wrapOpencodeProvider(REAL_CONFIG, 'featherless', 8090);
  assert.equal(res.ok, true);
  assert.equal(res.originalBaseUrl, 'https://api.featherless.ai/v1'); // → AegisFlow upstream
  const obj = JSON.parse(res.merged!);
  assert.equal(obj.provider.featherless.options.baseURL, 'http://localhost:8090'); // now the proxy
  assert.equal(obj.provider.featherless.options.apiKey, '{env:FW}', 'the user key is untouched');
  assert.equal(obj.provider.featherless.options.headers[SOURCE_HEADER], 'opencode');
});

test('wrapOpencodeProvider: idempotent — re-wrapping an already-proxied provider is a no-op tag-ensure', () => {
  const once = wrapOpencodeProvider(REAL_CONFIG, 'featherless', 8090).merged!;
  const twice = wrapOpencodeProvider(once, 'featherless', 8090);
  assert.equal(twice.ok, true);
  assert.equal(twice.alreadyWrapped, true);
  assert.equal(twice.originalBaseUrl, undefined); // don't clobber the AegisFlow upstream on re-run
});

test('wrapOpencodeProvider: refuses a hosted/managed provider (no baseURL) with an honest error', () => {
  const res = wrapOpencodeProvider(REAL_CONFIG, 'zen', 8090);
  assert.equal(res.ok, false);
  assert.ok(res.error && res.error.includes('hosted/managed'));
});

test('wrapOpencodeProvider: unknown provider fails safe', () => {
  const res = wrapOpencodeProvider(REAL_CONFIG, 'nope', 8090);
  assert.equal(res.ok, false);
  assert.ok(res.error);
});

test('opencodeProviderBlock: routes to the proxy (no /v1) and tags the source', () => {
  const block = opencodeProviderBlock(8090);
  assert.equal(block.npm, '@ai-sdk/openai-compatible');
  const opts = block.options as Record<string, unknown>;
  assert.equal(opts.baseURL, 'http://localhost:8090'); // NO /v1 — proxy appends the path
  const headers = opts.headers as Record<string, string>;
  assert.equal(headers[SOURCE_HEADER], 'opencode');
});

test('stripJsonc: removes // and /* */ comments and trailing commas, but never touches string content', () => {
  const jsonc = `{
    // a line comment
    "url": "http://localhost:8090", /* keep this URL intact */
    "weird": "a,]",
    "list": [1, 2, 3,],
  }`;
  const parsed = JSON.parse(stripJsonc(jsonc));
  assert.equal(parsed.url, 'http://localhost:8090'); // the // inside the string survived
  assert.equal(parsed.weird, 'a,]'); // the ,] inside the string was NOT treated as a trailing comma
  assert.deepEqual(parsed.list, [1, 2, 3]);
});

test('mergeOpencodeConfig: empty config gets a fresh AegisFlow source provider', () => {
  const res = mergeOpencodeConfig('', 8090);
  assert.equal(res.ok, true);
  assert.equal(res.alreadyConnected, false);
  const obj = JSON.parse(res.merged!);
  assert.equal(obj.provider.aegisflow.options.headers[SOURCE_HEADER], 'opencode');
});

test('mergeOpencodeConfig: preserves the user\'s existing apiKey and other providers; only adds the tag', () => {
  const raw = `{
    // my opencode config
    "provider": {
      "featherless": { "npm": "@ai-sdk/openai-compatible", "options": { "apiKey": "{env:FW}" } },
      "aegisflow": {
        "npm": "@ai-sdk/openai-compatible",
        "options": { "baseURL": "http://localhost:8090", "apiKey": "{env:MY_SECRET}" }
      },
    },
  }`;
  const res = mergeOpencodeConfig(raw, 8090);
  assert.equal(res.ok, true);
  assert.equal(res.alreadyConnected, false); // header wasn't there yet
  const obj = JSON.parse(res.merged!);
  assert.equal(obj.provider.featherless.options.apiKey, '{env:FW}', 'other providers preserved');
  assert.equal(obj.provider.aegisflow.options.apiKey, '{env:MY_SECRET}', 'the user key is NOT clobbered');
  assert.equal(obj.provider.aegisflow.options.headers[SOURCE_HEADER], 'opencode', 'source tag added');
});

test('mergeOpencodeConfig: idempotent — an already-tagged config reports alreadyConnected', () => {
  const first = mergeOpencodeConfig('', 8090).merged!;
  const res = mergeOpencodeConfig(first, 8090);
  assert.equal(res.ok, true);
  assert.equal(res.alreadyConnected, true);
  const obj = JSON.parse(res.merged!);
  assert.equal(obj.provider.aegisflow.options.headers[SOURCE_HEADER], 'opencode');
});

test('mergeOpencodeConfig: unparseable input fails safe (ok:false) so the caller prints instead of writing garbage', () => {
  const res = mergeOpencodeConfig('{ this is : not json', 8090);
  assert.equal(res.ok, false);
  assert.equal(res.merged, undefined);
  assert.ok(res.error);
});

test('resolveOpencodeConfigPath: OPENCODE_CONFIG → project-level → global (matches opencode precedence)', () => {
  const home = join('/home', 'u');
  const cwd = join('/work', 'proj');
  const projJson = join(cwd, 'opencode.json');
  const globJsonc = join(home, '.config', 'opencode', 'opencode.jsonc');

  // Explicit env path wins when it exists.
  assert.equal(
    resolveOpencodeConfigPath({ env: '/custom/x.json', cwd, home, exists: (p) => p === '/custom/x.json' }),
    '/custom/x.json',
  );
  // A set-but-missing env path falls through to the project-level config.
  assert.equal(
    resolveOpencodeConfigPath({ env: '/custom/x.json', cwd, home, exists: (p) => p === projJson }),
    projJson,
  );
  // No env, no project → the global config.
  assert.equal(resolveOpencodeConfigPath({ cwd, home, exists: (p) => p === globJsonc }), globJsonc);
  // Nothing exists → null (connect then creates a fresh global config on --write).
  assert.equal(resolveOpencodeConfigPath({ cwd, home, exists: () => false }), null);
});
