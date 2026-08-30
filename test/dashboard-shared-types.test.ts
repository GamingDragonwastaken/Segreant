import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DASHBOARD_API_CONTRACTS, DASHBOARD_PAYLOAD_CONTRACTS } from '../src/dashboard/contracts.ts';

const ROOT = join(import.meta.dirname, '..');
const SHARED_TYPES = join(ROOT, 'src', 'dashboard', 'shared-types.ts');
const GENERATED_TYPES = join(ROOT, 'src', 'dashboard', 'web', 'app', 'core', 'generated-types.ts');
const API = join(ROOT, 'src', 'dashboard', 'web', 'app', 'core', 'api.ts');

test('dashboard payload types have one canonical source and a hash-bound browser copy', () => {
  const source = readFileSync(SHARED_TYPES, 'utf8');
  const generated = readFileSync(GENERATED_TYPES, 'utf8');
  const api = readFileSync(API, 'utf8');
  const sourceSha = createHash('sha256').update(source, 'utf8').digest('hex');
  assert.match(generated, new RegExp(`Source SHA-256: ${sourceSha}`));
  const sourceDeclarations = source.slice(source.indexOf('export interface'));
  const generatedDeclarations = generated.slice(generated.indexOf('export interface'));
  assert.equal(generatedDeclarations, sourceDeclarations, 'browser shared type copy must be generated from the canonical declarations');
  assert.doesNotMatch(api, /^export interface /m, 'api.ts must not retain a second hand-written payload type source');
  assert.match(api, /generated-types\.ts/, 'api.ts must consume the generated browser type copy');
});

test('named dashboard response contracts contain no remaining inline JSON response descriptions', () => {
  const inline = [...DASHBOARD_API_CONTRACTS, ...DASHBOARD_PAYLOAD_CONTRACTS]
    .map((contract) => contract.responseType)
    .filter((responseType) => responseType !== 'text/csv' && (responseType.includes('inline') || responseType.startsWith('{') || responseType.includes('Record<string')));
  assert.deepEqual(inline, [], 'every JSON dashboard route should bind a named shared response type');
});
