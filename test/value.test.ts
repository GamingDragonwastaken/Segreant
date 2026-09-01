import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store/db.ts';
import {
  GATE_LADDER,
  scoreFunnel,
  terminalRealizationBounds,
  serialRealization,
  type Gate,
  type GateResult,
  type Verdict,
} from '../src/value/gates.ts';
import { extractProposals, extractProposalsWithCoverage, acceptanceRatio, acceptanceForCommit } from '../src/value/proposals.ts';
import { canonical, loadOrCreateKeyPair, buildReceiptBody, signReceipt, verifyReceipt } from '../src/value/receipt.ts';
import { computeRealization } from '../src/value/realization.ts';
import { computeReturnOnIntelligence, lensRedundancy, type RealizationLike } from '../src/value/lenses.ts';
import { timeWithAiMinutes, boundedLift, breakEven, liftFromData, DECLARED_LIFT_FLOOR_FRACTION } from '../src/value/lift.ts';
import { classifyTaskType, type TaskType } from '../src/value/taskType.ts';
import { computeFrontier, type FrontierCell } from '../src/value/frontier.ts';
import { recommendBudget } from '../src/budget/recommend.ts';
import { computeUsageRoI, DECLARED_REACH_UTILITY } from '../src/value/usage.ts';
import type { WorkUnit } from '../src/value/realization.ts';
import { projectName, resolveCommit } from '../src/git/correlate.ts';
import { completenessWitness } from '../src/measurement/completeness.ts';
import { scope } from '../src/epistemic/scope.ts';
import { interval } from '../src/epistemic/time.ts';

function vr(map: Partial<Record<Gate, Verdict>>): Record<Gate, GateResult> {
  const out = {} as Record<Gate, GateResult>;
  for (const g of GATE_LADDER) out[g] = { gate: g, verdict: map[g] ?? 'unknown', detail: '' };
  return out;
}

test('funnel: all gates pass → realized, score 1', () => {
  const f = scoreFunnel(
    vr({ proposed: 'pass', accepted: 'pass', committed: 'pass', tested: 'pass', merged: 'pass', shipped: 'pass', survived: 'pass', clean: 'pass' }),
  );
  assert.equal(f.realized, true);
  assert.equal(f.diedAt, null);
  assert.equal(f.instrumented, 8);
  assert.equal(f.realizationScore, 1);
  assert.equal(f.reached, 'clean');
});

test('funnel: a failed gate sets diedAt and blocks realization; a post-fail pass does NOT inflate the score', () => {
  // `committed` passes AFTER `accepted` failed — a real case (heavily-rewritten AI
  // code still lands in git). The score is MONOTONE: the unit died at `accepted`,
  // so the later `committed` pass is moot. Credit = passes before death (proposed)
  // ÷ (those passes + the failing gate) = 1/2, not 2/3.
  const f = scoreFunnel(vr({ proposed: 'pass', accepted: 'fail', committed: 'pass' }));
  assert.equal(f.diedAt, 'accepted');
  assert.equal(f.reached, 'proposed'); // deepest pass before the failure
  assert.equal(f.realized, false);
  assert.equal(f.passes, 2);
  assert.equal(f.fails, 1);
  assert.equal(f.instrumented, 3);
  assert.ok(Math.abs(f.realizationScore - 1 / 2) < 1e-9, `monotone score ${f.realizationScore} should be 0.5`);
});

test('funnel: maturing (survived/clean unknown) is never realized', () => {
  const f = scoreFunnel(vr({ proposed: 'pass', accepted: 'pass', committed: 'pass', survived: 'unknown', clean: 'unknown' }));
  assert.equal(f.diedAt, null);
  assert.equal(f.realized, false); // no fail, but durability not confirmed
});

test('terminal bounds: a perfect-progress-score unit with unknown durability sits strictly inside [0,1], never read as realized', () => {
  // The audit case: (P,P,P,P,U,U,U,U) — progress score 100%, realization unknown.
  const f = scoreFunnel(vr({ proposed: 'pass', accepted: 'pass', committed: 'pass', tested: 'pass' }));
  assert.equal(f.realizationScore, 1, 'progress score is honestly 4/4 of the observed gates');
  const b = terminalRealizationBounds([f]);
  assert.equal(b.lower, 0, 'not confirmed realized — the lower bound must not credit it');
  assert.equal(b.upper, 1, 'not observed dead — the upper bound must not bury it');
});

test('terminal bounds: confirmed realized lifts the lower bound; an observed death lowers the upper', () => {
  const realized = scoreFunnel(vr({ proposed: 'pass', accepted: 'pass', committed: 'pass', tested: 'pass', merged: 'pass', shipped: 'pass', survived: 'pass', clean: 'pass' }));
  const dead = scoreFunnel(vr({ proposed: 'pass', accepted: 'fail' }));
  const indeterminate = scoreFunnel(vr({ proposed: 'pass', accepted: 'pass', committed: 'pass' }));
  const b = terminalRealizationBounds([realized, dead, indeterminate]);
  assert.equal(b.n, 3);
  assert.ok(Math.abs(b.lower - 1 / 3) < 1e-9, 'exactly one of three confirmed realized');
  assert.ok(Math.abs(b.upper - 2 / 3) < 1e-9, 'exactly one of three observed dead');
  assert.ok(b.lower <= b.upper, 'a bounds pair must always be an interval');
});

test('serial realization: S_G is the product of per-gate conditional pass rates, and dead units leave later gates\' alive pool', () => {
  // Three units: one full pass, one dies at accepted, one passes proposed+accepted then unknown.
  const a = scoreFunnel(vr({ proposed: 'pass', accepted: 'pass', committed: 'pass', tested: 'pass', merged: 'pass', shipped: 'pass', survived: 'pass', clean: 'pass' }));
  const b = scoreFunnel(vr({ proposed: 'pass', accepted: 'fail' }));
  const c = scoreFunnel(vr({ proposed: 'pass', accepted: 'pass' }));
  const s = serialRealization([a, b, c]);
  const byGate = new Map(s.gates.map((g) => [g.gate, g]));
  assert.equal(byGate.get('proposed')!.q, 1, 'all three alive and passing at proposed');
  assert.ok(Math.abs((byGate.get('accepted')!.q ?? 0) - 2 / 3) < 1e-9, '2 of 3 alive pass accepted');
  assert.equal(byGate.get('committed')!.alive, 2, 'the accepted-fail unit is out of every later pool');
  assert.equal(byGate.get('committed')!.q, 1, 'of the alive, only the full-pass unit is observed at committed — 1/1');
  // Product over instrumented gates only; every skipped gate is disclosed by name.
  const expected = 1 * (2 / 3) * 1 * 1 * 1 * 1 * 1 * 1;
  assert.ok(Math.abs((s.sG ?? 0) - expected) < 1e-9, `sG ${s.sG} should be ${expected}`);
  assert.equal(s.skipped.length, 0, 'no gate lacked observations among alive units here');
});

test('serial realization: an uninstrumented gate is skipped AND disclosed, never silently assumed passed', () => {
  // Nobody has any verdict at `tested`+ — the chain estimate must say which links are missing.
  const a = scoreFunnel(vr({ proposed: 'pass', accepted: 'pass', committed: 'pass' }));
  const b = scoreFunnel(vr({ proposed: 'pass', accepted: 'pass', committed: 'pass' }));
  const s = serialRealization([a, b]);
  assert.equal(s.sG, 1, 'product over the three observed gates only');
  assert.deepEqual(s.included, ['proposed', 'accepted', 'committed']);
  assert.deepEqual(s.skipped, ['tested', 'merged', 'shipped', 'survived', 'clean']);
});

test('serial realization + bounds: empty input yields nulls/zeros, never NaN or an invented rate', () => {
  const s = serialRealization([]);
  assert.equal(s.sG, null);
  assert.equal(s.included.length, 0);
  const b = terminalRealizationBounds([]);
  assert.equal(b.n, 0);
  assert.equal(b.lower, 0);
  assert.equal(b.upper, 0);
});

test('acceptanceRatio: fraction of proposed lines that shipped, whitespace-insensitive', () => {
  assert.equal(acceptanceRatio(['a', 'b', 'c', 'd'], ['a', 'b']), 0.5);
  assert.equal(acceptanceRatio(['  a  ', 'b'], ['a', 'b']), 1);
  assert.equal(acceptanceRatio([], ['a']), 0);
});

