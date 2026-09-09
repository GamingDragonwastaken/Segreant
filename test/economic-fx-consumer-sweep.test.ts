/**
 * EVERY CONSUMER OF A MONETARY FIGURE, SWEPT — AND THE CORPUS STATED.
 *
 * `WP-C03`'s remainder is "universal export/read-model adoption beyond the
 * bounded Store/export/dashboard/CLI paths" and `WP-C04`'s is "universal
 * mixed-currency consumer coverage". D-124/D-125 built the explicit effective-FX
 * read model; the remainder was never that the model is wrong, it is that not
 * every reader of a monetary figure goes through it.
 *
 * So this file is an enumeration first and a set of assertions second. It
 * derives the corpus of monetary READ SITES from the source tree, states its
 * size, and requires every file holding one to be classified:
 *
 *   (a) routed through the effective-FX read model — it can name a target
 *       currency, selects a historical rate by effective time and recorded-time
 *       `asOf`, and carries currency + rate identity out with the figure;
 *   (b) not routed and consequential — it produced or could produce a figure
 *       whose unit is asserted rather than carried;
 *   (c) not routed and correctly single-currency by construction — it refuses,
 *       or is structurally incapable of holding, a non-base amount.
 *
 * WHY THE COUNT IS PART OF THE RESULT. A sweep is worth exactly the corpus it
 * ran over. A partial sweep whose size is not stated reads as coverage, and that
 * is this repository's most-recorded defect class — twenty-one instances, written
 * up in `docs/program/METHOD-ABSENCE-AS-RESULT.md`, step 7. The counts below are
 * asserted with floors so a regex that stops matching fails loudly instead of
 * quietly sweeping nothing.
 *
 * WHAT THIS SWEEP DOES NOT COVER, stated here rather than discovered later:
 *
 *  - `src/team/**` is excluded. A concurrent packet owns it; its two read sites
 *    in `src/team/rollup.ts` are real and are NOT counted or classified here.
 *  - The corpus is CALL sites. A reader that only touches a money-bearing FIELD
 *    is invisible to it — `src/dashboard/web/app/views/value.ts` renders
 *    `total.amountText` and appears in no count below. It is classified by hand
 *    in `EXTRA_CONSUMERS` instead, which is weaker evidence than a match.
 *  - Nothing here parses arithmetic. It finds readers, not wrong sums.
 *  - Provider FX authority is DELIBERATELY NOT DECIDED. Whether a provider's own
 *    rate outranks the local historical book is a product policy the owner has
 *    not settled. `PROVIDER_FX_AUTHORITY_SITES` enumerates where such a policy
 *    would land and stops there.
 *
 * Recorded at D-200.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT, sourceFiles } from './support/importGraph.ts';
import {
  canonicalEconomicAttribution,
  economicAttributionFromAttributions,
  economicAttributionFromRows,
  economicAttributionNumber,
  economicAttributionView,
  type EconomicAttribution,
} from '../src/economics/attribution.ts';
import { formatMoneyAmount, money, moneyToJson } from '../src/economics/money.ts';
import { applyExactAllocation, serializeExactAllocationRun, type ExactAllocationRunResult } from '../src/alloc/exact.ts';
import { buildExactAllocationKernelIssuance } from '../src/alloc/epistemic.ts';
import type { AllocationRule, CostCentre } from '../src/alloc/rules.ts';
import { EconomicLedger } from '../src/economics/ledger.ts';
import { requestEconomicEvent, requestEconomicEventId } from '../src/economics/request.ts';
import { exactRate } from '../src/economics/rate.ts';
import { interval } from '../src/epistemic/time.ts';
import { effectiveRequestRow } from '../src/store/economicReadModel.ts';
import { buildEconomicRequestExportRows } from '../src/export/economic.ts';

// ---------------------------------------------------------------------------
// The enumeration
// ---------------------------------------------------------------------------

/**
 * A monetary READ: a call that takes an exact `Money`, a rate, or an effective
 * projection and returns, renders or aggregates a figure from it. Constructors
 * (`money()`, `exactRate()`) are excluded on purpose — a value being built is
 * not yet a figure anyone has read.
 */
