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
import { extractProposals, acceptanceRatio, acceptanceForCommit } from '../src/value/proposals.ts';
import { loadOrCreateKeyPair, buildReceiptBody, signReceipt, verifyReceipt } from '../src/value/receipt.ts';
import { computeRealization } from '../src/value/realization.ts';
import { computeReturnOnIntelligence, lensRedundancy, type RealizationLike } from '../src/value/lenses.ts';
import { timeWithAiMinutes, boundedLift, breakEven, liftFromData } from '../src/value/lift.ts';
import { classifyTaskType, type TaskType } from '../src/value/taskType.ts';
import { computeFrontier, type FrontierCell } from '../src/value/frontier.ts';
import { recommendBudget } from '../src/budget/recommend.ts';
import { computeUsageRoI } from '../src/value/usage.ts';
import type { WorkUnit } from '../src/value/realization.ts';
import { projectName, resolveCommit } from '../src/git/correlate.ts';

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

test('acceptanceForCommit returns null when nothing was proposed (→ gate unknown)', () => {
  const committed = new Map<string, string[]>([['a.ts', ['x', 'y']]]);
  assert.equal(acceptanceForCommit([], committed), null);
  assert.equal(acceptanceForCommit([{ path: 'a.ts', addedLines: ['x'] }], committed), 1);
});

test('receipt: sign then verify is valid; tampering invalidates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-rk-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'aegis-pin-'));
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
  const dir = mkdtempSync(join(tmpdir(), 'aegis-lie-'));
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
    matured: { realizationRate: 0.8, totalCostUsd: 10, realizedValueUsd: 8 },
  };
  const r = computeReturnOnIntelligence(report);
  assert.equal(r.roiIndex, 0, 'one collapsed lens collapses the index');
  assert.equal(r.lenses.lift.instrumented, false, 'lift uninstrumented by default');
  assert.ok(Math.abs(r.coverage - 3 / 4) < 1e-9, 'lift excluded from coverage');
  assert.ok(r.notes.some((n) => n.includes('collapsed')));
});

test('RoI: injected lift widens coverage; index is the geometric mean of instrumented lenses', () => {
  const report: RealizationLike = {
    firstPassAcceptance: 0.9,
    units: [ru({ realized: true, acceptance: 0.9, shipped: true })],
    matured: { realizationRate: 0.8, totalCostUsd: 10, realizedValueUsd: 8 },
  };
  const r = computeReturnOnIntelligence(report, { lift: 0.5 });
  assert.equal(r.coverage, 1, 'all four lenses instrumented');
  assert.ok(r.roiIndex !== null && r.roiIndex > 0 && r.roiIndex < 100);
});

test('RoI composite interval: statistical width (realization CS) enters even without a Lift range, sources disclosed', () => {
  const report: RealizationLike = {
    firstPassAcceptance: 0.9,
    units: [ru({ realized: true, acceptance: 0.9, shipped: true }), ru({ realized: false, acceptance: 0.9 })],
    matured: { realizationRate: 0.5, totalCostUsd: 10, realizedValueUsd: 5 },
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
    matured: { realizationRate: 0.5, totalCostUsd: 10, realizedValueUsd: 5 },
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
    matured: { realizationRate: 1, totalCostUsd: 10, realizedValueUsd: 10 },
  };
  const tokenOnly = computeReturnOnIntelligence(report);
  const withLabor = computeReturnOnIntelligence(report, { laborRatePerHour: 120, minutesPerUnitRework: 10 });
  assert.equal(tokenOnly.realizedEfficiency, 1);
  assert.equal(withLabor.effortTaxUsd, 10); // (1-0.5)*10min*($120/60) = $10
  assert.ok(withLabor.realizedEfficiency !== null && withLabor.realizedEfficiency < 1);
});