test('extractProposals: Anthropic tool_use, OpenAI tool_calls, fenced fallback', () => {
  const anthropic = extractProposals('anthropic', {
    content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'x.ts', content: 'l1\nl2' } }],
  });
  assert.deepEqual(anthropic, [{ path: 'x.ts', addedLines: ['l1', 'l2'] }]);

  const openai = extractProposals('openai', {
    choices: [{ message: { tool_calls: [{ function: { name: 'write_file', arguments: '{"path":"y.ts","content":"a\\nb"}' } }] } }],
  });
  assert.deepEqual(openai, [{ path: 'y.ts', addedLines: ['a', 'b'] }]);

  const fenced = extractProposals('anthropic', { content: [{ type: 'text', text: '```ts\ncode1\ncode2\n```' }] });
  assert.equal(fenced.length, 1);
  assert.equal(fenced[0]!.path, null);
  assert.ok(fenced[0]!.addedLines.includes('code1'));
});

test('extractProposals: hostile tool arguments and fenced floods truncate before line-array expansion', () => {
  const oversizedArgument = JSON.stringify({
    path: 'x.ts',
    content: `x\n${'a'.repeat(2 * 1024 * 1024)}`,
  });
  const argumentResult = extractProposalsWithCoverage('openai', {
    choices: [{ message: { tool_calls: [{ function: { name: 'write_file', arguments: oversizedArgument } }] } }],
  });
  assert.equal(argumentResult.captureCoverage, 'truncated');
  assert.deepEqual(argumentResult.files, []);

  const fencedFlood = '```ts\n' + 'x\n'.repeat(200_005) + '```';
  const fencedResult = extractProposalsWithCoverage('anthropic', {
    content: [{ type: 'text', text: fencedFlood }],
  });
  assert.equal(fencedResult.captureCoverage, 'truncated');
  assert.deepEqual(fencedResult.files, []);
});

test('receipt canonicalization rejects cycles and oversized values before signing', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => canonical(cyclic), /cycle/);
  assert.throws(() => canonical({ payload: 'x'.repeat(2 * 1024 * 1024 + 1) }), /string size/);
});

test('acceptanceForCommit returns null when nothing was proposed (→ gate unknown)', () => {
  const committed = new Map<string, string[]>([['a.ts', ['x', 'y']]]);
  assert.equal(acceptanceForCommit([], committed), null);
  assert.equal(acceptanceForCommit([{ path: 'a.ts', addedLines: ['x'] }], committed), 1);
});

