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
  type Gate,
  type GateResult,
  type Verdict,
} from '../src/value/gates.ts';
import { extractProposals, acceptanceRatio, acceptanceForCommit } from '../src/value/proposals.ts';
import { loadOrCreateKeyPair, buildReceiptBody, signReceipt, verifyReceipt } from '../src/value/receipt.ts';
import { computeRealization } from '../src/value/realization.ts';
import { computeReturnOnIntelligence, type RealizationLike } from '../src/value/lenses.ts';
import { timeWithAiMinutes, boundedLift, breakEven } from '../src/value/lift.ts';
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
    { key: 'feature · opus', model: 'opus', taskType: 'feature', units: 3, costUsd: 12, realizedValueUsd: 4, netRealizedValueUsd: 4, realizationRate: 0.33, acceptance: null, costPerUnit: 4, roiIndex: 40 },
    { key: 'fix · haiku', model: 'haiku', taskType: 'fix', units: 3, costUsd: 3, realizedValueUsd: 3, netRealizedValueUsd: 3, realizationRate: 1, acceptance: null, costPerUnit: 1, roiIndex: 95 },
  ];
  const rec = recommendBudget({ dailySpends: [5, 5, 5], realizedValueRate: 0.6, frontier: cells });
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
