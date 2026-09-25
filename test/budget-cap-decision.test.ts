/**
 * The decision subsystem reaches an operator through the budget advisor.
 *
 * `src/decision/` was an island: `certifyDecision`, `minimaxRegret`,
 * `buildDecisionKernelIssuance`, `issueDecisionToKernel`, `decisionCountermodels`
 * and `pendingInvalidationBy` were each tested and none was consumed by a
 * product path. `src/budget/recommend.ts` named itself the intended consumer.
 * This file pins the wiring at the pure advisor, at the kernel round-trip, and
 * at the terminal an operator meets (`segreant budget --recommend`).
 *
 * THE BAR THIS HONOURS (D-193). A recommendation that is acted on needs
 * `decisionFitness >= sufficient` AND `measurement >= proxy_validated`, and the
 * decision adapter issues fitness at `proxy_unvalidated` while the metered
 * input claim carries `integrity: 'unknown'`. Nothing the product can declare
 * today clears a spend-changing consequence, so the advisor's decision must
 * render as review-only with its reason -- and the tests below assert that
 * from the product's own input profiles, not from a fixture chosen to fail.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

process.env.SEGREANT_HOME = mkdtempSync(join(tmpdir(), 'segreant-home-cap-decision-'));

import { Store, type RequestRow } from '../src/store/db.ts';
import { recommendBudget } from '../src/budget/recommend.ts';
import {
  BUDGET_CAP_ADMISSIBLE_PREFERENCES,
  BUDGET_CAP_PROBLEM,
  budgetCapIssuanceInput,
  decideBudgetCap,
  issueBudgetCapDecision,
  previewBudgetCapIssuance,
  readBudgetCapCertificates,
  renderBudgetCapDecision,
} from '../src/budget/capDecision.ts';
import { issueDecisionToKernel } from '../src/decision/epistemic.ts';
import { EpistemicLedger } from '../src/epistemic/ledger.ts';
import { claimProfile } from '../src/epistemic/profile.ts';
import { budgetAdvice } from '../src/value/report.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts');
const DAY = 24 * 60 * 60 * 1000;
const ISSUED_AT = '2026-09-10T12:00:00.000Z';

/** The product's own profile for the metered series: `meteredClaimSupport`, list-priced, complete. */
const METERED_INPUT = {
  id: 'claim:budget:cap:input:metered_daily_spend',
  profile: claimProfile({
    epistemic: 'supported', integrity: 'unknown', authenticity: 'self_asserted', scope: 'conditional',
    coverage: 'complete', measurement: 'proxy_unvalidated', causality: 'none', monetaryBasis: 'list',
    finality: 'provisional', decisionFitness: 'not_assessed',
  }),
};

/** An input set that would reach DAL-3 -- nothing in the product issues one; it exists to show the gate can open. */
const DAL3_INPUT = {
  id: 'claim:test:assigned',
  profile: claimProfile({
    epistemic: 'supported', integrity: 'verified', authenticity: 'pinned', scope: 'established',
    coverage: 'complete', measurement: 'validated', causality: 'randomized', monetaryBasis: 'effective',
    finality: 'provisional', decisionFitness: 'not_assessed',
  }),
};

const TEN_DAYS = [2, 3, 4, 5, 2, 3, 10, 4, 3, 5];

function ledger(): EpistemicLedger { return new EpistemicLedger(new DatabaseSync(':memory:')); }

function renderDecision(
  decision: ReturnType<typeof decideBudgetCap>,
  reads: ReturnType<typeof readBudgetCapCertificates>,
): string {
  const canonical = previewBudgetCapIssuance(decision, {
    issuedAt: ISSUED_AT,
    windowDays: 30,
    spendBasis: 'all_observed',
    monetaryBasis: 'list',
    seriesCoverage: 'complete',
  });
  return renderBudgetCapDecision(decision, reads, canonical).join('\n');
}