test('receipt: sign then verify is valid; tampering invalidates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-rk-'));
  try {
    const keys = loadOrCreateKeyPair(join(dir, 'key.json'));
    const funnel = scoreFunnel(vr({ proposed: 'pass', accepted: 'pass', committed: 'pass', survived: 'pass', clean: 'pass' }));
    const body = buildReceiptBody('deadbeef', 'proj', 1.23, 0.9, funnel);
    const receipt = signReceipt(body, keys);
    assert.equal(verifyReceipt(receipt).valid, true);

    const tampered = { ...receipt, body: { ...receipt.body, costUsd: 9.99 } };
    assert.equal(verifyReceipt(tampered).valid, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('receipt: key pinning rejects a forgery signed by an untrusted key (authenticity, not just integrity)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-pin-'));
  try {
    const honest = loadOrCreateKeyPair(join(dir, 'honest.json'));
    const attacker = loadOrCreateKeyPair(join(dir, 'attacker.json'));
    const funnel = scoreFunnel(vr({ proposed: 'pass', accepted: 'pass', committed: 'pass', survived: 'pass', clean: 'pass' }));
    const body = buildReceiptBody('cafef00d', 'proj', 2, 0.8, funnel);

    // A forged "VERIFIED VALUE" receipt: internally consistent, signed by the attacker's own key.
    const forged = signReceipt(body, attacker);
    assert.equal(verifyReceipt(forged).valid, true, 'integrity-only verify cannot catch a self-consistent forgery');
    assert.equal(verifyReceipt(forged).pinned, false);

    // Pinning to the honest publisher's keyId rejects it.
    const checked = verifyReceipt(forged, { trustedKeyId: honest.keyId });
    assert.equal(checked.valid, false);
    assert.match(checked.reason, /untrusted key/);

    // The genuine receipt is BOTH intact and authentic under the same pin.
    const genuine = verifyReceipt(signReceipt(body, honest), { trustedKeyId: honest.keyId });
    assert.equal(genuine.valid, true);
    assert.equal(genuine.pinned, true);

    // Pinning by full PEM works too.
    assert.equal(verifyReceipt(signReceipt(body, honest), { trustedPublicKeyPem: honest.publicPem }).pinned, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('receipt: claiming a trusted keyId while signing with another key is detected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-lie-'));
  try {
    const attacker = loadOrCreateKeyPair(join(dir, 'a.json'));
    const funnel = scoreFunnel(vr({ proposed: 'pass', accepted: 'pass', committed: 'pass', survived: 'pass', clean: 'pass' }));
    const r = signReceipt(buildReceiptBody('beefcafe', 'p', 1, 0.5, funnel), attacker);
    // Attacker keeps their own key + signature but stamps a victim's fingerprint in the keyId field.
    const lied = { ...r, keyId: 'deadbeefdeadbeef' };
    const res = verifyReceipt(lied);
    assert.equal(res.valid, false);
    assert.match(res.reason, /keyId does not match/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Return on Intelligence: lenses + composite ----

function ru(opts: { realized: boolean; acceptance: number | null; shipped?: boolean }): RealizationLike['units'][number] {
  return {
    maturing: false,
    acceptance: opts.acceptance,
    funnel: { realized: opts.realized, results: [{ gate: 'shipped', verdict: opts.shipped ? 'pass' : 'unknown' }] },
  };
}

test('RoI: geometric mean collapses to 0 if any lens is 0 (no axis can carry the score)', () => {
  const report: RealizationLike = {
    firstPassAcceptance: 0, // kept nothing first-try
    units: [ru({ realized: true, acceptance: 0 })],
    matured: { realizationRate: 0.8, totalCostUsd: 10, spendOnRealizedUnitsUsd: 8 },
  };
  const r = computeReturnOnIntelligence(report);
  assert.equal(r.roiIndex, 0, 'one collapsed lens collapses the index');
  assert.equal(r.lenses.lift.instrumented, false, 'lift uninstrumented by default');
  assert.ok(Math.abs(r.coverage - 2 / 4) < 1e-9, 'Lift and orthogonal Impact are both uninstrumented');
  assert.ok(r.notes.some((n) => n.includes('collapsed')));
});

test('RoI: injected lift widens coverage; index is the geometric mean of instrumented lenses', () => {
  const report: RealizationLike = {
    firstPassAcceptance: 0.9,
    units: [ru({ realized: true, acceptance: 0.9, shipped: true })],
    matured: { realizationRate: 0.8, totalCostUsd: 10, spendOnRealizedUnitsUsd: 8 },
  };
  const r = computeReturnOnIntelligence(report, { lift: 0.5, impact: 0.8, impactHow: 'external outcome signal' });
  assert.equal(r.coverage, 1, 'all four lenses instrumented only when Impact is supplied independently');
  assert.ok(r.roiIndex !== null && r.roiIndex > 0 && r.roiIndex < 100);
});

test('RoI composite interval: statistical width (realization CS) enters even without a Lift range, sources disclosed', () => {
  const report: RealizationLike = {
    firstPassAcceptance: 0.9,
    units: [ru({ realized: true, acceptance: 0.9, shipped: true }), ru({ realized: false, acceptance: 0.9 })],
    matured: { realizationRate: 0.5, totalCostUsd: 10, spendOnRealizedUnitsUsd: 5 },
  };
  const r = computeReturnOnIntelligence(report, { lift: 0.5 });
  const ci = r.compositeInterval;
  assert.ok(ci !== null, 'matured units exist, so a composite interval must exist');
  assert.ok(ci!.low !== null && ci!.point !== null && ci!.high !== null);
  assert.ok(ci!.low! <= ci!.point! && ci!.point! <= ci!.high!, 'monotone substitution must bracket the point');
  assert.ok(ci!.high! - ci!.low! > 0, 'two matured units carry real statistical width — the interval must show it');
  assert.ok(ci!.sources.some((s) => /confidence sequence/.test(s)), 'the CS source must be named');
  // roiInterval keeps its documented identification-only meaning: no Lift range → degenerate.
  assert.equal(r.roiInterval.low, r.roiInterval.high);
});

test('RoI composite interval: identification (Lift range) and statistical (CS) widths fold together, wider than either alone', () => {
  const report: RealizationLike = {
    firstPassAcceptance: 0.9,
    units: [ru({ realized: true, acceptance: 0.9, shipped: true }), ru({ realized: false, acceptance: 0.9 })],
    matured: { realizationRate: 0.5, totalCostUsd: 10, spendOnRealizedUnitsUsd: 5 },
  };
  const r = computeReturnOnIntelligence(report, { lift: 0.5, liftRange: { low: 0.4, high: 0.7 } });
  const ci = r.compositeInterval!;
  assert.equal(ci.sources.length, 2, 'both uncertainty sources named');
  const idOnly = r.roiInterval; // identification-only interval
  assert.ok(ci.low! <= idOnly.low! && ci.high! >= idOnly.high!, 'the combined interval must contain the identification-only one');
});

test('lensRedundancy: independent lenses ≈ m effective dimensions; perfectly co-moving lenses ≈ 1', () => {
  const e = Math.exp(1);
  // Log-values (1,1),(1,2),(2,1),(2,2): zero correlation between columns.
  const independent = lensRedundancy([
    [e, e],
    [e, e * e],
    [e * e, e],
    [e * e, e * e],
  ]);
  assert.ok(independent.dEff !== null && Math.abs(independent.dEff - 2) < 1e-9, `orthogonal columns → d_eff 2, got ${independent.dEff}`);
  // Column 2 = column 1 squared → logs perfectly correlated.
  const collinear = lensRedundancy([
    [2, 4],
    [3, 9],
    [5, 25],
    [7, 49],
  ]);
  assert.ok(collinear.dEff !== null && Math.abs(collinear.dEff - 1) < 1e-9, `perfectly co-moving columns → d_eff 1, got ${collinear.dEff}`);
});

test('lensRedundancy: too few contexts, missing values, or constant lenses → null with the reason, never an invented statistic', () => {
  assert.equal(lensRedundancy([[0.5, 0.6], [0.7, 0.8]]).dEff, null, 'two rows cannot support a correlation');
  const withNulls = lensRedundancy([[0.5, null], [0.7, 0.8], [0.9, 0.6], [0.4, 0.5]]);
  assert.equal(withNulls.contexts, 3, 'incomplete rows are dropped, complete-case only');
  const constantCol = lensRedundancy([[0.5, 0.5], [0.7, 0.5], [0.9, 0.5], [0.4, 0.5]]);
  assert.equal(constantCol.dEff, null, 'a constant lens carries no correlation information');
  assert.match(constantCol.how, /constant/i);
});

test('RoI: effort tax raises the denominator, lowering realized efficiency', () => {
  const report: RealizationLike = {
    firstPassAcceptance: 0.5,
    units: [ru({ realized: true, acceptance: 0.5 })],
    matured: { realizationRate: 1, totalCostUsd: 10, spendOnRealizedUnitsUsd: 10 },
  };
  const tokenOnly = computeReturnOnIntelligence(report);
  const withLabor = computeReturnOnIntelligence(report, { laborRatePerHour: 120, minutesPerUnitRework: 10 });
  assert.equal(tokenOnly.realizedEfficiency, 1);
  assert.equal(withLabor.effortTaxUsd, 10); // (1-0.5)*10min*($120/60) = $10
  assert.ok(withLabor.realizedEfficiency !== null && withLabor.realizedEfficiency < 1);
});

test('RoI: Impact is independently supplied and can diverge from raw realization without double-counting gates', () => {
  const report: RealizationLike = {
    firstPassAcceptance: null,
    units: [ru({ realized: true, acceptance: null, shipped: true }), ru({ realized: false, acceptance: null })],
    matured: { realizationRate: 0.5, totalCostUsd: 5, spendOnRealizedUnitsUsd: 3 },
  };
  const absent = computeReturnOnIntelligence(report);
  assert.equal(absent.lenses.impact.value, null);
  const measured = computeReturnOnIntelligence(report, { impact: 0.9, impactHow: 'business outcome adapter' });
  assert.equal(measured.lenses.impact.value, 0.9);
  assert.equal(measured.lenses.realization.value, 0.5);
});

// ---- Lift: METR windowing + bounded estimate ----

test('Lift: 10-min concurrency windowing charges 10/n minutes per concurrent session', () => {
  // window0 (0–10min): sessions A and B both active → 5 min each.
  // window1 (10–20min): only A active → 10 min.
  const events = [
    { sessionId: 'A', tsEpochMs: 0 },
    { sessionId: 'B', tsEpochMs: 60_000 },
    { sessionId: 'A', tsEpochMs: 600_000 },
  ];
  const { perSessionMin, totalMin } = timeWithAiMinutes(events, 10);
  assert.equal(perSessionMin.get('A'), 15); // 5 + 10
  assert.equal(perSessionMin.get('B'), 5);
  assert.equal(totalMin, 20);
});

test('Lift: TSF is discounted to a bounded value estimate; no baseline → uninstrumented', () => {
  const est = boundedLift({ tsfUpperBound: 5 });
  assert.ok(est.point !== null && Math.abs(est.point - 1.3) < 1e-9); // 5×0.5×0.65×0.8
  assert.equal(est.high, 5); // ceiling = TSF (new-task uplift)
  assert.ok(est.lensScore !== null && est.lensScore > 0.5 && est.lensScore < 0.6);

  const none = boundedLift({ tsfUpperBound: null });
  assert.equal(none.lensScore, null);
  assert.ok(none.notes.some((n) => n.includes('uninstrumented')));
});

test('Lift: a declared fallback floor is never presented as an identified bound', () => {
  // AII-010. Both calls return a band, and the bands look alike. Only one of
  // them is a partially identified set: without an observed old-task lift the
  // floor is a chosen fraction of the point estimate, which rules nothing out —
  // the true counterfactual may be zero or negative. The two cases must be
  // distinguishable by a consumer, not merely by whoever reads the source.
  const fallback = boundedLift({ tsfUpperBound: 5 });
  assert.equal(fallback.lowBasis, 'declared_fallback_fraction');
  assert.equal(fallback.highBasis, 'tsf_upper_bound');
  assert.ok(Math.abs(fallback.low! - fallback.point! * DECLARED_LIFT_FLOOR_FRACTION) < 1e-9);
  assert.ok(
    fallback.notes.some((n) => /DECLARED floor/.test(n) && /not an identified set/.test(n)),
    'the fallback band must say it is a scenario band',
  );
  assert.ok(!fallback.notes.some((n) => /partially identified set/.test(n) && !/not an identified set/.test(n)));

  const observed = boundedLift({ tsfUpperBound: 5, oldTaskLift: 0.9 });
  assert.equal(observed.lowBasis, 'observed_old_task_lift');
  assert.equal(observed.low, 0.9);
  assert.ok(
    observed.notes.some((n) => /OBSERVED old-task lift/.test(n) && /partially identified set/.test(n)),
    'an observed floor may be described as identification under the stated design',
  );
});

test('Lift: baseline-interval propagation — a band straddling break-even reaches the lens as real width, never a false point', () => {
  // The audit's sign-flip case: 100 measured AI minutes; the baseline band runs
  // from 84 manual min (AI net-SLOWED you, TSF 0.84 — METR's experienced-dev
  // result) to 120 manual min (net save, TSF 1.20). A point baseline hides that
  // the SIGN of the effect is undetermined; the band must carry it.
  const unit = { taskType: 'feature', realized: true, acceptance: null };
  // One realized unit; events spaced to measure ~100 minutes of AI time
  // (10-min windowing: 10 windows × 1 session = 100 min).
  const events = Array.from({ length: 10 }, (_, i) => ({ sessionId: 's1', tsEpochMs: i * 10 * 60_000 + 1 }));
  const banded = liftFromData({
    units: [unit],
    events,
    baselineMinutes: { feature: 100 },
    baselineMinutesLow: { feature: 84 },
    baselineMinutesHigh: { feature: 120 },
  });
  assert.ok(banded.tsfRange !== null, 'a non-degenerate baseline band must surface a TSF range');
  assert.ok(banded.tsfRange!.low < 1 && banded.tsfRange!.high > 1, 'the range must straddle break-even — that is the whole point');
  const point = liftFromData({ units: [unit], events, baselineMinutes: { feature: 100 } });
  assert.equal(point.tsfRange, null, 'no band supplied → exactly the old behavior, no invented width');
  assert.ok(
    banded.liftRange.low! < point.liftRange.low! && banded.liftRange.high! > point.liftRange.high!,
    'baseline width must WIDEN the lens interval beyond the discount-only interval',
  );
  assert.ok(banded.notes.some((n) => /baseline uncertainty/i.test(n)), 'the propagation must announce itself');
});

test('Lift: break-even flags when token+effort cost exceeds the value of time saved', () => {
  assert.equal(breakEven(2, 100, 50).passes, true); // $200 value vs $50 cost
  const fail = breakEven(2, 100, 300); // $200 value vs $300 cost
  assert.equal(fail.passes, false);
  assert.ok(Math.abs(fail.ratio - 2 / 3) < 1e-9);
});

// ---- Per-context frontier ----

test('classifyTaskType: conventional prefixes and keyword fallback', () => {
  assert.equal(classifyTaskType('feat: add rate limiter'), 'feature');
  assert.equal(classifyTaskType('fix(parser): handle npe'), 'fix');
  assert.equal(classifyTaskType('refactor the store layer'), 'refactor');
  assert.equal(classifyTaskType('update the docs and readme'), 'docs');
  assert.equal(classifyTaskType('wibble wobble'), 'other');
});

let wuSeq = 0;

/**
 * A mature work unit. `share` is the dominant model's portion of the window spend:
 * it defaults to a model-pure window (1) so the common case reads cleanly, and is
 * lowered or nulled by the tests that exercise the mixed/unknown exclusions.
 * `modelCost` defaults to the window total, which is only correct when share is 1.
 */
function wu(
  taskType: TaskType,
  model: string,
  realized: boolean,
  cost: number,
  share: number | null = 1,
  modelCost: number | null = cost,
  costStale = false,
): WorkUnit {
  // Deterministic ids: a random hash makes a failure impossible to reproduce.
  wuSeq += 1;
  return {
    // Each default unit lands on its own day, SCATTERED rather than sequential:
    // distinct days keep the cohort from reading as one clustered session, and
    // scattering keeps cohorts built in blocks from occupying disjoint periods —
    // both of which are separate confounders with their own tests. 7919 and 997
    // are coprime, so seq → day is injective and reproducible.
    hash: `wu${wuSeq}`, tsEpochMs: ((wuSeq * 7919) % 997) * 24 * 60 * 60 * 1000, subject: '', linesAdded: 10, linesDeleted: 0, filesChanged: 1,
    windowStartMs: 0, windowEndMs: 0, attributedCostUsd: cost, attributedRequests: 1, attributedOutputTokens: 0, costPerHundredLines: null,
    ageDays: 30, maturing: false, survivalRatio: 1, reverted: false, hadProposal: false, acceptance: null,
    taskType, dominantModel: model, dominantModelCostUsd: modelCost, dominantModelCostShare: share, costStale,
    // A comparably-priced baseline: one basis, one rate card on both sides. Tests
    // for the pricing-comparability gate override these.
    dominantModelCostBasis: 'local_list_price', dominantModelRateCard: 'card-a',
    funnel: { realized, results: [{ gate: 'shipped', verdict: 'unknown', detail: '' }], reachedIndex: 0, reached: null, diedAt: null, diedAtIndex: null, passes: 0, fails: 0, unknowns: 0, instrumented: 0, realizationScore: 0 },
  } as WorkUnit;
}

test('frontier: recommends routing a task-type to the model that returns more per dollar', () => {
  const units: WorkUnit[] = [
    // Opus on features: pricier, and one churned → lower realization
    wu('feature', 'claude-opus-4-8', true, 4), wu('feature', 'claude-opus-4-8', true, 4), wu('feature', 'claude-opus-4-8', false, 4),
    // Haiku on features: cheaper, all realized → higher RoI
    wu('feature', 'claude-haiku-4-5', true, 1), wu('feature', 'claude-haiku-4-5', true, 1), wu('feature', 'claude-haiku-4-5', true, 1),
  ];
  const fr = computeFrontier(units);
  assert.equal(fr.byModel.length, 2);
  // Haiku should lead RoI for features and be the routing recommendation.
  const feature = fr.byModelAndTask.filter((c) => c.taskType === 'feature').sort((a, b) => (b.roiIndex ?? 0) - (a.roiIndex ?? 0));
  assert.equal(feature[0]!.model, 'claude-haiku-4-5');
  assert.ok(fr.recommendations.some((r) => r.includes('feature') && r.includes('haiku')), fr.recommendations.join(' | '));
  const trial = fr.modelSwitches.find((r) => r.taskType === 'feature');
  assert.ok(trial, 'a lower-cost same-outcome model becomes a review-only trial');
  assert.equal(trial!.candidateModel, 'claude-haiku-4-5');
  assert.equal(trial!.incumbentModel, 'claude-opus-4-8');
  assert.ok(trial!.historicalEquivalentHeadroomUsd > 0, 'quantifies historical-equivalent headroom');
  assert.equal(trial!.confidence, 'trial', 'three units per model are not overstated as a proven switch');
  assert.equal(trial!.costBasis, 'dominant_model_attributed', 'the per-unit cost is the model\'s own spend');
  assert.equal(trial!.unitsExcludedMixedAttribution, 0);
  assert.equal(trial!.unitsExcludedUnknownAttribution, 0);
});

test('frontier: same model names from different providers remain separate comparison identities', () => {
  const anthropic = Array.from({ length: 3 }, () => ({ ...wu('feature', 'same-model', true, 4), dominantProvider: 'anthropic' }));
  const openai = Array.from({ length: 3 }, () => ({ ...wu('feature', 'same-model', true, 1), dominantProvider: 'openai' }));
  const report = computeFrontier([...anthropic, ...openai]);
  assert.equal(report.byModel.length, 2);
  assert.equal(report.byModelAndTask.filter((cell) => cell.model === 'same-model').length, 2);
  assert.equal(report.modelSwitches.length, 1, 'provider/model pairs, not display-name collisions, are compared');
  const trial = report.modelSwitches[0]!;
  assert.equal(trial.candidateProvider, 'openai');
  assert.equal(trial.incumbentProvider, 'anthropic');
});

// ---- Cheaper-model trial: the refusals ----
// The advisor's whole premise is restraint, so each gate needs a test that it
// actually WITHHOLDS. A happy-path test alone cannot distinguish a working gate
// from an absent one.

test('model switch: prices each model by its OWN spend, never the mixed window total', () => {
  // Both models run in every window. Opus dominates spend (share 0.8) but the
  // window total is identical for both, so a window-total basis would report a
  // $0 gap. On the correct per-model basis Opus costs 8x Haiku per unit.
  const units: WorkUnit[] = [
    ...Array.from({ length: 3 }, () => wu('feature', 'claude-opus-4-8', true, 10, 0.8, 8)),
    ...Array.from({ length: 3 }, () => wu('feature', 'claude-haiku-4-5', true, 10, 0.8, 1)),
  ];
  const trial = computeFrontier(units).modelSwitches.find((r) => r.taskType === 'feature');
  assert.ok(trial, 'a real per-model price gap is still found when window totals are equal');
  assert.equal(trial!.incumbentModel, 'claude-opus-4-8');
  assert.equal(trial!.candidateModel, 'claude-haiku-4-5');
  assert.equal(trial!.incumbentCostPerUnitUsd, 8, 'incumbent priced from its own spend, not the $10 window');
  assert.equal(trial!.candidateCostPerUnitUsd, 1, 'candidate priced from its own spend, not the $10 window');
  assert.equal(trial!.savingsPerUnitUsd, 7);
  assert.equal(trial!.historicalEquivalentHeadroomUsd, 21, '7/unit across 3 incumbent units');
});

test('model switch: refuses a cheaper candidate whose observed outcome is WORSE', () => {
  const units: WorkUnit[] = [
    wu('feature', 'claude-opus-4-8', true, 4), wu('feature', 'claude-opus-4-8', true, 4), wu('feature', 'claude-opus-4-8', true, 4),
    // Cheaper, but only 1/3 realized against the incumbent's 3/3.
    wu('feature', 'claude-haiku-4-5', true, 1), wu('feature', 'claude-haiku-4-5', false, 1), wu('feature', 'claude-haiku-4-5', false, 1),
  ];
  const fr = computeFrontier(units);
  assert.equal(fr.modelSwitches.length, 0, 'cheaper is not enough — the outcome rate may not be lower');
  assert.ok(fr.recommendations[0]!.includes('No lower-cost same-outcome trial yet'));
});

test('model switch: refuses a two-unit cell — the minimum cohort is three per model', () => {
  const units: WorkUnit[] = [
    wu('feature', 'claude-opus-4-8', true, 4), wu('feature', 'claude-opus-4-8', true, 4), wu('feature', 'claude-opus-4-8', true, 4),
    wu('feature', 'claude-haiku-4-5', true, 1), wu('feature', 'claude-haiku-4-5', true, 1),
  ];
  assert.equal(computeFrontier(units).modelSwitches.length, 0);
});

test('model switch: refuses units whose window is too mixed to price one model', () => {
  // A qualifying price gap, but every window is a near coin-flip between models
  // (share 0.5), so no unit can honestly price either model.
  const units: WorkUnit[] = [
    ...Array.from({ length: 3 }, () => wu('feature', 'claude-opus-4-8', true, 4, 0.5, 2)),
    ...Array.from({ length: 3 }, () => wu('feature', 'claude-haiku-4-5', true, 1, 0.5, 0.5)),
  ];
  assert.equal(computeFrontier(units).modelSwitches.length, 0, 'mixed attribution cannot price a model');
});

test('model switch: refuses legacy units that carry no model-cost attribution at all', () => {
  const units: WorkUnit[] = [
    ...Array.from({ length: 3 }, () => wu('feature', 'claude-opus-4-8', true, 4, null, null)),
    ...Array.from({ length: 3 }, () => wu('feature', 'claude-haiku-4-5', true, 1, null, null)),
  ];
  assert.equal(computeFrontier(units).modelSwitches.length, 0, 'unknown attribution stays unknown');
});

test('model switch: excluded units are counted and reported, not silently dropped', () => {
  const units: WorkUnit[] = [
    ...Array.from({ length: 3 }, () => wu('feature', 'claude-opus-4-8', true, 4)),
    ...Array.from({ length: 3 }, () => wu('feature', 'claude-haiku-4-5', true, 1)),
    // Two more that cannot be priced: one too mixed, one unattributed.
    wu('feature', 'claude-opus-4-8', true, 4, 0.5, 2),
    wu('feature', 'claude-haiku-4-5', true, 1, null, null),
  ];
  const trial = computeFrontier(units).modelSwitches.find((r) => r.taskType === 'feature');
  assert.ok(trial);
  assert.equal(trial!.unitsExcludedMixedAttribution, 1);
  assert.equal(trial!.unitsExcludedUnknownAttribution, 1);
  assert.equal(trial!.minimumDominantCostShare, 0.8, 'the exclusion threshold is disclosed, not hidden');
});

test('model switch: a perfect 3-unit streak is NOT evidence — the separation must survive one flipped outcome', () => {
  // 3/3 candidate vs 2/40 incumbent: the anytime-valid bounds genuinely separate
  // (0.2500 > 0.2339), but flipping one candidate success collapses it. Three
  // commits from one afternoon must not read as EVIDENCE.
  const units: WorkUnit[] = [
    ...Array.from({ length: 3 }, () => wu('feature', 'claude-haiku-4-5', true, 1)),
    ...Array.from({ length: 2 }, () => wu('feature', 'claude-opus-4-8', true, 4)),
    ...Array.from({ length: 38 }, () => wu('feature', 'claude-opus-4-8', false, 4)),
  ];
  const trial = computeFrontier(units).modelSwitches.find((r) => r.taskType === 'feature');
  assert.ok(trial);
  assert.equal(trial!.candidateModel, 'claude-haiku-4-5');
  assert.equal(trial!.confidence, 'trial', 'a conclusion resting on one observation is not evidence');
  assert.match(trial!.rationale, /does not survive a single flipped outcome/);
});

test('model switch: a large, robust separation is an OBSERVATIONAL separation, never causal evidence', () => {
  // 8/8 candidate vs 2/40 incumbent survives a flip on each side.
  const units: WorkUnit[] = [
    ...Array.from({ length: 8 }, () => wu('feature', 'claude-haiku-4-5', true, 1)),
    ...Array.from({ length: 2 }, () => wu('feature', 'claude-opus-4-8', true, 4)),
    ...Array.from({ length: 38 }, () => wu('feature', 'claude-opus-4-8', false, 4)),
  ];
  const trial = computeFrontier(units).modelSwitches.find((r) => r.taskType === 'feature');
  assert.ok(trial);
  assert.equal(trial!.confidence, 'observational_separation');
  assert.match(trial!.rationale, /still does if one outcome flips/);
  // AII-025. The strongest result this procedure can reach must still say what
  // it is. Nothing on the payload may read as a treatment effect: models were
  // never assigned, so the separation is a property of the observed comparison.
  assert.match(trial!.rationale, /observational procedure/);
  assert.match(trial!.rationale, /not a treatment effect/);
  const serialized = JSON.stringify(computeFrontier(units));
  assert.doesNotMatch(serialized, /evidence_supported|evidence-supported/, 'the observational lane cannot label itself evidence-supported');
});

/** A unit with explicit size and timestamp, for the confounder gates. */
function wuAt(
  taskType: TaskType,
  model: string,
  realized: boolean,
  cost: number,
  lines: number,
  tsEpochMs: number,
): WorkUnit {
  return { ...wu(taskType, model, realized, cost), linesAdded: lines, linesDeleted: 0, tsEpochMs };
}

test('model switch: a large unit-size gap caps the result at trial — cheaper may just mean smaller', () => {
  // Statistically this would separate (8/8 vs 2/40), but the candidate's commits
  // are a tenth the size, so "cheaper per unit" is confounded with "smaller work".
  const units: WorkUnit[] = [
    ...Array.from({ length: 8 }, (_, i) => wuAt('feature', 'claude-haiku-4-5', true, 1, 10, 1000 + i)),
    ...Array.from({ length: 2 }, (_, i) => wuAt('feature', 'claude-opus-4-8', true, 4, 200, 1000 + i)),
    ...Array.from({ length: 38 }, (_, i) => wuAt('feature', 'claude-opus-4-8', false, 4, 200, 1000 + i)),
  ];
  const trial = computeFrontier(units).modelSwitches.find((r) => r.taskType === 'feature');
  assert.ok(trial);
  assert.equal(trial!.confidence, 'trial', 'a size-confounded comparison is never evidence');
  assert.ok(trial!.confounders.some((c) => c.includes('unit sizes differ')), trial!.confounders.join(' | '));
  assert.match(trial!.rationale, /confounded/);
});

test('model switch: models observed in non-overlapping periods cannot be evidence', () => {
  const DAY = 24 * 60 * 60 * 1000;
  // Opus used only in month 1, Haiku only in month 2 — an era comparison as much
  // as a model comparison (prices, codebase, and task mix all moved).
  const units: WorkUnit[] = [
    ...Array.from({ length: 2 }, (_, i) => wuAt('feature', 'claude-opus-4-8', true, 4, 100, i * DAY)),
    ...Array.from({ length: 38 }, (_, i) => wuAt('feature', 'claude-opus-4-8', false, 4, 100, i * DAY)),
    ...Array.from({ length: 8 }, (_, i) => wuAt('feature', 'claude-haiku-4-5', true, 1, 100, 90 * DAY + i * DAY)),
  ];
  const trial = computeFrontier(units).modelSwitches.find((r) => r.taskType === 'feature');
  assert.ok(trial);
  assert.equal(trial!.confidence, 'trial');
  assert.ok(trial!.confounders.some((c) => c.includes('non-overlapping periods')), trial!.confounders.join(' | '));
});

test('model switch: scanning more task types tightens the level each one gets', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const cohort = (t: TaskType): WorkUnit[] => [
    ...Array.from({ length: 8 }, (_, i) => wuAt(t, 'claude-haiku-4-5', true, 1, 100, i * DAY)),
    ...Array.from({ length: 2 }, (_, i) => wuAt(t, 'claude-opus-4-8', true, 4, 100, i * DAY)),
    ...Array.from({ length: 38 }, (_, i) => wuAt(t, 'claude-opus-4-8', false, 4, 100, i * DAY)),
  ];
  const one = computeFrontier(cohort('feature')).modelSwitches[0]!;
  assert.equal(one.comparisonsConsidered, 1);
  assert.ok(Math.abs(one.appliedConfidenceLevel - 0.95) < 1e-9, 'a single comparison spends the full 5%');

  const three = computeFrontier([...cohort('feature'), ...cohort('fix'), ...cohort('perf')]).modelSwitches[0]!;
  assert.equal(three.comparisonsConsidered, 3);
  assert.ok(three.appliedConfidenceLevel > one.appliedConfidenceLevel, 'more searching → a stricter bar per comparison');
  assert.ok(Math.abs(three.appliedConfidenceLevel - (1 - 0.05 / 3)) < 1e-9);
});

test('model switch: a per-commit saving that vanishes per changed line is a size difference, not a price one', () => {
  const DAY = 24 * 60 * 60 * 1000;
  // Haiku is cheaper per commit ($1 vs $4) but its commits are a TENTH the size,
  // so per 100 changed lines it is dearer ($10 vs $4). The headline saving is
  // entirely the size of the work handed to it.
  const units: WorkUnit[] = [
    ...Array.from({ length: 8 }, (_, i) => wuAt('feature', 'claude-haiku-4-5', true, 1, 10, i * DAY)),
    ...Array.from({ length: 2 }, (_, i) => wuAt('feature', 'claude-opus-4-8', true, 4, 100, i * DAY)),
    ...Array.from({ length: 38 }, (_, i) => wuAt('feature', 'claude-opus-4-8', false, 4, 100, i * DAY)),
  ];
  const trial = computeFrontier(units).modelSwitches.find((r) => r.taskType === 'feature');
  assert.ok(trial);
  // The outcome statistics separate robustly here (8/8 vs 2/40), so without this
  // gate it would read as EVIDENCE for a saving that does not exist.
  assert.equal(trial!.confidence, 'trial');
  assert.ok(trial!.confounders.some((c) => c.includes('normalizing by work volume')), trial!.confounders.join(' | '));
  assert.equal(trial!.candidateCostPerHundredLinesUsd, 10);
  assert.equal(trial!.incumbentCostPerHundredLinesUsd, 4);
});

test('model switch: a saving that survives per-line normalization keeps its evidence label', () => {
  const DAY = 24 * 60 * 60 * 1000;
  // Same cohort shape, but the work is the same size on both sides, so the gap
  // is a price gap on either basis.
  const units: WorkUnit[] = [
    ...Array.from({ length: 8 }, (_, i) => wuAt('feature', 'claude-haiku-4-5', true, 1, 100, i * DAY)),
    ...Array.from({ length: 2 }, (_, i) => wuAt('feature', 'claude-opus-4-8', true, 4, 100, i * DAY)),
    ...Array.from({ length: 38 }, (_, i) => wuAt('feature', 'claude-opus-4-8', false, 4, 100, i * DAY)),
  ];
  const rec = computeFrontier(units).modelSwitches.find((r) => r.taskType === 'feature');
  assert.ok(rec);
  assert.equal(rec!.confidence, 'observational_separation');
  assert.deepEqual(rec!.confounders, []);
  assert.equal(rec!.candidateCostPerHundredLinesUsd, 1);
  assert.equal(rec!.incumbentCostPerHundredLinesUsd, 4);
});

test('model switch: units from a single working session are not independent trials', () => {
  const MIN = 60 * 1000;
  // Every commit within minutes of the last: one sitting, one task, one codebase
  // state, one decision to use this model. The unit floor is cleared on paper
  // and not in substance.
  const units: WorkUnit[] = [
    ...Array.from({ length: 8 }, (_, i) => wuAt('feature', 'claude-haiku-4-5', true, 1, 100, i * 10 * MIN)),
    ...Array.from({ length: 2 }, (_, i) => wuAt('feature', 'claude-opus-4-8', true, 4, 100, i * 10 * MIN)),
    ...Array.from({ length: 38 }, (_, i) => wuAt('feature', 'claude-opus-4-8', false, 4, 100, i * 10 * MIN)),
  ];
  const trial = computeFrontier(units).modelSwitches.find((r) => r.taskType === 'feature');
  assert.ok(trial);
  assert.equal(trial!.confidence, 'trial', '48 commits from one sitting is not 48 trials');
  assert.ok(trial!.confounders.some((c) => c.includes('clustered in time')), trial!.confounders.join(' | '));
  assert.equal(trial!.candidateSessions, 1);
  assert.equal(trial!.incumbentSessions, 1);
});

test('model switch: an 8-hour gap starts a new working session', () => {
  const HOUR = 60 * 60 * 1000;
  // The same commit counts spread one per nine hours: genuinely separate
  // sittings, so the clustering gate must NOT fire.
  const units: WorkUnit[] = [
    ...Array.from({ length: 8 }, (_, i) => wuAt('feature', 'claude-haiku-4-5', true, 1, 100, i * 9 * HOUR)),
    ...Array.from({ length: 2 }, (_, i) => wuAt('feature', 'claude-opus-4-8', true, 4, 100, i * 9 * HOUR)),
    ...Array.from({ length: 38 }, (_, i) => wuAt('feature', 'claude-opus-4-8', false, 4, 100, i * 9 * HOUR)),
  ];
  const rec = computeFrontier(units).modelSwitches.find((r) => r.taskType === 'feature');
  assert.ok(rec);
  assert.equal(rec!.candidateSessions, 8);
  assert.ok(!rec!.confounders.some((c) => c.includes('clustered in time')), rec!.confounders.join(' | '));
});

test('model switch: dollars priced two different ways are not a price comparison', () => {
  const DAY = 24 * 60 * 60 * 1000;
  // The cheap side was priced by a FALLBACK rate for a model the card did not
  // recognize; the expensive side by an exact list price. Part of that gap is the
  // pricing method, not the provider's price.
  const asBasis = (u: WorkUnit, basis: string): WorkUnit => ({ ...u, dominantModelCostBasis: basis });
  const units: WorkUnit[] = [
    ...Array.from({ length: 8 }, (_, i) => asBasis(wuAt('feature', 'claude-haiku-4-5', true, 1, 100, i * DAY), 'fallback_estimate')),
    ...Array.from({ length: 2 }, (_, i) => wuAt('feature', 'claude-opus-4-8', true, 4, 100, i * DAY)),
    ...Array.from({ length: 38 }, (_, i) => wuAt('feature', 'claude-opus-4-8', false, 4, 100, i * DAY)),
  ];
  const trial = computeFrontier(units).modelSwitches.find((r) => r.taskType === 'feature');
  assert.ok(trial);
  assert.equal(trial!.confidence, 'trial');
  assert.ok(trial!.confounders.some((c) => c.includes('priced on different bases')), trial!.confounders.join(' | '));
});

test('model switch: a sample spanning a rate-card change pools two pricing eras', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const onCard = (u: WorkUnit, card: string): WorkUnit => ({ ...u, dominantModelRateCard: card });
  const units: WorkUnit[] = [
    ...Array.from({ length: 8 }, (_, i) => onCard(wuAt('feature', 'claude-haiku-4-5', true, 1, 100, i * DAY), i < 4 ? 'card-a' : 'card-b')),
    ...Array.from({ length: 2 }, (_, i) => wuAt('feature', 'claude-opus-4-8', true, 4, 100, i * DAY)),
    ...Array.from({ length: 38 }, (_, i) => wuAt('feature', 'claude-opus-4-8', false, 4, 100, i * DAY)),
  ];
  const trial = computeFrontier(units).modelSwitches.find((r) => r.taskType === 'feature');
  assert.ok(trial);
  assert.equal(trial!.confidence, 'trial');
  assert.ok(trial!.confounders.some((c) => c.includes('more than one rate-card revision')), trial!.confounders.join(' | '));
});

test('model switch: a legacy snapshot with no recorded pricing basis cannot claim comparability', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const legacy = (u: WorkUnit): WorkUnit => ({ ...u, dominantModelCostBasis: null, dominantModelRateCard: null });
  const units: WorkUnit[] = [
    ...Array.from({ length: 8 }, (_, i) => legacy(wuAt('feature', 'claude-haiku-4-5', true, 1, 100, i * DAY))),
    ...Array.from({ length: 2 }, (_, i) => legacy(wuAt('feature', 'claude-opus-4-8', true, 4, 100, i * DAY))),
    ...Array.from({ length: 38 }, (_, i) => legacy(wuAt('feature', 'claude-opus-4-8', false, 4, 100, i * DAY))),
  ];
  const trial = computeFrontier(units).modelSwitches.find((r) => r.taskType === 'feature');
  assert.ok(trial);
  assert.equal(trial!.confidence, 'trial', 'unverifiable comparability is not verified comparability');
  assert.ok(trial!.confounders.some((c) => c.includes('was not recorded')), trial!.confounders.join(' | '));
});

test('model switch: the level is split across model PAIRS, not just task types', () => {
  const DAY = 24 * 60 * 60 * 1000;
  // One task type, three models → the incumbent is searched against two
  // candidates. Charging for one comparison would understate the search.
  const units: WorkUnit[] = [
    ...Array.from({ length: 8 }, (_, i) => wuAt('feature', 'claude-haiku-4-5', true, 1, 100, i * DAY)),
    ...Array.from({ length: 8 }, (_, i) => wuAt('feature', 'claude-sonnet-4-6', true, 2, 100, i * DAY)),
    ...Array.from({ length: 2 }, (_, i) => wuAt('feature', 'claude-opus-4-8', true, 4, 100, i * DAY)),
    ...Array.from({ length: 38 }, (_, i) => wuAt('feature', 'claude-opus-4-8', false, 4, 100, i * DAY)),
  ];
  const rec = computeFrontier(units).modelSwitches.find((r) => r.taskType === 'feature');
  assert.ok(rec);
  assert.equal(rec!.comparisonsConsidered, 2, 'three models in one task type is two comparisons, not one');
  assert.ok(Math.abs(rec!.appliedConfidenceLevel - (1 - 0.05 / 2)) < 1e-9);
});

test('model switch: the unclassified "other" bucket is never a like-work cohort', () => {
  const DAY = 24 * 60 * 60 * 1000;
  // 'wibble wobble' classifies as 'other' — the catch-all sink.
  const units: WorkUnit[] = [
    ...Array.from({ length: 8 }, (_, i) => wuAt('other', 'claude-haiku-4-5', true, 1, 100, i * DAY)),
    ...Array.from({ length: 8 }, (_, i) => wuAt('other', 'claude-opus-4-8', true, 4, 100, i * DAY)),
  ];
  assert.equal(computeFrontier(units).modelSwitches.length, 0, 'unclassified work is not one task type');
});

test('model switch: every recommendation carries the assumptions it cannot verify', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const units: WorkUnit[] = [
    ...Array.from({ length: 3 }, (_, i) => wuAt('feature', 'claude-haiku-4-5', true, 1, 100, i * DAY)),
    ...Array.from({ length: 3 }, (_, i) => wuAt('feature', 'claude-opus-4-8', true, 4, 100, i * DAY)),
  ];
  const trial = computeFrontier(units).modelSwitches[0]!;
  assert.ok(trial.assumptions.length >= 4);
  assert.ok(
    trial.assumptions.some((a) => a.includes('independent trial')),
    'the intervals still treat commits as independent even though clustering is now gated',
  );
  assert.ok(trial.assumptions.some((a) => a.includes('chosen by an operator')), 'selection bias is disclosed');
  assert.ok(
    trial.assumptions.some((a) => a.includes('searching on the very outcome')),
    'the post-selection weakening of the anytime-valid guarantee is disclosed',
  );
  assert.ok(trial.assumptions.some((a) => a.includes('not provider-billed cost')), 'the pricing boundary is disclosed');
  // Mixed pricing bases USED to be an assumption. They are now a confounder that
  // caps the result, so they must NOT still be listed as something merely assumed
  // away — a limit that has been turned into a gate should stop being disclaimed.
  assert.ok(!trial.assumptions.some((a) => a.includes('pricing bases')), 'a gated limit is no longer an assumption');
});