const MONETARY_READ = new RegExp(
  '\\b(' + [
    'formatMoneyAmount', 'moneyFromJson', 'addMoney', 'subtractMoney', 'negateMoney', 'compareMoney',
    'applyExactRate', 'economicAttributionNumber', 'economicAttributionFromRows',
    'economicAttributionFromAttributions', 'canonicalEconomicAttribution', 'effectiveChargeFor',
    'effectiveChargesFor', 'effectiveFxChargeFor', 'effectiveFxChargeFromHistoricalRates',
    'effectiveRequestRows?', 'canonicalModelAttribution', 'translateEffectiveChargeFromRateBook',
    'selectHistoricalRate', 'buildEconomicRequestExportRows', 'buildEconomicReport',
  ].join('|') + ')\\s*\\(',
);

type Classification = 'a' | 'b' | 'c';

/**
 * Every file under `src/` (outside `src/team/**`) that holds at least one
 * monetary read site, and what routing it has. `why` is the evidence, not a
 * summary: it names the mechanism that makes the classification true.
 */
const CONSUMERS: ReadonlyArray<{ file: string; klass: Classification; why: string }> = [
  // --- (a) routed through the effective-FX read model --------------------
  {
    file: 'src/economics/fx.ts',
    klass: 'a',
    why: 'the read model itself: selects by effectiveAt + rateAsOf, retains raw lineage, rate identity and both boundaries',
  },
  {
    file: 'src/economics/ledger.ts',
    klass: 'a',
    why: 'effectiveFxChargeFromHistoricalRates bounds rate knowledge at the source recordedAt; project() groups by currency+basis+role and never sums across them',
  },
  {
    file: 'src/economics/rate.ts',
    klass: 'a',
    why: 'selectHistoricalRate filters by source/target unit, refuses overlapping candidates, and never uses an observation recorded after its asOf',
  },
  {
    file: 'src/store/economicReadModel.ts',
    klass: 'a',
    why: 'effectiveRequestRow takes targetUnit/effectiveAt/asOf and returns fxTranslation with the rate and both boundaries attached',
  },
  {
    file: 'src/export/economic.ts',
    klass: 'a',
    why: 'export rows carry sourceCurrency, effectiveCurrency, translatedCurrency, fxRate, fxRateSource, fxEffectiveAt and fxRateAsOf as columns',
  },
  {
    file: 'src/cli/economicCmd.ts',
    klass: 'a',
    why: '--target-currency/--as-of/--effective-at; translationCoverageFromRows refuses a row translated to an unexpected currency and reports unresolvedRequests',
  },
  {
    file: 'src/dashboard/routes.ts',
    klass: 'a',
    why: '/api/economic passes targetCurrency, asOf and effectiveAt into buildEconomicReport. GAP, not a defect: handleExportCsv accepts targetCurrency and asOf but not effectiveAt, so the CSV route cannot pin a modeled effective instant the read model supports',
  },

  // --- (b) not routed and consequential ---------------------------------
  {
    file: 'src/economics/attribution.ts',
    klass: 'b',
    why: 'economicAttributionNumber projected an exact amount into a costUsd-named field with no unit check, and the aggregate helpers were USD-anchored only through addMoney\'s incidental refusal. Both now state the unit conflict (D-200)',
  },
  {
    file: 'src/alloc/exact.ts',
    klass: 'b',
    why: 'buckets and lines are partitioned by currency+basis and never summed across, but sourceBases is a basis-only summary that a multi-currency run collapses to one entry. The figure is right; the summary of its basis is not (D-200)',
  },

  // --- (c) not routed, single-currency by construction --------------------
  {
    file: 'src/economics/money.ts',
    klass: 'c',
    why: 'addMoney/subtractMoney/compareMoney refuse two currencies outright; this is the boundary every other refusal rests on',
  },
  {
    file: 'src/economics/corrections.ts',
    klass: 'c',
    why: 'a price correction must use its predecessor currency and basis; it cannot change the unit',
  },
  {
    file: 'src/economics/events.ts',
    klass: 'c',
    why: 'event construction validates amounts and never combines two',
  },
  {
    file: 'src/economics/request.ts',
    klass: 'c',
    why: 'requestEconomicEvent refuses any currency but USD, which is what makes the whole request read model single-currency by construction',
  },
  {
    file: 'src/budget/guard.ts',
    klass: 'c',
    why: 'compareEnforced throws "budget enforcement compares USD only" and the exact projection refuses non-USD; enforcement fails closed rather than translating',
  },
  {
    file: 'src/billing/reconcile.ts',
    klass: 'c',
    why: 'refuses provider_reported_multiple_currencies and provider_currency_is_not_usd by name, and refuses a local exact amount that is not USD because this reconciliation has no FX policy',
  },
  {
    file: 'src/billing/epistemic.ts',
    klass: 'c',
    why: 'kernel issuance refuses a non-USD billing record and a non-USD Costs line explicitly',
  },
  {
    file: 'src/store/db.ts',
    klass: 'c',
    why: 'exactSpendFromRows and the exact request write path both throw on a non-USD amount before it can reach a projection',
  },
  {
    file: 'src/store/allocation.ts',
    klass: 'c',
    why: 'identityKey is currency+basis; declared totals are matched per identity, so a currency cannot be validated against another one',
  },
  {
    file: 'src/store/realization.ts',
    klass: 'c',
    why: 'consumes attribution objects only; its unit discipline is entirely inherited from src/economics/attribution.ts',
  },
  {
    file: 'src/cost/exactPricing.ts',
    klass: 'c',
    why: 'rate cards are USD-per-million by construction; sourceUnit and targetUnit are both USD',
  },
  {
    file: 'src/git/correlate.ts',
    klass: 'c',
    why: 'aggregates through economicAttributionFromRows, which is USD-anchored and now says so',
  },
  {
    file: 'src/value/cohort.ts',
    klass: 'c',
    why: 'aggregates through economicAttributionFromAttributions',
  },
  {
    file: 'src/value/epistemic.ts',
    klass: 'c',
    why: 'refuses issuance unless economic.amount.currency is USD, by name',
  },
  {
    file: 'src/value/frontier.ts',
    klass: 'c',
    why: 'aggregates through economicAttributionFromAttributions',
  },
  {
    file: 'src/value/realization.ts',
    klass: 'c',
    why: 'aggregates through economicAttributionFromAttributions and canonicalModelAttribution',
  },
  {
    file: 'src/value/receipt.ts',
    klass: 'c',
    why: 'assertAgreesWithUsdCompatibility refuses to reconcile a non-USD exact amount against a USD-named float',
  },
  {
    file: 'src/value/report.ts',
    klass: 'c',
    why: 'aggregates through economicAttributionFromRows',
  },
  {
    file: 'src/value/timeReclaimed.ts',
    klass: 'c',
    why: 'aggregates through economicAttributionFromAttributions',
  },
  {
    file: 'src/value/usage.ts',
    klass: 'c',
    why: 'aggregates through economicAttributionFromAttributions',
  },
];