// ---- the pure advisor carries a decision -------------------------------------

test('a recommended cap carries a decision problem with an alternative, a certificate and a rule-selected action', () => {
  const rec = recommendBudget({ dailySpends: TEN_DAYS, realizedSpendShare: 0.3, currentDailyCapUsd: null, decisionInputs: [METERED_INPUT] });
  assert.ok(rec.recommendedDailyUsd !== null);
  const decision = rec.decision;
  assert.ok(decision, 'a cap that can be applied is a decision, and the decision travels with it');
  assert.deepEqual(decision.problem, BUDGET_CAP_PROBLEM);
  assert.deepEqual(decision.actions.map((a) => a.action), ['apply_recommended', 'keep_current']);
  assert.equal(decision.actions.find((a) => a.action === 'keep_current')!.capUsd, null);
  assert.equal(decision.actions.find((a) => a.action === 'apply_recommended')!.capUsd, rec.recommendedDailyUsd);
  // The engine's certificate, verbatim: the rule and the comparisons it made.
  assert.equal(decision.certificate.rule, 'strict_interval_dominance');
  assert.equal(decision.certificate.comparisons.length, 2);
  // minimaxRegret is routed, and labelled as the declared rule it is.
  assert.equal(decision.regret.rule, 'minimax_regret');
  assert.ok(decision.regret.actions.length >= 1);
  assert.ok(decision.regret.assumptions.some((a) => /not proof/i.test(a)));
});

test('no cap, no decision: cold start and thin history carry null rather than an invented problem', () => {
  assert.equal(recommendBudget({ dailySpends: [], realizedSpendShare: null }).decision, null);
  assert.equal(recommendBudget({ dailySpends: [3, 4, 5], realizedSpendShare: null }).decision, null);
});

test('utility intervals are the declared window replay, and the unknown split keeps them honest', () => {
  // realized share known: the realized total is observed, its split across
  // admitted and blocked days is not, so the cap's interval spans every split.
  const known = decideBudgetCap({ dailySpends: [10, 10, 10, 40], realizedSpendShare: 0.5, currentDailyCapUsd: null, recommendedDailyUsd: 20 });
  const keep = known.actions.find((a) => a.action === 'keep_current')!;
  const apply = known.actions.find((a) => a.action === 'apply_recommended')!;
  assert.equal(keep.admittedUsd, 70);
  assert.equal(keep.blockedUsd, 0);
  assert.deepEqual([keep.utility.low, keep.utility.high], [0, 0]); // (2·0.5 − 1)·70
  assert.equal(apply.admittedUsd, 50);
  assert.equal(apply.blockedUsd, 20);
  // realized within admitted ∈ [max(0, 35−20), min(50, 35)] = [15, 35] → net ∈ [−20, 20]
  assert.deepEqual([apply.utility.low, apply.utility.high], [-20, 20]);
  assert.equal(known.certificate.status, 'undetermined');
  assert.equal(known.certificate.reason, 'intervals_overlap');

  // uninstrumented: the realized total itself ranges over [0, total].
  const unknown = decideBudgetCap({ dailySpends: [10, 10, 10, 40], realizedSpendShare: null, currentDailyCapUsd: null, recommendedDailyUsd: 20 });
  const keepU = unknown.actions.find((a) => a.action === 'keep_current')!;
  assert.deepEqual([keepU.utility.low, keepU.utility.high], [-70, 70]);
  assert.ok(unknown.assumptions.some((a) => /uninstrumented/i.test(a)));
});