test('model switch: does not compare across different task types', () => {
  // Cheap model only ever did fixes; expensive model only ever did features.
  const units: WorkUnit[] = [
    ...Array.from({ length: 3 }, () => wu('feature', 'claude-opus-4-8', true, 4)),
    ...Array.from({ length: 3 }, () => wu('fix', 'claude-haiku-4-5', true, 1)),
  ];
  assert.equal(computeFrontier(units).modelSwitches.length, 0, 'unlike work is not a comparison');
});

// ---- Value-aware budgeting ----

test('budget advisor: cap fits usage; low realized value tightens it and projects waste', () => {
  const daily = [2, 3, 4, 5, 2, 3, 10, 4, 3, 5];
  const usageOnly = recommendBudget({ dailySpends: daily, realizedSpendShare: null });
  assert.ok(usageOnly.recommendedDailyUsd != null && usageOnly.recommendedDailyUsd > 0);
  assert.ok(
    usageOnly.recommendedSoftUsd != null &&
      usageOnly.recommendedDailyUsd != null &&
      usageOnly.recommendedSoftUsd < usageOnly.recommendedDailyUsd,
  );
  assert.equal(usageOnly.projectedMonthlyWasteUsd, null);

  const lowValue = recommendBudget({ dailySpends: daily, realizedSpendShare: 0.3 });
  assert.ok(lowValue.projectedMonthlyWasteUsd !== null && lowValue.projectedMonthlyWasteUsd > 0);
  assert.ok(lowValue.rationale.some((r) => /low/i.test(r)));
});

