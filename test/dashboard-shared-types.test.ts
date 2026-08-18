import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Overview, BillingPayload, ValuePayload } from '../src/dashboard/web/app/core/contracts.ts';

test('dashboard transport contracts are a shared type-only module', () => {
  const names: Array<keyof Overview | keyof BillingPayload | keyof ValuePayload> = ['demo'];
  assert.deepEqual(names, ['demo']);
});