test('strict dominance is reachable from real inputs -- and still does not certify a spend change', () => {
  // Almost nothing realizes and the cap is far tighter than the current one:
  // whichever days realized, admitting less spend nets more.
  const decision = decideBudgetCap({
    dailySpends: [20, 20, 20, 20, 20],
    realizedSpendShare: 0.02,
    currentDailyCapUsd: 100,
    recommendedDailyUsd: 10,
    inputs: [METERED_INPUT],
  });
  assert.equal(decision.certificate.status, 'proven_dominant');
  assert.equal(decision.certificate.action, 'apply_recommended');
  assert.deepEqual(decision.regret.actions, ['apply_recommended']);
  // D-193's bar, through the assurance ladder: the metered input is
  // `integrity: unknown` and `measurement: proxy_unvalidated`, so even a proven
  // certificate is held below what a spend change requires.
  assert.equal(decision.assurance.consequence, 'changes_spend');
  assert.equal(decision.assurance.requiredLevel, 'DAL-3');
  assert.equal(decision.assurance.meetsRequirement, false);
  assert.equal(decision.assurance.authorizesAction, false);
  assert.equal(decision.standing.status, 'review_only');
  assert.ok(decision.standing.reasons.some((r) => /DAL-3/.test(r)), 'the reason names the level the consequence requires');
  assert.ok(
    decision.assurance.refusal?.shortfalls.some((s) => s.axis === 'measurement' && s.observed === 'proxy_unvalidated'),
    'the measurement axis D-193 named is the one reported short',
  );
});

test('an uncertified decision is review-only with its reason, from the product profiles, not a fixture built to fail', () => {
  const decision = decideBudgetCap({ dailySpends: TEN_DAYS, realizedSpendShare: 0.3, currentDailyCapUsd: null, recommendedDailyUsd: 10, inputs: [METERED_INPUT] });
  assert.equal(decision.standing.status, 'review_only');
  assert.equal(decision.standing.certifiedForSpendChange, false);
  assert.ok(decision.standing.reasons.some((r) => /not certified/i.test(r) && /overlap/i.test(r)));
  // "Why not certified?" -- the witnesses are reachable from the surface.
  assert.equal(decision.whyNotCertified.countermodels.length, 3);
  assert.ok(decision.whyNotCertified.countermodels.every((c) => c.status === 'live' && c.excludedBy !== null));
  assert.equal(decision.whyNotCertified.invalidatingAssumptionSets.emptyBecause, 'certification_not_in_force');
  // No declared inputs is DAL-0, not "nothing contrary was found".
  const undeclared = decideBudgetCap({ dailySpends: TEN_DAYS, realizedSpendShare: 0.3, currentDailyCapUsd: null, recommendedDailyUsd: 10 });
  assert.equal(undeclared.assurance.refusal?.code, 'no_declared_inputs');
});

test('the gate can open: DAL-3 inputs and a proven certificate certify for a spend change, and still authorize nothing', () => {
  const decision = decideBudgetCap({
    dailySpends: [20, 20, 20, 20, 20], realizedSpendShare: 0.02, currentDailyCapUsd: 100, recommendedDailyUsd: 10, inputs: [DAL3_INPUT],
  });
  assert.equal(decision.assurance.meetsRequirement, true);
  assert.equal(decision.standing.status, 'certified');
  assert.equal(decision.standing.certifiedForSpendChange, true);
  assert.equal(decision.assurance.authorizesAction, false);
  assert.ok(decision.standing.reasons.some((r) => /never authoriz/i.test(r)));
  assert.equal(decision.whyNotCertified.invalidatingAssumptionSets.sets.length, 2);
});

// ---- the kernel round-trip ----------------------------------------------------

