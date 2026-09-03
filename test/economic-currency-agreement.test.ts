/**
 * A USD-named field cannot agree with a non-USD amount (WP-C06 / WP-R06).
 *
 * THE DEFECT. Three places reconcile an exact `EconomicAttribution` against the
 * float compatibility field beside it, and all three compare MAGNITUDES only:
 *
 *   src/team/rollup.ts        canonicalEconomicProject
 *   src/value/receipt.ts      buildEconomicReceiptBody
 *   src/value/receipt.ts      receiptSemanticError
 *
 * Each reads `Math.abs(costUsd - Number(amountText)) > tolerance` and throws on
 * disagreement. `canonicalEconomicAttribution` — documented as the shared
 * validator both artifact protocols apply — checks that the basis is
 * `effective` and never looks at the currency, while `moneyFromJson` accepts any
 * `/^[A-Z]{3}$/` code. So an exact EUR 100.00 attribution "agrees with"
 * `costUsd: 100`, the receipt verifies, the rollup is accepted, and the team
 * server sums it into a column its own schema names `total_cost_usd`. EUR is
 * added to USD and labelled USD, on rows whose declared coverage is `exact`.
 *
 * WHY THE MAGNITUDE CHECK READS AS SUFFICIENT AND IS NOT. The comparison looks
 * like a conservation check, and against a float projection of the same amount
 * it is one. What it cannot see is that a number is not a quantity: 100 EUR and
 * 100 USD have the same magnitude and are not the same money. This is the
 * product's central distinction — a figure carries its basis AND its unit —
 * failing at the one boundary that exists to enforce it.
 *
 * WHERE THE RULE GOES. Not into `canonicalEconomicAttribution`: an exact amount
 * in another currency is a legitimate object, and refusing it there would ban
 * non-USD accounting outright. The defect is the RECONCILIATION against a field
 * named `costUsd`, so one shared helper now performs that reconciliation and the
 * three call sites use it.
 *
 * WHAT THIS DOES NOT ESTABLISH. It does not give Fiscus multi-currency receipts
 * or rollups; it refuses to misrepresent one, which is a different thing. The
 * compatibility field remains a float named for a currency, and the real repair
 * for that is carrying the unit on the wire rather than in a field name.
 * Recorded at D-096.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildEconomicReceiptBody, loadOrCreateKeyPair } from '../src/value/receipt.ts';
import { economicAttributionView } from '../src/economics/attribution.ts';
import { money } from '../src/economics/money.ts';
import { buildEconomicRollupBody, type EconomicProjectValue } from '../src/team/rollup.ts';
import type { FunnelOutcome } from '../src/value/gates.ts';

const period = { from: '2026-06-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' };

const funnel: FunnelOutcome = {
  reached: 'realized', diedAt: null, realized: true, realizationScore: 1, results: [],
} as unknown as FunnelOutcome;

function attribution(currency: string) {
  return economicAttributionView({
    amount: money('100', currency, 'effective'),
    eventIds: ['economic:request:r1:charge'],
    sourceBases: ['list'],
    requestCount: 1,
    unresolvedRequests: 0,
  });
}

function project(currency: string): EconomicProjectValue {
  const exact = attribution(currency);
  return {
    project: 'fiscus', units: 1, costUsd: 100, realizationRate: 1,
    spendOnRealizedUnitsUsd: 100, acceptanceWeightedSpendUsd: 100, roiIndex: 2,
    sources: ['codex'],
    economic: { coverage: 'exact', total: exact, realized: exact },
  };
}

test('a team rollup refuses an exact non-USD amount as agreement with costUsd', () => {
  // THE REFUSAL. The magnitudes match exactly — 100 and 100 — so the existing
  // comparison is satisfied. Only the unit disagrees, and the unit is the whole
  // question.
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-currency-rollup-'));
  try {
    const keys = loadOrCreateKeyPair(join(dir, 'key.json'));
    assert.throws(
      () => buildEconomicRollupBody(keys, [project('EUR')], period),
      /currency|USD/i,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a team rollup still accepts the USD amount it is named for', () => {
  // THE PERMITTED PATH. A rule that refused every exact amount would satisfy the
  // test above while destroying v2 rollups entirely.
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-currency-rollup-ok-'));
  try {
    const keys = loadOrCreateKeyPair(join(dir, 'key.json'));
    const body = buildEconomicRollupBody(keys, [project('USD')], period);
    assert.equal(body.v, 2);
    const row = body.projects[0]!;
    if (row.economic === undefined || row.economic.total === null) throw new Error('v2 project total is missing');
    assert.equal(row.economic.total.amountText, '100');
    assert.equal(row.economic.total.amount.currency, 'USD');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a signed receipt refuses an exact non-USD amount as agreement with costUsd', () => {
  // The second protocol, which shares the validator and repeated the same
  // magnitude-only reconciliation.
  assert.throws(
    () => buildEconomicReceiptBody('unit-1', 'fiscus', 100, 1, funnel, attribution('EUR')),
    /currency|USD/i,
  );
});

test('a signed receipt still accepts the USD amount it is named for', () => {
  const body = buildEconomicReceiptBody('unit-1', 'fiscus', 100, 1, funnel, attribution('USD'));
  assert.equal(body.v, 2);
  assert.equal(body.costUsd, 100);
  assert.equal(body.economic.amount.currency, 'USD');
});

test('the reconciliation still catches a magnitude disagreement, in either currency', () => {
  // The currency rule is added to the magnitude rule, not in place of it. A
  // change that only compared units would pass the refusals above while letting
  // a USD 100.00 exact amount sit beside costUsd 5.
  assert.throws(
    () => buildEconomicReceiptBody('unit-1', 'fiscus', 5, 1, funnel, attribution('USD')),
    /disagrees with exact amount/,
  );
});
