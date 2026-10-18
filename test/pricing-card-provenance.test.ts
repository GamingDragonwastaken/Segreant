// The bundled card says where each price came from: the 63 models added from
// the public price list are not presented as checked against a provider's page
// (PR #146 review).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const card = JSON.parse(readFileSync(new URL('../pricing/models.json', import.meta.url), 'utf8')) as {
  notes: string[];
  providers: Record<string, { verified: boolean; source: string; models: Record<string, { source?: string }> }>;
};

test('models added from the public price list carry that source, and the notes say what "verified" covers', () => {
  const fromList = Object.values(card.providers).flatMap((p) => Object.entries(p.models).filter(([, r]) => r.source !== undefined));
  assert.equal(fromList.length, 63);
  assert.ok(fromList.every(([, r]) => /public price list/.test(r.source!) && /not checked against the provider/.test(r.source!)));
  assert.match(card.providers['anthropic']!.models['claude-haiku-5-5']!.source ?? '', /public price list/);
  assert.equal(card.providers['anthropic']!.models['claude-sonnet-4-6']!.source, undefined, 'a page-checked model keeps the provider source');
  assert.ok(card.notes.some((n) => /describe the other entries only/.test(n)));
});