test('--apply persists a no-action certificate bundle and the read reports withdrawal state', () => {
  const store = ledger();
  const decision = decideBudgetCap({ dailySpends: TEN_DAYS, realizedSpendShare: 0.3, currentDailyCapUsd: null, recommendedDailyUsd: 10, inputs: [METERED_INPUT] });
  const issued = issueBudgetCapDecision(store, decision, { issuedAt: ISSUED_AT, windowDays: 30, spendBasis: 'live_proxy', monetaryBasis: 'effective' });
  assert.equal(issued.certificateBundle.decisionProblem.id, BUDGET_CAP_PROBLEM.id);
  assert.equal(issued.certificateBundle.actionSemantics.mode, 'no_action');
  assert.equal(issued.certificateBundle.actionSemantics.permitted, false);
  assert.equal(issued.decision, null, 'an undetermined certificate issues no decision-fitness claim');
  assert.equal(issued.observation.profile.decisionFitness, 'insufficient');
  assert.equal(issued.assurance?.consequence, 'no_action');

  const reads = readBudgetCapCertificates(store, '2026-09-11T00:00:00.000Z');
  assert.equal(reads.length, 1);
  assert.equal(reads[0]!.status, 'valid');
  assert.deepEqual(reads[0]!.invalidatedBy, []);
  assert.deepEqual(reads[0]!.pendingInvalidationBy, []);
  assert.equal(reads[0]!.canAutoAct, false);

  // Replay is idempotent; a different window is a different record, not a clobber.
  issueBudgetCapDecision(store, decision, { issuedAt: ISSUED_AT, windowDays: 30, spendBasis: 'live_proxy', monetaryBasis: 'effective' });
  assert.equal(readBudgetCapCertificates(store, '2026-09-11T00:00:00.000Z').length, 1);
  issueBudgetCapDecision(store, decision, { issuedAt: '2026-09-12T12:00:00.000Z', windowDays: 30, spendBasis: 'live_proxy', monetaryBasis: 'effective' });
  const two = readBudgetCapCertificates(store, '2026-09-13T00:00:00.000Z');
  assert.equal(two.length, 2);
  assert.equal(two[0]!.bundle.validity.issuedAt, '2026-09-12T12:00:00.000Z', 'latest first');
});

test('a booked withdrawal on the basis evidence is rendered as pending, not hidden behind valid', () => {
  const store = ledger();
  const decision = decideBudgetCap({ dailySpends: TEN_DAYS, realizedSpendShare: 0.3, currentDailyCapUsd: null, recommendedDailyUsd: 10, inputs: [METERED_INPUT] });
  const input = budgetCapIssuanceInput(decision, { issuedAt: ISSUED_AT, windowDays: 30, spendBasis: 'live_proxy', monetaryBasis: 'effective' });
  const basis = input.evidence[0]! as { id: string; record: import('../src/epistemic/evidence.ts').Evidence };
  const scheduled = { ...basis.record, revocation: { eventId: 'revoke:budget:basis', effectiveAt: '2026-09-20T00:00:00.000Z', reason: 'retention will prune the window' } };
  issueDecisionToKernel(store, { ...input, evidence: [{ id: basis.id, record: scheduled }] });

  const reads = readBudgetCapCertificates(store, '2026-09-11T00:00:00.000Z');
  assert.equal(reads[0]!.status, 'valid');
  // The closure is transitive: the basis evidence AND the observation claim
  // derived from it are booked, and neither is hidden behind `valid`.
  assert.ok(reads[0]!.pendingInvalidationBy.includes(basis.id), 'the basis evidence is named');
  assert.ok(
    reads[0]!.pendingInvalidationBy.some((id) => id.startsWith('claim:decision:utility:')),
    'the claim derived from it is named too',
  );
  assert.deepEqual(reads[0]!.invalidatedBy, [], 'nothing is withdrawn yet');
  const text = renderDecision(decision, reads);
  assert.match(text, /withdrawal booked/i);
  assert.ok(text.includes(basis.id), 'the pending id reaches the operator');

  const after = readBudgetCapCertificates(store, '2026-09-21T00:00:00.000Z');
  assert.equal(after[0]!.status, 'invalidated');
  assert.match(renderDecision(decision, after), /invalidated/i);
});