test('budget advisor: raw frontier cells do not create cross-context trim/grow actions', () => {
  const cells: FrontierCell[] = [
    { key: 'feature · opus', model: 'opus', taskType: 'feature', units: 3, costUsd: 12, spendOnRealizedUnitsUsd: 4, acceptanceWeightedSpendUsd: 4, realizationRate: 0.33, acceptance: null, costPerUnit: 4, roiIndex: 40, impact: 0.33 },
    { key: 'fix · haiku', model: 'haiku', taskType: 'fix', units: 3, costUsd: 3, spendOnRealizedUnitsUsd: 3, acceptanceWeightedSpendUsd: 3, realizationRate: 1, acceptance: null, costPerUnit: 1, roiIndex: 95, impact: 1 },
  ];
  const rec = recommendBudget({ dailySpends: [5, 5, 5, 5, 5, 5, 5], realizedSpendShare: 0.6, frontier: cells });
  assert.deepEqual(rec.reallocations, [], 'generic task/model cells are not comparable enough for an actionable allocation');
});

test('budget advisor: cold start is honest — no spend history yields no cap, not $0', () => {
  const empty = recommendBudget({ dailySpends: [], realizedSpendShare: null });
  assert.equal(empty.recommendedDailyUsd, null);
  assert.equal(empty.recommendedSoftUsd, null);
  assert.equal(empty.basisDays, 0);
  assert.ok(empty.rationale.some((r) => /not enough/i.test(r)));

  // Zero-cost-only days (e.g. all-blocked) are not "active days" and don't fabricate a cap.
  const zeros = recommendBudget({ dailySpends: [0, 0, 0], realizedSpendShare: null });
  assert.equal(zeros.recommendedDailyUsd, null);
  assert.equal(zeros.basisDays, 0);
});