/**
 * Consumers the call-site regex cannot see, classified by reading. Weaker
 * evidence than a match, and listed so that weakness is visible.
 */
const EXTRA_CONSUMERS: ReadonlyArray<{ file: string; klass: Classification; why: string }> = [
  {
    file: 'src/dashboard/web/app/views/value.ts',
    klass: 'c',
    why: 'renders total.amountText with no unit at all. The payload it reads is built by economicAttributionFromRows, which is USD-anchored, so the figure is USD; the SCREEN does not say so',
  },
  {
    file: 'src/alloc/epistemic.ts',
    klass: 'b',
    why: 'no call-site match because it reads result.sourceBases directly. It declared one monetaryBasis for a run spanning two currencies until D-200 made a mixed-currency run declare none',
  },
];

/**
 * OUT OF SCOPE AND DELIBERATELY UNDECIDED. Where a "the provider's own rate
 * outranks the local historical book" policy would have to be expressed. Listing
 * it is the whole of this packet's treatment of it.
 */
const PROVIDER_FX_AUTHORITY_SITES: ReadonlyArray<{ file: string; what: string }> = [
  { file: 'src/economics/rate.ts', what: 'selectHistoricalRate would need a precedence rule between a provider-supplied observation and a local one; rateSource is free text today and carries no authority' },
  { file: 'src/economics/fx.ts', what: 'translateEffectiveChargeFromRateBook and fxTranslationEventFromRateBook apply whatever the book selected, so a precedence rule would change what they apply' },
  { file: 'src/billing/reconcile.ts', what: 'refuses a non-USD provider snapshot with "no rate is applied here"; a provider-authoritative policy is exactly what that refusal is waiting for' },
  { file: 'src/store/billing.ts', what: 'records_are_not_single_currency_usd refuses a mixed-currency import rather than translating it' },
  { file: 'src/billing/openaiCosts.ts', what: 'parses the provider\'s own amount.currency; that value is the provider\'s declared unit and would be the authority claimant' },
];