test('the renderer never presents the decision as actionable', () => {
  const decision = decideBudgetCap({ dailySpends: TEN_DAYS, realizedSpendShare: 0.3, currentDailyCapUsd: null, recommendedDailyUsd: 10, inputs: [METERED_INPUT] });
  const text = renderDecision(decision, []);
  assert.match(text, /review only/i);
  assert.match(text, /not certified/i);
  assert.match(text, /minimax regret/i);
  assert.match(text, /why not certified/i);
  assert.match(text, /not yet recorded/i);
  assert.doesNotMatch(text, /\bactionable\b/i);
});

// ---- the shared composition supplies the product's own input profiles ----------

test('budgetAdvice declares the metered series (and the realization, when present) as the decision inputs', () => {
  const store = new Store(':memory:');
  try {
    const now = Date.UTC(2026, 8, 10, 12);
    for (let day = 1; day <= 9; day += 1) store.insertRequest(request(`adv-${day}`, now - day * DAY, 4 + (day % 3)));
    const usageOnly = budgetAdvice(store, structuredClone(DEFAULT_CONFIG), { windowDays: 30, nowMs: now });
    assert.ok(usageOnly.decision);
    assert.deepEqual(usageOnly.decision.assurance.assessment.inputs.map((i) => i.id), ['claim:budget:cap:input:metered_daily_spend']);
    assert.equal(usageOnly.decision.assurance.assessment.inputs[0]!.profile.integrity, 'unknown');
    assert.equal(usageOnly.decision.standing.status, 'review_only');

    const withRealization = budgetAdvice(store, structuredClone(DEFAULT_CONFIG), {
      windowDays: 30, nowMs: now,
      realizedSpendShare: 0.5,
    });
    assert.equal(withRealization.realizedSpendShare, 0.5);
    assert.deepEqual(
      withRealization.decision!.assurance.assessment.inputs.map((i) => i.id),
      ['claim:budget:cap:input:metered_daily_spend', 'claim:budget:cap:input:realized_spend_share'],
    );
    assert.equal(withRealization.decision!.assurance.assessment.inputs[1]!.profile.monetaryBasis, 'none', 'a share is not a dollar figure');
  } finally {
    store.close();
  }
});

// ---- the terminal ----------------------------------------------------------------

let reqSeq = 0;
function request(id: string, tsEpochMs: number, costUsd: number): RequestRow {
  reqSeq += 1;
  return {
    requestId: `${id}-${reqSeq}`, sessionId: null, tsEpochMs, provider: 'openai', model: 'gpt-4o', project: 'p', taskWeight: 1,
    inputTokens: 100, outputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, costUsd,
    estimated: false, streamed: true, statusCode: 200, durationMs: 100, via: 'proxy',
  };
}