test('budget advisor: thin history stays review-only and cannot be applied', () => {
  const thin = recommendBudget({ dailySpends: [3, 4, 5], realizedSpendShare: null });
  assert.equal(thin.status, 'insufficient_history');
  assert.equal(thin.canApply, false);
  assert.equal(thin.recommendedDailyUsd, null);
  assert.match(thin.rationale[0]!, /at least 7 active days/i);

  const ready = recommendBudget({ dailySpends: [3, 4, 5, 3, 4, 5, 4], realizedSpendShare: null });
  assert.equal(ready.status, 'usage_only');
  assert.equal(ready.canApply, true);
  assert.ok(ready.recommendedDailyUsd !== null);
});

// ---- Cross-modality (non-coding) RoI ----

test('cross-modality: a non-coding session with a reported positive outcome realizes', () => {
  const store = new Store(':memory:');
  try {
    const t = Date.parse('2026-06-01T10:00:00Z');
    const req = (id: string, session: string, cost: number, model: string) => ({
      requestId: id, sessionId: session, tsEpochMs: t, provider: 'anthropic', model, project: 'p', taskWeight: 1,
      inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0,
      costUsd: cost, estimated: false, streamed: false, statusCode: 200, durationMs: 1,
    });
    store.insertRequest(req('r1', 's1', 2, 'claude-opus-4-8'));
    store.insertSignal({ signalId: 'g1', kind: 'used', commitHash: 's1', project: 'p', tsEpochMs: t + 1000, verdict: 'pass', detail: null });
    store.insertRequest(req('r2', 's2', 1, 'claude-haiku-4-5')); // no outcome reported

    const rep = computeUsageRoI(store, { startMs: t - 1000, endMs: t + 10_000 });
    assert.equal(rep.units.length, 2);
    assert.equal(rep.units.find((u) => u.sessionId === 's1')!.realized, true, 'used → realized');
    assert.equal(rep.units.find((u) => u.sessionId === 's2')!.realized, false, 'no outcome → not realized');
    assert.equal(rep.realizedUnits, 1);
  } finally {
    store.close();
  }
});