/** Floors, not equalities: this must fail when the regex stops matching. */
const CORPUS_FILE_FLOOR = 29;
const CORPUS_SITE_FLOOR = 169;

function monetaryReadSites(): Map<string, number[]> {
  const found = new Map<string, number[]>();
  for (const file of sourceFiles()) {
    if (file.startsWith('src/team/')) continue;
    const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
    const hits: number[] = [];
    let inBlockComment = false;
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (inBlockComment) {
        if (trimmed.includes('*/')) inBlockComment = false;
        return;
      }
      if (trimmed.startsWith('/*')) {
        if (!trimmed.includes('*/')) inBlockComment = true;
        return;
      }
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;
      if (trimmed.startsWith('import ') || trimmed.startsWith('export {') || trimmed.startsWith('export type')) return;
      if (MONETARY_READ.test(line)) hits.push(index + 1);
    });
    if (hits.length > 0) found.set(file, hits);
  }
  return found;
}

test('SWEEP the monetary read sites, classify every file holding one, and state the corpus', () => {
  const sites = monetaryReadSites();
  const totalSites = [...sites.values()].reduce((sum, hits) => sum + hits.length, 0);

  const classified = new Set(CONSUMERS.map((entry) => entry.file));
  assert.equal(classified.size, CONSUMERS.length, 'the classification table lists a file twice');

  const unclassified = [...sites.keys()].filter((file) => !classified.has(file)).sort();
  assert.deepEqual(
    unclassified,
    [],
    'a file reads a monetary figure and is not classified (a)/(b)/(c). Read it, decide, and add it to CONSUMERS:\n'
      + unclassified.map((file) => `  ${file}:${sites.get(file)!.join(',')}`).join('\n'),
  );

  const stale = CONSUMERS.map((entry) => entry.file).filter((file) => !sites.has(file)).sort();
  assert.deepEqual(stale, [], `classified files that no longer hold a monetary read site: ${stale.join(', ')}`);

  for (const entry of [...CONSUMERS, ...EXTRA_CONSUMERS]) {
    assert.ok(['a', 'b', 'c'].includes(entry.klass), `${entry.file} has an invalid classification`);
    assert.ok(entry.why.trim().length > 40, `${entry.file} must state the mechanism, not a label`);
  }

  // A gate that does not declare its enumeration is another instance of the
  // defect it was built to prevent.
  assert.ok(
    sites.size >= CORPUS_FILE_FLOOR,
    `the monetary-read corpus shrank to ${sites.size} files (floor ${CORPUS_FILE_FLOOR}); the regex probably stopped matching`,
  );
  assert.ok(
    totalSites >= CORPUS_SITE_FLOOR,
    `the monetary-read corpus shrank to ${totalSites} sites (floor ${CORPUS_SITE_FLOOR}); the regex probably stopped matching`,
  );

  const counts = { a: 0, b: 0, c: 0 };
  for (const entry of CONSUMERS) counts[entry.klass] += 1;
  console.log(
    `      corpus: ${sites.size} files, ${totalSites} monetary read sites`
    + ` — ${counts.a} routed (a), ${counts.b} not-routed-and-consequential (b), ${counts.c} single-currency-by-construction (c);`
    + ` ${EXTRA_CONSUMERS.length} further consumers classified by reading, not by match;`
    + ` src/team/** excluded; provider FX authority enumerated at ${PROVIDER_FX_AUTHORITY_SITES.length} sites and NOT decided`,
  );
});