function runCli(args: string[], dbPath: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, SEGREANT_DB: dbPath, NODE_OPTIONS: '' } }, (err, stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? (err as unknown as { code: number }).code : err ? 1 : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

test('segreant budget --recommend shows the decision review-only, and --apply is refused until it is certified at DAL-3', async () => {
  const home = mkdtempSync(join(tmpdir(), 'segreant-cap-cli-'));
  const dbPath = join(home, 'cap.db');
  try {
    const seed = new Store(dbPath);
    try {
      const now = Date.now();
      for (let day = 1; day <= 9; day += 1) seed.insertRequest(request(`cli-${day}`, now - day * DAY, 3 + (day % 4)));
    } finally {
      seed.close();
    }
    const preview = await runCli(['budget', '--recommend'], dbPath);
    assert.equal(preview.code, 0, preview.stderr);
    assert.match(preview.stdout, /Recommended daily cap/);
    assert.match(preview.stdout, /Decision/);
    assert.match(preview.stdout, /review only/i);
    assert.match(preview.stdout, /minimax regret/i);
    assert.match(preview.stdout, /why not certified/i);
    assert.match(preview.stdout, /not yet recorded/i);
    // D-213: a review-only decision cannot be applied, and the surface says so instead of inviting --apply.
    assert.doesNotMatch(preview.stdout, /Re-run with --apply/);
    assert.match(preview.stdout, /No cap written/);

    const asJson = await runCli(['budget', '--recommend', '--json'], dbPath);
    assert.equal(asJson.code, 0, asJson.stderr);
    const payload = JSON.parse(asJson.stdout) as { decision: { standing: { status: string }; certificates: unknown[] } | null };
    assert.equal(payload.decision?.standing.status, 'review_only');
    assert.deepEqual(payload.decision?.certificates, []);

    // --apply on a review-only decision is REFUSED (D-213 × D-220): nothing is
    // written to config and no certificate is recorded, and the refusal names
    // the observed level and standing rather than only the requirement.
    const applied = await runCli(['budget', '--recommend', '--apply', '--json'], dbPath);
    assert.equal(applied.code, 1);
    const refusal = JSON.parse(applied.stdout) as {
      applied: boolean; error: string; requiredAssurance: string; observedAssurance: string; standing: string; reasons: string[];
    };
    assert.equal(refusal.applied, false);
    assert.equal(refusal.error, 'decision_certificate_required');
    assert.equal(refusal.requiredAssurance, 'DAL-3');
    assert.equal(refusal.observedAssurance, 'DAL-0');
    assert.equal(refusal.standing, 'review_only');
    assert.ok(refusal.reasons.length >= 1);

    const again = await runCli(['budget', '--recommend', '--json'], dbPath);
    assert.equal(again.code, 0, again.stderr);
    const after = JSON.parse(again.stdout) as { decision: { certificates: unknown[] } | null };
    assert.deepEqual(after.decision?.certificates, [], 'a refused apply must record no certificate');
    const cfgPath = join(process.env.SEGREANT_HOME!, 'config.json');
    const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8')) as { budget?: { dailyUsd?: number | null } } : {};
    assert.ok(cfg.budget?.dailyUsd === undefined || cfg.budget.dailyUsd === null, 'a refused apply must write no cap');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// D-249: the cap decision is the product's one utility problem, and it goes
// through the engine's representation layer (F01) and its admissible
// preference set diagnostic (F03) rather than restating either.
// ---------------------------------------------------------------------------

test('the cap decision normalizes its intervals through buildUtilityIntervalProblem and reports the representation', () => {
  const decision = decideBudgetCap({ dailySpends: [10, 12, 30, 9, 11], realizedSpendShare: 0.5, currentDailyCapUsd: null, recommendedDailyUsd: 15 });
  assert.equal(decision.utilityProblem.uncertainty, 'explicit_intervals');
  assert.deepEqual(decision.utilityProblem.intervals, decision.intervals);
});

test('the cap decision evaluates a declared admissible preference set and never lets it change standing', () => {
  const decision = decideBudgetCap({ dailySpends: [10, 12, 30, 9, 11], realizedSpendShare: null, currentDailyCapUsd: null, recommendedDailyUsd: 15 });
  const pref = decision.preference;
  assert.equal(pref.rule, 'admissible_preference_set');
  assert.ok(pref.preferenceIds.length >= 4, 'the admissible set is declared, finite, and more than the objective alone');
  assert.ok(pref.preferenceIds.every((id) => BUDGET_CAP_ADMISSIBLE_PREFERENCES.some((p) => p.id === id)));
  assert.deepEqual(pref.actionSet, ['apply_recommended', 'keep_current']);
  // Unobserved realization: the optimistic and pessimistic preferences disagree.
  assert.equal(pref.status, 'preference_sensitive');
  assert.equal(decision.standing.status, 'review_only');
  for (const p of BUDGET_CAP_ADMISSIBLE_PREFERENCES) assert.ok(p.rationale.length > 20, `${p.id} states why it is admissible`);
  // The robustness diagnostic is rendered, as a diagnostic.
  const text = renderDecision(decision, []);
  assert.match(text, /Preference\s+preference_sensitive/);
  assert.match(text, /not a recommendation/);
});