test('cross-modality: outcome is GRADED — realizing a further-reaching outcome earns more Impact', () => {
  // Impact = realized reach-weight ÷ total reach-weight. So realizing a high-reach
  // outcome (published) must move Impact more than realizing a low-reach one (used).
  // We hold the portfolio shape fixed — N realized units of `kind` paired with N
  // sessions that ran but reported nothing (unrealized) — and vary only the graded
  // kind. Before grading, every positive was flat shipped=pass and these were equal.
  const build = (kind: string): ReturnType<typeof computeUsageRoI> => {
    const store = new Store(':memory:');
    try {
      const t = Date.parse('2026-06-01T10:00:00Z');
      const req = (id: string, session: string) => ({
        requestId: id, sessionId: session, tsEpochMs: t, provider: 'anthropic', model: 'claude-opus-4-8', project: 'p', taskWeight: 1,
        inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0,
        costUsd: 2, estimated: false, streamed: false, statusCode: 200, durationMs: 1,
      });
      for (let i = 0; i < 4; i++) {
        store.insertRequest(req(`r${i}`, `s${i}`)); // realized, graded
        store.insertSignal({ signalId: `g${i}`, kind, commitHash: `s${i}`, project: 'p', tsEpochMs: t + 1000, verdict: 'pass', detail: null });
        store.insertRequest(req(`u${i}`, `n${i}`)); // ran, nothing reported → unrealized ballast
      }
      return computeUsageRoI(store, { startMs: t - 1000, endMs: t + 10_000 });
    } finally {
      store.close();
    }
  };

  const published = build('published');
  const resolved = build('resolved');
  const used = build('used');
  const impact = (r: ReturnType<typeof computeUsageRoI>) => r.roi.lenses.impact.value!;
  assert.ok(impact(published) > impact(resolved), 'published outreaches resolved');
  assert.ok(impact(resolved) > impact(used), 'resolved outreaches used');

  // The breakdown reflects the grade, not a flat "positive" bucket.
  assert.equal(published.outcomeMix.published, 4);
  assert.equal(published.outcomeMix.none, 4);
  assert.equal(resolved.outcomeMix.resolved, 4);
  assert.equal(used.outcomeMix.used, 4);
});