test('RoI: Impact diverges from raw realization via production reach (shipped weighs more), not line counts', () => {
  const report: RealizationLike = {
    firstPassAcceptance: null,
    units: [
      ru({ realized: true, acceptance: null, shipped: true }), // realized AND reached production
      ru({ realized: false, acceptance: null }), // not realized
    ],
    matured: { realizationRate: 0.5, totalCostUsd: 5, realizedValueUsd: 3 },
  };
  const r = computeReturnOnIntelligence(report);
  assert.ok(r.lenses.impact.value !== null);
  // The realized unit shipped (reach 1.5) while the other didn't realize → impact
  // is pulled above the raw 0.5 realization purely by production reach. No LOC input
  // exists on the lens anymore, so this divergence cannot come from size.
  assert.ok(r.lenses.impact.value! > 0.5, `impact ${r.lenses.impact.value} should exceed raw 0.5 realization`);
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

function wu(taskType: TaskType, model: string, realized: boolean, cost: number): WorkUnit {
  return {
    hash: Math.random().toString(36).slice(2), tsEpochMs: 0, subject: '', linesAdded: 10, linesDeleted: 0, filesChanged: 1,
    windowStartMs: 0, windowEndMs: 0, attributedCostUsd: cost, attributedRequests: 1, attributedOutputTokens: 0, costPerHundredLines: null,
    ageDays: 30, maturing: false, survivalRatio: 1, reverted: false, hadProposal: false, acceptance: null,
    taskType, dominantModel: model,
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
});

// ---- Value-aware budgeting ----

test('budget advisor: cap fits usage; low realized value tightens it and projects waste', () => {
  const daily = [2, 3, 4, 5, 2, 3, 10, 4, 3, 5];
  const usageOnly = recommendBudget({ dailySpends: daily, realizedValueRate: null });
  assert.ok(usageOnly.recommendedDailyUsd != null && usageOnly.recommendedDailyUsd > 0);
  assert.ok(
    usageOnly.recommendedSoftUsd != null &&
      usageOnly.recommendedDailyUsd != null &&
      usageOnly.recommendedSoftUsd < usageOnly.recommendedDailyUsd,
  );
  assert.equal(usageOnly.projectedMonthlyWasteUsd, null);

  const lowValue = recommendBudget({ dailySpends: daily, realizedValueRate: 0.3 });
  assert.ok(lowValue.projectedMonthlyWasteUsd !== null && lowValue.projectedMonthlyWasteUsd > 0);
  assert.ok(lowValue.rationale.some((r) => /low/i.test(r)));
});

test('budget advisor: frontier drives trim/grow reallocation', () => {
  const cells: FrontierCell[] = [
    { key: 'feature · opus', model: 'opus', taskType: 'feature', units: 3, costUsd: 12, realizedValueUsd: 4, netRealizedValueUsd: 4, realizationRate: 0.33, acceptance: null, costPerUnit: 4, roiIndex: 40, impact: 0.33 },
    { key: 'fix · haiku', model: 'haiku', taskType: 'fix', units: 3, costUsd: 3, realizedValueUsd: 3, netRealizedValueUsd: 3, realizationRate: 1, acceptance: null, costPerUnit: 1, roiIndex: 95, impact: 1 },
  ];
  const rec = recommendBudget({ dailySpends: [5, 5, 5, 5, 5, 5, 5], realizedValueRate: 0.6, frontier: cells });
  const trim = rec.reallocations.find((r) => r.action === 'trim');
  const grow = rec.reallocations.find((r) => r.action === 'grow');
  assert.ok(trim && trim.context.includes('opus'), 'trims lowest-RoI context');
  assert.ok(grow && grow.context.includes('haiku'), 'grows highest-RoI context');
});

test('budget advisor: cold start is honest — no spend history yields no cap, not $0', () => {
  const empty = recommendBudget({ dailySpends: [], realizedValueRate: null });
  assert.equal(empty.recommendedDailyUsd, null);
  assert.equal(empty.recommendedSoftUsd, null);
  assert.equal(empty.basisDays, 0);
  assert.ok(empty.rationale.some((r) => /not enough/i.test(r)));

  // Zero-cost-only days (e.g. all-blocked) are not "active days" and don't fabricate a cap.
  const zeros = recommendBudget({ dailySpends: [0, 0, 0], realizedValueRate: null });
  assert.equal(zeros.recommendedDailyUsd, null);
  assert.equal(zeros.basisDays, 0);
});

test('budget advisor: thin history stays review-only and cannot be applied', () => {
  const thin = recommendBudget({ dailySpends: [3, 4, 5], realizedValueRate: null });
  assert.equal(thin.status, 'insufficient_history');
  assert.equal(thin.canApply, false);
  assert.equal(thin.recommendedDailyUsd, null);
  assert.match(thin.rationale[0]!, /at least 7 active days/i);

  const ready = recommendBudget({ dailySpends: [3, 4, 5, 3, 4, 5, 4], realizedValueRate: null });
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
  const dir = mkdtempSync(join(tmpdir(), 'aegis-v-'));
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

test('realization: accepted proposal + tested signal + survival → REALIZED; churned commit dies at survived', async () => {
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
    // Outcome signals wired for A.
    store.insertSignal({ signalId: 's1', kind: 'tested', commitHash: hashA, project, tsEpochMs: Date.now(), verdict: 'pass', detail: null });
    store.insertSignal({ signalId: 's2', kind: 'shipped', commitHash: hashA, project, tsEpochMs: Date.now(), verdict: 'pass', detail: null });

    // Commit B then C: C rewrites 3 of B's 4 lines → B survival 0.25 < 0.5 → dies at survived.
    commit(dir, 'churn.txt', 'c1\nc2\nc3\nc4\n', 'feat: churn base', '2026-01-03T10:00:00+00:00');
    commit(dir, 'churn.txt', 'c1\nx2\nx3\nx4\n', 'fix: rewrite three', '2026-01-04T10:00:00+00:00');

    const report = await computeRealization(store, dir, { limit: 10, windowDays: 14 });

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
