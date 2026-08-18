import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

test('capability manifest preserves the four-claim invariant and names external proof gaps', () => {
  const m = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'docs', 'CAPABILITIES.json'), 'utf8'));
  assert.equal(m.coreInvariant, 'metered usage != provider-billed cost != allocated cost != realized value');
  const claims = new Map(m.truthClaims.map((x: any) => [x.id, x.status]));
  assert.equal(claims.get('real-provider-reconciliation'), 'external_validation_required');
  assert.equal(claims.get('team-server-production'), 'external_validation_required');
  assert.equal(claims.get('reconciliation-engine'), 'implemented');
});