test('cross-modality: reach becomes cardinal Impact only through a DECLARED utility model', () => {
  // AII-011. Reach is ordinal: published outreaches resolved outreaches kept.
  // Nothing observed says by how much, so the [0,1] the Impact lens needs comes
  // from a stated preference. It used to be an inline 1/0.75/0.5 at the call
  // site, which is how a workflow label arrived in the composite looking like a
  // measurement. Two things must now hold: the model is what produces the
  // number, and the number says so wherever it is displayed.
  const build = (reachUtility?: Readonly<Record<'shipped' | 'merged' | 'kept', number>>) => {
    const store = new Store(':memory:');
    try {
      const t = Date.parse('2026-06-01T10:00:00Z');
      for (let i = 0; i < 4; i++) {
        store.insertRequest({
          requestId: `r${i}`, sessionId: `s${i}`, tsEpochMs: t, provider: 'anthropic', model: 'claude-opus-4-8', project: 'p', taskWeight: 1,
          inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0,
          costUsd: 2, estimated: false, streamed: false, statusCode: 200, durationMs: 1,
        });
        store.insertSignal({ signalId: `g${i}`, kind: 'resolved', commitHash: `s${i}`, project: 'p', tsEpochMs: t + 1000, verdict: 'pass', detail: null });
      }
      return computeUsageRoI(store, { startMs: t - 1000, endMs: t + 10_000, ...(reachUtility ? { reachUtility } : {}) });
    } finally {
      store.close();
    }
  };

  const declared = build();
  assert.equal(declared.roi.lenses.impact.value, DECLARED_REACH_UTILITY.merged, 'the declared model is what sets the cardinal value');

  // A different declared preference must produce a different Impact. If it did
  // not, the number would be coming from somewhere other than the stated model.
  const reweighted = build({ shipped: 1, merged: 0.2, kept: 0.1 });
  assert.equal(reweighted.roi.lenses.impact.value, 0.2, 'a different declared preference must move Impact');
  assert.notEqual(reweighted.roi.lenses.impact.value, declared.roi.lenses.impact.value);

  // The provenance string travels with the lens, so no surface can present this
  // as an observed cardinal impact.
  const how = declared.roi.lenses.impact.how;
  assert.match(how, /DECLARED reach-utility model/);
  assert.match(how, /stated preference, not a measured cardinal impact/);
  assert.match(how, /resolved=0\.75/, 'the actual model in force must appear, not a generic caveat');
});

test('cross-modality: outcome baselines price the dollar face — and never touch the efficiency lens', () => {
  const store = new Store(':memory:');
  try {
    const t = Date.parse('2026-06-01T10:00:00Z');
    for (let i = 0; i < 3; i++) {
      store.insertRequest({
        requestId: `r${i}`, sessionId: `s${i}`, tsEpochMs: t + i * 60_000, provider: 'anthropic', model: 'claude-opus-4-8', project: 'p', taskWeight: 1,
        inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0,
        costUsd: 1, estimated: false, streamed: false, statusCode: 200, durationMs: 1,
      });
      store.insertSignal({ signalId: `g${i}`, kind: 'resolved', commitHash: `s${i}`, project: 'p', tsEpochMs: t + 1000, verdict: 'pass', detail: null });
    }
    const window = { startMs: t - 1000, endMs: t + 600_000 };

    // Un-priced by default: no baselines → the dollar face stays dark.
    const bare = computeUsageRoI(store, window);
    assert.equal(bare.money.priced, false);
    assert.equal(bare.roi.returnRatio.basis === 'usd' && bare.roi.returnRatio.grossRatio !== null, false, 'no invented dollars');

    // Disclosed baselines + rate → priced: 3 resolved × 30min × $120/hr = $180 gross.
    const priced = computeUsageRoI(store, { ...window, money: { outcomeBaselineMinutes: { resolved: 30 }, laborRatePerHour: 120 } });
    assert.equal(priced.money.priced, true);
    assert.ok(Math.abs(priced.money.grossRealizedValueUsd! - 180) < 1e-9, `gross = $180, got ${priced.money.grossRealizedValueUsd}`);

    // The efficiency lens keeps the honest floor either way (a 0..1 share of spend).
    assert.ok(priced.roi.realizedEfficiency !== null && priced.roi.realizedEfficiency <= 1, 'efficiency stays a share');
    assert.equal(priced.roi.realizedEfficiency, bare.roi.realizedEfficiency, 'pricing never inflates the efficiency lens');
  } finally {
    store.close();
  }
});

// ---- realization integration (real git) ----

function g(cwd: string, args: string[], env: Record<string, string> = {}): void {
  execFileSync('git', args, { cwd, env: { ...process.env, ...env }, stdio: 'ignore' });
}
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fiscus-v-'));
  g(dir, ['init', '-q']);
  g(dir, ['config', 'user.email', 't@t.co']);
  g(dir, ['config', 'user.name', 'tester']);
  return dir;
}
function commit(dir: string, file: string, content: string, msg: string, iso: string): void {
  writeFileSync(join(dir, file), content);
  g(dir, ['add', '.']);
  g(dir, ['commit', '-qm', msg, `--date=${iso}`], { GIT_COMMITTER_DATE: iso });
}

test('realization: complete lifecycle evidence + survival → REALIZED; churned commit dies at survived', async () => {
  const dir = makeRepo();
  const store = new Store(':memory:');
  try {
    commit(dir, 'seed.txt', 'seed\n', 'feat: base', '2026-01-01T10:00:00+00:00');

    // Commit A: a new file of 10 lines, all of which survive to HEAD.
    const tenLines = Array.from({ length: 10 }, (_, i) => `L${i}`).join('\n') + '\n';
    commit(dir, 'work.txt', tenLines, 'feat: ten', '2026-01-02T10:00:00+00:00');
    const hashA = (await resolveCommit(dir, 'HEAD'))!;
    const project = await projectName(dir);

    // Proxy captured a proposal in A's window whose lines match what shipped → acceptance ~1.
    store.insertProposal({
      proposalId: 'p1', requestId: 'p1', sessionId: null,
      tsEpochMs: Date.parse('2026-01-02T09:00:00Z'),
      provider: 'anthropic', model: 'claude-opus-4-8', project,
      files: [{ path: 'work.txt', addedLines: Array.from({ length: 10 }, (_, i) => `L${i}`) }],
    });
    // Outcome signals wired for A. Strict realization requires every declared
    // coding lifecycle predicate, including merge; an absent signal must remain
    // unresolved rather than being treated as an implicit pass.
    store.insertSignal({ signalId: 's1', kind: 'tested', commitHash: hashA, project, tsEpochMs: Date.now(), verdict: 'pass', detail: null });
    store.insertSignal({ signalId: 's2', kind: 'shipped', commitHash: hashA, project, tsEpochMs: Date.now(), verdict: 'pass', detail: null });
    store.insertSignal({ signalId: 's3', kind: 'merged', commitHash: hashA, project, tsEpochMs: Date.now(), verdict: 'pass', detail: null });

    const cleanCompleteness = [
      completenessWitness({
        id: 'realization-test-incident-source',
        sourceId: 'incident-feed',
        state: 'supported',
        eventTypes: ['linked_incident'],
        scope: scope({ project }),
        period: interval('2025-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'),
      }),
      completenessWitness({
        id: 'realization-test-revert-scan',
        sourceId: 'git-history',
        state: 'supported',
        eventTypes: ['commit_reverted'],
        scope: scope({ project }),
        period: interval('2025-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'),
      }),
    ];

    // Commit B then C: C rewrites 3 of B's 4 lines → B survival 0.25 < 0.5 → dies at survived.
    commit(dir, 'churn.txt', 'c1\nc2\nc3\nc4\n', 'feat: churn base', '2026-01-03T10:00:00+00:00');
    commit(dir, 'churn.txt', 'c1\nx2\nx3\nx4\n', 'fix: rewrite three', '2026-01-04T10:00:00+00:00');

    const report = await computeRealization(store, dir, { limit: 10, windowDays: 14, completenessWitnesses: cleanCompleteness });

    const a = report.units.find((u) => u.subject === 'feat: ten')!;
    assert.ok(a, 'commit A present');
    assert.equal(a.maturing, false);
    assert.ok(a.acceptance !== null && a.acceptance > 0.95, `acceptance ${a.acceptance}`);
    const acceptedGate = a.funnel.results.find((r) => r.gate === 'accepted')!;
    assert.equal(acceptedGate.verdict, 'pass');
    const testedGate = a.funnel.results.find((r) => r.gate === 'tested')!;
    assert.equal(testedGate.verdict, 'pass');
    assert.equal(a.funnel.realized, true, 'A realized');

    const b = report.units.find((u) => u.subject === 'feat: churn base')!;
    assert.ok(b, 'commit B present');
    assert.equal(b.funnel.realized, false);
    assert.equal(b.funnel.diedAt, 'survived');

    // First-pass acceptance reflects A (the only unit with a proposal).
    assert.ok(report.firstPassAcceptance !== null && report.firstPassAcceptance > 0.95);
    // Tested gate instrumented on at least one matured unit.
    assert.ok(report.matured.instrumentation.tested >= 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
