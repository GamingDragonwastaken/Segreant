import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadOrCreateKeyPair } from '../src/value/receipt.ts';
import { economicAttributionView } from '../src/economics/attribution.ts';
import { money } from '../src/economics/money.ts';
import { buildEconomicRollupBody, signRollup, verifyRollup, type EconomicProjectValue } from '../src/team/rollup.ts';

const period = { from: '2026-06-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' };

test('economic team rollup v2 carries exact project lineage and verifies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-economic-rollup-'));
  try {
    const keys = loadOrCreateKeyPair(join(dir, 'key.json'));
    const exact = economicAttributionView({
      amount: money('1.234567', 'USD', 'effective'),
      eventIds: ['economic:request:r1:charge'],
      sourceBases: ['list'],
      requestCount: 1,
      unresolvedRequests: 0,
    });
    const project: EconomicProjectValue = {
      project: 'fiscus', units: 1, costUsd: 1.234567, realizationRate: 1,
      spendOnRealizedUnitsUsd: 1, acceptanceWeightedSpendUsd: 1, roiIndex: 2,
      sources: ['codex'],
      economic: { coverage: 'exact', total: exact, realized: exact },
    };
    const body = buildEconomicRollupBody(keys, [project], period);
    assert.equal(body.v, 2);
    const projectRow = body.projects[0]!;
    if (projectRow.economic === undefined || projectRow.economic.total === null) throw new Error('v2 project total is missing');
    assert.equal(projectRow.economic.total.amountText, '1.234567');
    const signed = signRollup(body, keys);
    assert.equal(verifyRollup(signed).valid, true);
    assert.equal(JSON.stringify(signed).includes('BigInt'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('economic team rollup v2 rejects missing exact lineage at construction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-economic-rollup-invalid-'));
  try {
    const keys = loadOrCreateKeyPair(join(dir, 'key.json'));
    assert.throws(() => buildEconomicRollupBody(keys, [{
      project: 'fiscus', units: 1, costUsd: 1, realizationRate: 1,
      spendOnRealizedUnitsUsd: 1, acceptanceWeightedSpendUsd: 1, roiIndex: 1, sources: [],
    } as unknown as EconomicProjectValue], period), /economic|lineage|coverage/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
