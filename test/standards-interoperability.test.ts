import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DOC = join(import.meta.dirname, '..', 'docs', 'program', 'STANDARDS-INTEROPERABILITY.md');

test('WP-G04 standards map names primary sources, versions, adapters, and non-equivalence boundaries', () => {
  const text = readFileSync(DOC, 'utf8');
  for (const marker of [
    'OpenTelemetry', 'FOCUS', 'W3C PROV', 'Verifiable Credentials',
    'Data Integrity', 'in-toto', 'SLSA', 'SCITT',
  ]) assert.match(text, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  for (const url of [
    'https://opentelemetry.io/docs/specs/semconv/',
    'https://focus.finops.org/docs/specification/v1-3/datasets/cost-and-usage/',
    'https://www.w3.org/TR/prov-overview/',
    'https://www.w3.org/TR/vc-data-model-2.0/',
    'https://www.w3.org/TR/vc-data-integrity/',
    'https://slsa.dev/spec/v1.2/',
    'https://in-toto.io/docs/specs/',
  ]) assert.match(text, new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(text, /does not establish semantic truth/i);
  assert.match(text, /Research-only\. No SCITT/i);
  assert.match(text, /exact, estimated, imported,\s*partial, or unknown/i);
});