test('provider FX authority is enumerated and left undecided, not silently chosen', () => {
  const sites = monetaryReadSites();
  for (const entry of PROVIDER_FX_AUTHORITY_SITES) {
    assert.ok(entry.what.trim().length > 40, `${entry.file} must say what the policy would change`);
    const text = readFileSync(join(ROOT, entry.file), 'utf8');
    assert.ok(text.length > 0, `${entry.file} does not exist`);
    // Every site is either in the swept corpus or is a provider-import boundary
    // that the corpus regex does not reach; both are listed on purpose.
    assert.ok(
      sites.has(entry.file) || entry.file.startsWith('src/billing/') || entry.file.startsWith('src/store/'),
      `${entry.file} is neither a swept read site nor a provider-import boundary`,
    );
  }
  // Nothing in the tree may have quietly decided the policy by ranking rate
  // sources: `rateSource` is free text and no comparison of it exists.
  const rateSource = readFileSync(join(ROOT, 'src/economics/rate.ts'), 'utf8');
  assert.ok(
    !/rateSource\s*(===|!==|<|>)\s*['"]provider/i.test(rateSource),
    'src/economics/rate.ts appears to rank rate sources; provider FX authority is a product decision the owner has not made',
  );
});

// ---------------------------------------------------------------------------
// (b) The unit a field's NAME asserts is not a unit the figure carries
// ---------------------------------------------------------------------------

/** A complete, valid, non-USD attribution — built by the real canonicalizer. */
function eurAttribution(): EconomicAttribution {
  const amount = money('100.00', 'EUR', 'effective');
  return canonicalEconomicAttribution({
    amount: moneyToJson(amount),
    amountText: formatMoneyAmount(amount),
    eventIds: ['economic:request:fx-consumer:charge'],
    sourceBases: ['billed'],
    requestCount: 1,
    unresolvedRequests: 0,
    complete: true,
  });
}

test('a non-USD exact amount is not projected into a costUsd-named field', () => {
  const eur = eurAttribution();
  // The canonicalizer legitimately accepts it: an exact amount in another
  // currency is a real object. What must not happen is it becoming a number in
  // a field whose NAME asserts USD.
  assert.equal(eur.amount.currency, 'EUR');
  assert.equal(eur.complete, true);

  assert.throws(
    () => economicAttributionNumber(eur, 7),
    /EUR/,
    'economicAttributionNumber projected an exact EUR amount into a field named costUsd',
  );

  // The USD path is unchanged, including the incomplete-window fallback.
  const usd = economicAttributionView({
    amount: money('12.34', 'USD', 'effective'),
    eventIds: ['economic:request:usd:charge'],
    sourceBases: ['billed'],
    requestCount: 1,
    unresolvedRequests: 0,
  });
  assert.equal(economicAttributionNumber(usd, 99), 12.34);
  assert.equal(economicAttributionNumber(undefined, 99), 99);
});

test('a non-USD row states non-comparability instead of leaking a raw currency mismatch', () => {
  assert.throws(
    () => economicAttributionFromRows([{
      effectiveAmount: money('5.00', 'EUR', 'effective'),
      sourceEventIds: ['economic:request:eur:charge'],
      sourceBases: ['billed'],
      unresolvedReason: null,
    }]),
    /economic attribution is USD-anchored[\s\S]*EUR/,
    'the aggregate refused only through addMoney, naming neither the row nor the anchor',
  );

  assert.throws(
    () => economicAttributionFromAttributions([eurAttribution()]),
    /economic attribution is USD-anchored[\s\S]*EUR/,
  );

  // Both remain exact and total for USD input.
  const rows = economicAttributionFromRows([
    { effectiveAmount: money('1.10', 'USD', 'effective'), sourceEventIds: ['a'], sourceBases: ['billed'], unresolvedReason: null },
    { effectiveAmount: money('2.20', 'USD', 'effective'), sourceEventIds: ['b'], sourceBases: ['list'], unresolvedReason: null },
  ]);
  assert.equal(rows.amountText, '3.3');
  assert.equal(rows.complete, true);
});

// ---------------------------------------------------------------------------
// (b) A multi-currency run has no single monetary basis to declare
// ---------------------------------------------------------------------------

const PERIOD_START = Date.parse('2026-01-01T00:00:00.000Z');
const PERIOD_END = Date.parse('2026-02-01T00:00:00.000Z');
const OCCURRED = Date.parse('2026-01-05T00:00:00.000Z');

function directRule(): AllocationRule {
  return {
    ruleId: 'rule-direct',
    version: 1,
    method: 'direct',
    match: {},
    targets: [{ costCentreId: 'cc-engineering', ratio: 1 }],
    priority: 1,
    effectiveFromMs: 0,
    effectiveToMs: null,
    revokedAtMs: null,
    owner: null,
    note: null,
    createdAtMs: 0,
  };
}

function costCentre(): CostCentre {
  return { costCentreId: 'cc-engineering', name: 'Engineering', owner: null, archivedAtMs: null, createdAtMs: 0 };
}

function allocationRun(amounts: readonly { text: string; currency: string }[]): ExactAllocationRunResult {
  const result = applyExactAllocation({
    rows: amounts.map((item, index) => ({
      sourceEventIds: [`economic:request:alloc-${index}:charge`],
      amount: money(item.text, item.currency, 'effective'),
      project: 'project-fixture',
      provider: 'provider-fixture',
      model: 'model-fixture',
      source: null,
      user: null,
      tsEpochMs: OCCURRED,
    })),
    rules: [directRule()],
    costCentres: [costCentre()],
    periodStartMs: PERIOD_START,
    periodEndMs: PERIOD_END,
    runAtMs: OCCURRED,
  });
  return Object.freeze({ ...result, unresolvedRequestIds: Object.freeze([]), complete: true });
}

function issuanceFor(run: ExactAllocationRunResult) {
  const digest = serializeExactAllocationRun(run).digest;
  return buildExactAllocationKernelIssuance(`economic:allocation:${digest.slice('sha256:'.length)}`, run, OCCURRED);
}

test('an exact allocation spanning two currencies declares no single monetary basis', () => {
  const mixed = allocationRun([{ text: '10.00', currency: 'USD' }, { text: '90.00', currency: 'EUR' }]);

  // The figures themselves are already right: allocation partitions by
  // currency+basis identity and never sums across.
  assert.deepEqual(
    mixed.totalByIdentity.map((bucket) => `${bucket.currency}/${bucket.basis} ${formatMoneyAmount(bucket.amount)}`),
    ['EUR/effective 90', 'USD/effective 10'],
  );
  assert.equal(mixed.conserves, true);

  // What was wrong is the SUMMARY of their basis. `sourceBases` is basis-only,
  // so two currencies at one basis collapse to a single entry, and the kernel
  // Evidence then declared `monetaryBasis: 'effective'` for a claim spanning
  // USD and EUR. A monetary basis that omits the unit is not a basis.
  assert.deepEqual(mixed.sourceBases, ['effective']);
  assert.equal(
    issuanceFor(mixed).evidence.monetaryBasis,
    null,
    'the kernel Evidence declared one monetary basis for a run spanning two currencies',
  );

  // A single-currency run is unaffected: it still declares its basis.
  const single = allocationRun([{ text: '10.00', currency: 'USD' }, { text: '5.00', currency: 'USD' }]);
  assert.equal(issuanceFor(single).evidence.monetaryBasis, 'effective');
});

// ---------------------------------------------------------------------------
// (a) The routed surfaces, pinned so adoption cannot regress
// ---------------------------------------------------------------------------

const VALID_TIME = interval('2026-08-01T00:00:00.000Z', '2026-08-05T00:00:00.000Z');
const REQUEST_ID = 'fx-sweep-request';
const REQUEST_MS = Date.parse('2026-08-02T12:00:00.000Z');

function requestRow() {
  return {
    requestId: REQUEST_ID,
    sessionId: 'session:fx-sweep',
    tsEpochMs: REQUEST_MS,
    provider: 'provider-fixture',
    model: 'model-fixture',
    project: 'project-fixture',
    projectCanonical: 'project-fixture',
    taskWeight: 1,
    inputTokens: 10,
    outputTokens: 5,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    costUsd: 10,
    economicAmount: money('10', 'USD', 'list'),
    estimated: true,
    streamed: false,
    statusCode: 200,
    durationMs: 10,
    via: 'proxy' as const,
    user: null,
    source: null,
  };
}

function seededLedger(): { ledger: EconomicLedger; close: () => void } {
  const db = new DatabaseSync(':memory:');
  const ledger = new EconomicLedger(db);
  ledger.append(requestEconomicEvent({
    requestId: REQUEST_ID,
    sessionId: 'session:fx-sweep',
    tsEpochMs: REQUEST_MS,
    provider: 'provider-fixture',
    model: 'model-fixture',
    project: 'project-fixture',
    amount: money('10', 'USD', 'list'),
    via: 'proxy',
    recordedAt: '2026-08-02T12:00:00.000Z',
  }));
  ledger.appendHistoricalRateObservation({
    id: 'fx-rate:sweep',
    rate: exactRate({ numerator: 9n, denominator: 10n, sourceUnit: 'USD', targetUnit: 'EUR', validTime: VALID_TIME }),
    rateSource: 'fixture:sweep',
    recordedAt: '2026-08-01T12:00:00.000Z',
    supersedes: null,
  });
  return { ledger, close: () => db.close() };
}

test('the routed surfaces carry currency, rate identity and both time boundaries out with the figure', () => {
  const { ledger, close } = seededLedger();
  try {
    const row = effectiveRequestRow(requestRow(), ledger, { targetUnit: 'EUR' });
    assert.equal(row.effectiveAmount?.currency, 'USD');
    assert.equal(row.fxTranslation?.translatedAmount.currency, 'EUR');
    assert.equal(formatMoneyAmount(row.fxTranslation!.translatedAmount), '9');
    assert.equal(row.fxTranslation?.rateSource, 'fixture:sweep');
    assert.equal(row.fxTranslation?.rateAsOf, '2026-08-02T12:00:00.000Z');

    // Absent by default: no target currency means no translation is invented.
    assert.equal(effectiveRequestRow(requestRow(), ledger, {}).fxTranslation, null);

    const [exported] = buildEconomicRequestExportRows([requestRow()], ledger, { targetUnit: 'EUR' });
    assert.equal(exported?.sourceCurrency, 'USD');
    assert.equal(exported?.translatedCurrency, 'EUR');
    assert.equal(exported?.translatedAmount, '9');
    assert.equal(exported?.fxRateSource, 'fixture:sweep');
    assert.equal(exported?.fxEffectiveAt, '2026-08-02T12:00:00.000Z');
    assert.equal(exported?.fxRate?.targetUnit, 'EUR');

    // The source event id leads the retained lineage, so the raw charge is never
    // replaced by its translation.
    assert.equal(row.fxTranslation?.eventIds[0], requestEconomicEventId(REQUEST_ID));
    assert.equal(formatMoneyAmount(row.fxTranslation!.sourceAmount), '10');
  } finally {
    close();
  }
});
