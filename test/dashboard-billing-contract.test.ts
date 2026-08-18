import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BillingPayload } from '../src/dashboard/web/app/core/api.ts';

test('BillingPayload models immutable reconciliation runs, not a fabricated latest field', () => {
  const payload: BillingPayload = {
    demo: false,
    evidence: { reconciliationStatus: 'reconciled_with_residual' },
    summary: { recordCount: 1 },
    reconciliation: {
      runs: [{
        reconciliationRunId: 'r1',
        computedAtMs: 123,
        result: { status: 'reconciled_with_residual', providerSourceKind: 'provider_api_pull', conditions: [] },
      }],
    },
  };
  assert.equal(payload.reconciliation?.runs[0]?.result.status, 'reconciled_with_residual');
  assert.equal(payload.reconciliation?.runs[0]?.computedAtMs, 123);
});
