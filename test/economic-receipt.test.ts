import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateKeyPair, buildEconomicReceiptBody, signReceipt, verifyReceipt, type ReceiptBodyV2 } from '../src/value/receipt.ts';
import { economicAttributionView } from '../src/economics/attribution.ts';
import { money } from '../src/economics/money.ts';
import type { FunnelOutcome } from '../src/value/gates.ts';

const funnel: FunnelOutcome = {
  realized: true,
  results: [{ gate: 'committed', verdict: 'pass', detail: 'fixture' }],
  reachedIndex: 0,
  reached: 'committed',
  diedAt: null,
  diedAtIndex: null,
  passes: 1,
  fails: 0,
  unknowns: 0,
  instrumented: 1,
  realizationScore: 1,
};

test('economic receipt v2 carries exact effective Money lineage and verifies semantically', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-economic-receipt-'));
  try {
    const keys = loadOrCreateKeyPair(join(dir, 'key.json'));
    const economic = economicAttributionView({
      amount: money('1.234567', 'USD', 'effective'),
      eventIds: ['economic:request:r1:charge', 'economic:request:r1:price-corrected'],
      sourceBases: ['list'],
      requestCount: 1,
      unresolvedRequests: 0,
    });
    const body = buildEconomicReceiptBody('deadbeef', 'fiscus', 1.234567, null, funnel, economic);
    assert.equal(body.v, 2);
    assert.equal(body.economic.amountText, '1.234567');
    assert.equal(body.economic.amount.basis, 'effective');
    assert.equal(body.economic.complete, true);
    const signed = signReceipt(body, keys);
    assert.equal(verifyReceipt(signed).valid, true);
    assert.equal(JSON.stringify(signed).includes('BigInt'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('economic receipt v2 refuses incomplete exact coverage and tampered lineage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-economic-receipt-invalid-'));
  try {
    const keys = loadOrCreateKeyPair(join(dir, 'key.json'));
    const incomplete = economicAttributionView({
      amount: money('1', 'USD', 'effective'), eventIds: ['economic:request:r1:charge'],
      sourceBases: ['list'], requestCount: 2, unresolvedRequests: 1,
    });
    assert.throws(() => buildEconomicReceiptBody('deadbeef', 'fiscus', 1, null, funnel, incomplete), /complete|unresolved/i);

    const exact = economicAttributionView({
      amount: money('1', 'USD', 'effective'), eventIds: ['economic:request:r1:charge'],
      sourceBases: ['list'], requestCount: 1, unresolvedRequests: 0,
    });
    const signed = signReceipt(buildEconomicReceiptBody('deadbeef', 'fiscus', 1, null, funnel, exact), keys);
    const body = signed.body as ReceiptBodyV2;
    const tampered = { ...signed, body: { ...body, economic: { ...body.economic, amountText: '2' } } };
    const result = verifyReceipt(tampered);
    assert.equal(result.valid, false);
    assert.match(result.reason, /body hash mismatch|economic/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
