/**
 * Value/RoI command cluster — yield, realize, report, exec, usage, roi,
 * budget-advisor, and frontier. Extracted verbatim from cli.ts in the
 * per-command-module split; these are the commands that read the realization
 * funnel, Lift, and RoI engines and present them honestly.
 */

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Store } from '../store/db.ts';
import { loadConfig, saveConfig, dbPath, isDemo, DEFAULT_CONFIG } from '../config.ts';
import { demoLiftOptions } from '../demo/seed.ts';
import { isGitRepo, projectName, resolveCommit } from '../git/correlate.ts';
import { computeQuality } from '../git/quality.ts';
import { loadRealization, liftOptionsFromStore, moneyInputsFromStore } from '../value/realization.ts';
import { computeReturnOnIntelligence } from '../value/lenses.ts';
import { boundedLift } from '../value/lift.ts';
import { resolveBaselineMinutesForRepo } from '../value/liftBaseline.ts';
import { computeFrontier } from '../value/frontier.ts';
import { computeUsageRoI } from '../value/usage.ts';
import { recommendBudget } from '../budget/recommend.ts';
import { recommendAllocation } from '../budget/allocate.ts';
import { shadowPriceOfIntelligence, estimateBetaFromPairs } from '../value/marginal.ts';
import { goodhartStreams } from '../value/drift.ts';
import { instrumentationPriority } from '../value/voi.ts';
import { estimateBetaPrior, shrinkRate } from '../value/reliability.ts';
import { GATE_LADDER, GATE_META } from '../value/gates.ts';
import { C, color, usd, num, pct, glyph, noteSource, printNotAGitRepo } from './ui.ts';
import { type Flags } from './flags.ts';

export async function cmdYield(flags: Flags): Promise<void> {
  const repo = (flags.repo as string) ?? process.cwd();
  const limit = flags.limit ? Number(flags.limit) : 30;
  const windowDays = flags.window ? Number(flags.window) : 14;
  if (!(await isGitRepo(repo))) {
    printNotAGitRepo(repo);
    process.exitCode = 1;
    return;
  }
  const store = new Store(dbPath());
  const report = await computeQuality(store, repo, { limit, windowDays, persist: true });

  if (flags.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    store.close();
    return;
  }

  const tty = process.stdout.isTTY ?? false;
  const m = report.matured;
  console.log('');
  console.log(color(tty, C.bold, '  AI Yield — durable output per dollar of AI spend'));
  console.log(color(tty, C.gray, `  Survival measured to date · ${m.commits} matured commits (older than ${windowDays}d)`));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(64)));
  if (m.commits === 0) {
    console.log(color(tty, C.gray, `  No commits older than ${windowDays}d yet — yield needs time to mature.`));
    console.log(color(tty, C.gray, '  Recent commits below are provisional (survival still settling).'));
  } else {
    const yieldStr = m.aiYield === null ? 'n/a (no AI cost attributed)' : `${m.aiYield.toFixed(1)} surviving lines / $`;
    console.log(`  ${color(tty, C.bold, 'AI Yield')}            ${color(tty, C.green, yieldStr)}`);
    console.log(`  Effective spend     ${m.effectiveSpendRatio === null ? '—' : color(tty, m.effectiveSpendRatio > 0.5 ? C.green : C.yellow, pct(m.effectiveSpendRatio))}   ${color(tty, C.gray, 'of $ landed in durable code')}`);
    console.log(`  Code survival       ${color(tty, m.survivalRatio > 0.7 ? C.green : C.yellow, pct(m.survivalRatio))}   ${color(tty, C.gray, `churn ${pct(m.churnRatio)}`)}`);
    console.log(`  Revert rate         ${color(tty, m.revertRate < 0.05 ? C.green : C.red, pct(m.revertRate))}`);
    console.log(`  AI cost (matured)   ${usd(m.totalCostUsd)}   ${color(tty, C.gray, `${num(m.survivingLines)} surviving lines`)}`);
    if (m.costPerSurvivingLine !== null) {
      console.log(`  Cost / durable line ${usd(m.costPerSurvivingLine)}`);
    }
  }

  console.log('');
  console.log(color(tty, C.bold, '  Per commit'));
  console.log(color(tty, C.gray, '  commit    age    cost       +lines  survived   churn   yield   status'));
  for (const c of report.commits.slice(0, 18)) {
    const short = c.hash.slice(0, 7);
    const age = c.ageDays < 1 ? `${Math.round(c.ageDays * 24)}h` : `${Math.round(c.ageDays)}d`;
    const surv = `${c.survivingLines}/${c.linesAdded}`;
    const churn = pct(c.churnRatio);
    const yld = c.aiYield === null ? '—' : c.aiYield.toFixed(0);
    const status = c.reverted
      ? color(tty, C.red, 'REVERTED')
      : c.maturing
        ? color(tty, C.yellow, 'maturing')
        : color(tty, C.green, 'matured');
    console.log(
      `  ${short}  ${age.padStart(4)}  ${usd(c.attributedCostUsd).padStart(9)}  ${String(c.linesAdded).padStart(6)}  ${surv.padStart(9)}  ${churn.padStart(5)}  ${yld.padStart(5)}   ${status}`,
    );
  }
  console.log('');
  console.log(color(tty, C.gray, '  Yield = surviving lines ÷ AI cost. A coaching signal, not a leaderboard —'));
  console.log(color(tty, C.gray, '  read it as a team trend, never a per-developer ranking. (docs/RESEARCH-REVIEW.md)'));
  console.log('');
  store.close();
}

export async function cmdRealize(flags: Flags): Promise<void> {
  const repo = (flags.repo as string) ?? process.cwd();
  const limit = flags.limit ? Number(flags.limit) : 30;
  const windowDays = flags.window ? Number(flags.window) : 14;
  const store = new Store(dbPath());
  const loaded = await loadRealization(store, repo, { limit, windowDays, persist: true });
  if (!loaded) {
    printNotAGitRepo(repo);
    process.exitCode = 1;
    store.close();
    return;
  }
  const report = loaded.report;

  if (flags.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    store.close();
    return;
  }

  const tty = process.stdout.isTTY ?? false;
  const m = report.matured;
  const wiredGates = GATE_LADDER.filter((g) => m.instrumentation[g] > 0).length;

  console.log('');
  console.log(color(tty, C.bold, '  The Realization Standard — did AI spend become real outcomes?'));
  console.log(color(tty, C.gray, `  ${m.units} matured units (older than ${windowDays}d) · ${wiredGates} of ${GATE_LADDER.length} gates instrumented`));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(64)));
  noteSource(tty, loaded.source, loaded.report.projectScoped);

  if (m.units === 0) {
    console.log(color(tty, C.gray, `  No units older than ${windowDays}d yet — realization needs the window to elapse.`));
  } else {
    const rr = pct(m.realizationRate);
    const rv = m.realizedValueRate === null ? '—' : pct(m.realizedValueRate);
    console.log(`  ${color(tty, C.bold, 'Realization Rate')}    ${color(tty, m.realizationRate > 0.6 ? C.green : C.yellow, rr.padStart(4))}   ${color(tty, C.gray, 'production — units that reached verified durable value')}`);
    // The partial-ID interval: confirmed-realized up to not-observed-dead. Shown
    // whenever unobserved gates leave real width, so the confirmed rate is never
    // mistaken for the whole story (nor a perfect progress score for realization).
    if (m.realizationBounds.upper - m.realizationBounds.lower > 0.005) {
      console.log(color(tty, C.gray, `                      confirmed ${pct(m.realizationBounds.lower)} – not-observed-dead ${pct(m.realizationBounds.upper)}; the gap is the unmeasured region — wire more gates to close it`));
    }
    if (m.serial.sG !== null && m.serial.skipped.length > 0) {
      console.log(color(tty, C.gray, `                      survival chain ${pct(m.serial.sG)} over ${m.serial.included.length}/${GATE_LADDER.length} observed stages (unobserved: ${m.serial.skipped.join(', ')})`));
    }
    console.log(`  Realized Value      ${color(tty, C.green, usd(m.realizedValueUsd))} / ${usd(m.totalCostUsd)}  ${color(tty, C.gray, `(${rv})  the money lens`)}`);
    console.log(`  Net of rework       ${color(tty, C.green, usd(m.netRealizedValueUsd))}  ${color(tty, C.gray, 'realized value after first-pass acceptance — reworked output is worth less')}`);
  }
  const fpa = report.firstPassAcceptance;
  console.log(`  First-Pass Accept.  ${fpa === null ? color(tty, C.gray, 'n/a (no proposals captured)') : color(tty, fpa > 0.7 ? C.green : C.yellow, pct(fpa).padStart(4)) + color(tty, C.gray, '   collaboration — of AI-proposed lines, how much shipped')}`);

  // Waste P&L
  if (m.wasteByStage.length) {
    console.log('');
    console.log(color(tty, C.bold, '  Where the spend went (P&L)'));
    for (const b of m.wasteByStage) {
      const label = b.stage === 'realized' ? 'realized ✓' : b.stage === 'unverified' ? 'unverified' : `died at ${b.stage}`;
      const isGood = b.stage === 'realized';
      console.log(`    ${label.padEnd(20)} ${color(tty, isGood ? C.green : C.yellow, usd(b.costUsd).padStart(10))}   ${color(tty, C.gray, `${b.units} unit${b.units === 1 ? '' : 's'}`)}`);
    }
  }

  // Gate coverage
  console.log('');
  console.log(color(tty, C.bold, '  Gate coverage') + color(tty, C.gray, '   (wire more with: fiscus report)'));
  for (const g of GATE_LADDER) {
    const n = m.instrumentation[g];
    const meta = GATE_META[g];
    const awaiting = meta.source === 'signal' ? 'awaiting CI/deploy signal' : `awaiting ${meta.source} capture`;
    const state = n > 0 ? color(tty, C.green, `wired · ${n}/${m.units}`) : color(tty, C.gray, awaiting);
    console.log(`    ${meta.label.padEnd(11)} ${state}`);
  }

  // Per unit
  console.log('');
  console.log(color(tty, C.bold, '  Per unit') + color(tty, C.gray, `   funnel: ${GATE_LADDER.map((g) => g[0]).join(' ')}  (✓pass ✗fail ·unknown)`));
  for (const u of report.units.slice(0, 16)) {
    const short = u.hash.slice(0, 7);
    const age = u.ageDays < 1 ? `${Math.round(u.ageDays * 24)}h` : `${Math.round(u.ageDays)}d`;
    const acc = u.acceptance === null ? '  —' : pct(u.acceptance).padStart(3);
    const funnel = u.funnel.results.map((r) => glyph(tty, r.verdict)).join(' ');
    const status = u.maturing
      ? color(tty, C.yellow, 'maturing')
      : u.funnel.realized
        ? color(tty, C.green, 'REALIZED')
        : color(tty, C.red, `died:${u.funnel.diedAt ?? '—'}`);
    console.log(`    ${short}  ${age.padStart(4)}  ${usd(u.attributedCostUsd).padStart(9)}  acc ${acc}  ${funnel}  ${status}`);
  }
  console.log('');
  console.log(color(tty, C.gray, '  Production is dollar-free (Realization Rate); cost is a lens on top. See docs/THE-STANDARD.md'));
  console.log('');
  store.close();
}

export async function cmdReport(flags: Flags): Promise<void> {
  const kind = String(flags.kind ?? '');
  const codeKinds = ['tested', 'merged', 'shipped', 'incident'];
  const usageKinds = ['used', 'resolved', 'published', 'accepted', 'redone', 'discarded'];
  const allowed = [...codeKinds, ...usageKinds];
  if (!allowed.includes(kind)) {
    console.error(`  Usage: fiscus report --kind <${allowed.join('|')}>`);
    console.error('         code:  --commit <hash>      non-code:  --session <id>      [--verdict pass|fail] [--detail "..."]');
    process.exitCode = 1;
    return;
  }
  const negative = ['incident', 'redone', 'discarded'].includes(kind);
  const verdict = negative ? 'fail' : String(flags.verdict ?? 'pass') === 'fail' ? 'fail' : 'pass';
  const tty = process.stdout.isTTY ?? false;

  // Resolve the ref: a git commit (code) or a session id (non-code).
  let ref: string | null = null;
  let project = 'default';
  if (flags.commit) {
    const repo = (flags.repo as string) ?? process.cwd();
    if (!(await isGitRepo(repo))) {
      printNotAGitRepo(repo);
      process.exitCode = 1;
      return;
    }
    ref = await resolveCommit(repo, String(flags.commit));
    if (!ref) {
      console.error(`  Could not resolve commit: ${String(flags.commit)}`);
      process.exitCode = 1;
      return;
    }
    project = await projectName(repo);
  } else if (flags.session) {
    ref = String(flags.session);
  } else if (usageKinds.includes(kind)) {
    console.error('  Non-code outcomes need --session <id>.');
    process.exitCode = 1;
    return;
  }

  const store = new Store(dbPath());
  store.insertSignal({
    signalId: randomUUID(),
    kind,
    commitHash: ref,
    project,
    tsEpochMs: Date.now(),
    verdict,
    detail: flags.detail ? String(flags.detail) : null,
  });
  console.log('');
  console.log(`  Recorded ${color(tty, C.bold, kind)} = ${verdict}` + (ref ? ` for ${ref.slice(0, 12)}` : ' (project-wide)'));
  console.log(color(tty, C.gray, '  It resolves the matching gate on the next "fiscus realize" / "usage".'));
  console.log('');
  store.close();
}

export async function cmdUsage(flags: Flags): Promise<void> {
  const cfg = loadConfig();
  const store = new Store(dbPath());
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const days = flags.days ? Number(flags.days) : 30;
  // Money inputs: org-disclosed outcome baselines + labor rate. The demo assumes
  // illustrative values (clearly labeled) so the dollar face is visible there.
  let laborRate = cfg.lift.laborRatePerHour;
  let outcomeBaselines = cfg.lift.outcomeBaselineMinutes;
  if (isDemo()) {
    if (laborRate === null) laborRate = 120;
    if (Object.keys(outcomeBaselines).length === 0) outcomeBaselines = { used: 10, resolved: 30, published: 90 };
  }
  const rep = computeUsageRoI(store, {
    startMs: now - days * dayMs,
    endMs: now + 1000,
    money: { outcomeBaselineMinutes: outcomeBaselines, laborRatePerHour: laborRate },
  });

  if (flags.json) {
    process.stdout.write(JSON.stringify(rep, null, 2) + '\n');
    store.close();
    return;
  }

  const tty = process.stdout.isTTY ?? false;
  console.log('');
  console.log(color(tty, C.bold, '  Return on Intelligence — usage without code signals (chat, research, drafting)'));
  console.log(color(tty, C.gray, `  ${rep.units.length} sessions · outcomes via "fiscus report --session <id> --kind used|resolved|…"`));
  console.log(color(tty, C.gray, '  Scores sessions with no captured code proposals. A CODING session lands here too'));
  console.log(color(tty, C.gray, '  when its tool never reports diffs — route it through the proxy to move it to git RoI.'));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(64)));
  if (rep.units.length === 0) {
    console.log(color(tty, C.gray, '  No sessions without code signals in range. Tag sessions with X-Aegis-Session-Id to measure them.'));
    console.log('');
    store.close();
    return;
  }
  const idx = rep.roi.roiIndex;
  console.log(`  RoI Index           ${idx === null ? color(tty, C.gray, 'n/a') : color(tty, idx > 60 ? C.green : C.yellow, `${idx.toFixed(0)} / 100`)}`);
  console.log(`  Realized            ${rep.realizedUnits}/${rep.units.length} sessions   ${color(tty, C.gray, `${usd(rep.totalCostUsd)} total`)}`);
  if (rep.roi.realizationInterval) {
    const ci = rep.roi.realizationInterval;
    console.log(color(tty, C.gray, `                      ${pct(ci.low)}–${pct(ci.high)} anytime-valid ${Math.round(ci.level * 100)}% — valid at every glance, not just once`));
  }
  // The money face — only when the org disclosed outcome baselines + a rate.
  const rr = rep.roi.returnRatio;
  if (rep.money.priced && rr.basis === 'usd' && rr.grossRatio !== null) {
    const head = rr.causalRatio ?? rr.grossRatio;
    console.log(`  RoI return          ${color(tty, head >= 1 ? C.green : C.red, head.toFixed(2) + '×')}   ${color(tty, C.gray, `${head >= 1 ? 'pays for itself' : 'below break-even'} — outcomes priced by your disclosed baselines${isDemo() ? ' (demo: illustrative baselines)' : ''}`)}`);
  } else if (rep.realizedUnits > 0) {
    console.log(color(tty, C.gray, '                      dollar return un-priced — set lift.outcomeBaselineMinutes + laborRatePerHour to price outcomes'));
  }
  // Reach breakdown — the grade, not a flat "positive". Further-reaching outcomes
  // weigh more in Impact, so this is where non-coding value actually differentiates.
  const m = rep.outcomeMix;
  const reached = m.published + m.resolved + m.used;
  if (reached > 0) {
    const parts: string[] = [];
    if (m.published > 0) parts.push(color(tty, C.green, `${m.published} published`));
    if (m.resolved > 0) parts.push(color(tty, C.cyan, `${m.resolved} resolved`));
    if (m.used > 0) parts.push(`${m.used} used`);
    console.log(`  Reach               ${parts.join(color(tty, C.gray, ' · '))}${m.none > 0 ? color(tty, C.gray, ` · ${m.none} no outcome yet`) : ''}`);
  }
  // VoI: which measurement to buy next for this modality.
  const usageVoi = instrumentationPriority(rep.roi);
  if (usageVoi.length > 0 && rep.roi.roiIndex !== null) {
    const top = usageVoi[0]!;
    console.log(`  Instrument next     ${color(tty, C.cyan, top.lens)}   ${color(tty, C.gray, `largest unmeasured exposure — at a mid ${top.reference} the Index moves ${rep.roi.roiIndex.toFixed(0)} → ${top.indexAtReference.toFixed(0)}`)}`);
  }
  console.log('');
  for (const n of rep.roi.notes) console.log(color(tty, C.gray, `  · ${n}`));
  console.log('');
  console.log(color(tty, C.gray, '  Acceptance/survival are n/a for non-code (no diff, no git) — realized = a reported,'));
  console.log(color(tty, C.gray, '  no-incident outcome. Wire outcomes to move sessions from unknown to realized.'));
  console.log('');
  store.close();
}

export async function cmdRoi(flags: Flags): Promise<void> {
  const repo = (flags.repo as string) ?? process.cwd();
  const windowDays = flags.window ? Number(flags.window) : 14;
  const cfg = loadConfig();
  // Labor rate prices both the effort tax and the money number's denominator.
  // Falls back to config; in the demo we assume an illustrative rate so the dollar
  // return is visible (clearly labeled), since the demo has no real org rate.
  let laborRate = flags['labor-rate'] !== undefined ? Number(flags['labor-rate']) : cfg.lift.laborRatePerHour;
  if (laborRate === null && isDemo()) laborRate = 120;
  const riskAversion = flags['risk'] !== undefined ? Number(flags['risk']) : 0;
  const store = new Store(dbPath());
  const loaded = await loadRealization(store, repo, { windowDays, persist: true });
  if (!loaded) {
    printNotAGitRepo(repo);
    process.exitCode = 1;
    store.close();
    return;
  }
  const report = loaded.report;
  // The manual-minutes-per-task-type input, resolved from three sources in
  // priority order (never silent about which one won, per-task-type):
  //   1. an explicit user override in config — always respected
  //   2. THIS project's own pre-AI-tracking git history, shrunk toward #3
  //   3. a cited, refreshable METR-anchored population prior
  // Demo mode skips git entirely (the seeded snapshots aren't this checkout's
  // real history) and uses the population prior + config as-is.
  const project = isDemo() ? 'demo' : await projectName(repo);
  const resolvedBaseline = isDemo()
    ? { minutes: cfg.lift.baselineMinutes, minutesLow: cfg.lift.baselineMinutes, minutesHigh: cfg.lift.baselineMinutes, basis: {}, notes: [] as string[] }
    : await resolveBaselineMinutesForRepo(store, repo, project, cfg.lift.baselineMinutes, DEFAULT_CONFIG.lift.baselineMinutes);
  // Lift source, in priority order — self-report is NEVER accepted:
  //   1. --tsf <x>   an externally measured TSF (transcript judge / RCT) — gold standard
  //   2. demo mode   a labeled synthetic TSF, so the interval shows in the demo
  //   3. real data   measured "time with AI" × resolved task baselines (the
  //                  default real path; uninstrumented if there's no measured time
  //                  or no baselined realized work)
  let liftOpts: { lift: number | null; liftRange: { low: number | null; high: number | null }; liftHow: string };
  let liftNotes: string[];
  if (flags.tsf !== undefined) {
    const e = boundedLift({ tsfUpperBound: Number(flags.tsf) });
    liftOpts = { lift: e.lensScore, liftRange: { low: e.lensLow, high: e.lensHigh }, liftHow: 'externally measured TSF (transcript judge / A-B)' };
    liftNotes = e.notes;
  } else if (isDemo()) {
    liftOpts = { ...demoLiftOptions(), liftHow: 'labeled synthetic TSF (demo stand-in for a real A-B)' };
    liftNotes = ['Demo: Lift uses a synthetic TSF stand-in for a real transcript-judge / A-B measurement.'];
  } else {
    const dl = liftOptionsFromStore(store, report, resolvedBaseline.minutes, { low: resolvedBaseline.minutesLow, high: resolvedBaseline.minutesHigh });
    liftOpts = { lift: dl.lift, liftRange: dl.liftRange, liftHow: 'measured time-with-AI × resolved task baselines (estimate, not a controlled A/B)' };
    liftNotes = [...dl.notes, ...resolvedBaseline.notes];
  }
  // The money number's inputs, measured from the same data the lenses use (shared
  // with the dashboard via moneyInputsFromStore, so both price the return identically).
  const { grossRealizedValueUsd, supervisionMinutes } = moneyInputsFromStore(store, report, resolvedBaseline.minutes, laborRate);

  const roi = computeReturnOnIntelligence(report, {
    laborRatePerHour: laborRate,
    grossRealizedValueUsd,
    supervisionMinutes,
    riskAversion,
    ...liftOpts,
  });
  roi.notes.unshift(...liftNotes);

  // Goodhart drift alarm (docs §11): is a rate being BENT? Three anytime-valid
  // e-processes over mature units in time order — realization, acceptance, and
  // hard-gate coverage (each stream needs ≥10 observed points; silent below
  // that, honestly). The PATTERN across streams is the tell: acceptance rising
  // while realization stagnates = proposal inflation; hard-gate unknowns rising
  // while the headline holds = coverage suppression.
  const matureOrdered = report.units.filter((u) => !u.maturing).sort((a, b) => a.tsEpochMs - b.tsEpochMs);
  const driftStreams = goodhartStreams(matureOrdered.map((u) => u.funnel));
  // Back-compat: `drift` stays the realization stream's report, as before.
  const drift = driftStreams.find((s) => s.stream === 'realization')?.report ?? null;
  // VoI (docs §12): which measurement to buy next — the un-instrumented lens
  // whose measurement would move the Index most, at a disclosed mid reference.
  const voi = instrumentationPriority(roi);

  if (flags.json) {
    process.stdout.write(JSON.stringify({ ...roi, drift, driftStreams, instrumentNext: voi }, null, 2) + '\n');
    store.close();
    return;
  }

  const tty = process.stdout.isTTY ?? false;
  console.log('');
  console.log(color(tty, C.bold, '  Return on Intelligence — how much you actually got from the AI'));
  console.log(color(tty, C.gray, `  ${Math.round(roi.coverage * 4)} of 4 value lenses instrumented · docs/RETURN-ON-INTELLIGENCE.md`));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(64)));
  noteSource(tty, loaded.source, loaded.report.projectScoped);

  const idx = roi.roiIndex;
  const iv = roi.roiInterval;
  const hasBand = iv.low !== null && iv.high !== null && idx !== null && (iv.high - iv.low) > 0.5;
  const band = hasBand ? color(tty, C.gray, `  [${iv.low!.toFixed(0)}–${iv.high!.toFixed(0)}]`) : '';
  console.log(`  ${color(tty, C.bold, 'RoI Index')}           ${idx === null ? color(tty, C.gray, 'n/a (no lenses instrumented)') : color(tty, idx > 60 ? C.green : idx > 30 ? C.yellow : C.red, `${idx.toFixed(0)} / 100`)}${band}   ${color(tty, C.gray, hasBand ? 'point in a partially-identified interval' : 'geometric mean — no axis can carry it alone')}`);
  if (roi.indexIsUpperBound && idx !== null) {
    console.log(color(tty, C.gray, `  ${''.padEnd(20)}↑ upper bound — wiring more lenses can only lower it toward the truth`));
  }
  const eff = roi.realizedEfficiency;
  console.log(`  Realized efficiency  ${eff === null ? '—' : color(tty, C.green, pct(eff))}   ${color(tty, C.gray, `of $${(roi.tokenCostUsd + roi.effortTaxUsd).toFixed(2)} spent (tokens${roi.effortTaxUsd > 0 ? ' + effort' : ''})`)}`);

  // The money number — value ÷ cost, ≥1 ⟺ it paid for itself.
  const rr = roi.returnRatio;
  if (rr.basis === 'usd' && rr.grossRatio !== null) {
    const headline = rr.causalRatio ?? rr.grossRatio;
    const col = headline >= 1 ? C.green : C.red;
    const band =
      rr.causalRange.low !== null && rr.causalRange.high !== null
        ? color(tty, C.gray, ` [${rr.causalRange.low.toFixed(2)}–${rr.causalRange.high.toFixed(2)}×]`)
        : '';
    const tail = (headline >= 1 ? 'pays for itself' : 'below break-even') + (rr.causalRatio === null ? ' (gross — wire Lift to credit the counterfactual)' : '');
    console.log(`  ${color(tty, C.bold, 'RoI return')}           ${color(tty, col, headline.toFixed(2) + '×')}${band}   ${color(tty, C.gray, tail)}`);
    console.log(color(tty, C.gray, `  ${''.padEnd(20)}$${(rr.realizedValueUsd ?? 0).toFixed(0)} realized work (manual-equiv, net of rework) ÷ $${rr.costUsd.toFixed(2)} cost (tokens + your time)`));
  } else if (rr.realizedValueUsd !== null && !rr.supervisionPriced) {
    console.log(`  ${color(tty, C.bold, 'RoI return')}           ${color(tty, C.gray, 'un-priced — wire proxy traffic so your time-with-AI can be measured')}`);
  } else {
    console.log(`  ${color(tty, C.bold, 'RoI return')}           ${color(tty, C.gray, 'pass --labor-rate (or set lift.laborRatePerHour) to price the dollar return')}`);
  }
  const ce = roi.certaintyEquivalent;
  if (ce.riskAversion > 0 && ce.index !== null) {
    console.log(`  Risk-adjusted Index  ${color(tty, C.yellow, `${ce.index.toFixed(0)} / 100`)}   ${color(tty, C.gray, `γ=${ce.riskAversion.toFixed(2)} conservative read — toward the partial-ID lower bound`)}`);
  }

  console.log('');
  console.log(color(tty, C.bold, '  Value lenses'));
  const lensRow = (name: string, l: { value: number | null; instrumented: boolean; how: string }) => {
    const v = l.value === null ? color(tty, C.gray, 'uninstrumented') : color(tty, l.value > 0.6 ? C.green : l.value > 0.3 ? C.yellow : C.red, pct(l.value).padStart(4));
    console.log(`    ${name.padEnd(13)} ${v}   ${color(tty, C.gray, l.how)}`);
  };
  lensRow('Realization', roi.lenses.realization);
  if (roi.realizationInterval) {
    const ci = roi.realizationInterval;
    console.log(color(tty, C.gray, `                  ${pct(ci.low)}–${pct(ci.high)} anytime-valid ${Math.round(ci.level * 100)}% — safe to watch continuously and act on at any moment`));
  }
  lensRow('Acceptance', roi.lenses.acceptance);
  lensRow('Lift', roi.lenses.lift);
  lensRow('Impact', roi.lenses.impact);

  // Stability: the Goodhart alarms. Each detects that a rate MOVED, not why —
  // gaming and a genuine regime change both trip them; their job is to force the
  // question, and each firing stream carries its own typical reading.
  if (driftStreams.length > 0) {
    console.log('');
    const firing = driftStreams.filter((s) => s.report.alarm);
    if (firing.length > 0) {
      for (const s of firing) {
        console.log(`  ${color(tty, C.bold, 'Stability')}            ${color(tty, C.red, 'DRIFT DETECTED')}   ${color(tty, C.gray, `${s.stream} moved ${pct(s.report.overallRate ?? 0)} → ${pct(s.report.recentRate ?? 0)} recently (anytime-valid, α=${s.report.alpha})`)}`);
        console.log(color(tty, C.gray, `                       ${s.reading}`));
      }
    } else {
      const watched = driftStreams.map((s) => s.stream).join(', ');
      console.log(`  ${color(tty, C.bold, 'Stability')}            ${color(tty, C.green, 'stable')}   ${color(tty, C.gray, `no drift across ${driftStreams.length} watched stream(s): ${watched} (anytime-valid)`)}`);
    }
  }

  // VoI: name the next measurement worth buying, with the exposure quantified.
  if (voi.length > 0 && roi.roiIndex !== null) {
    const top = voi[0]!;
    console.log('');
    console.log(
      `  ${color(tty, C.bold, 'Instrument next')}      ${color(tty, C.cyan, top.lens)}   ` +
        color(
          tty,
          C.gray,
          `largest unmeasured exposure: measured at a mid ${top.reference}, the Index moves ${roi.roiIndex.toFixed(0)} → ${top.indexAtReference.toFixed(0)} — measuring only makes the number more honest`,
        ),
    );
  }

  if (roi.notes.length) {
    console.log('');
    for (const n of roi.notes) console.log(color(tty, C.gray, `  · ${n}`));
  }
  console.log('');
  store.close();
}

export async function cmdBudgetAdvisor(flags: Flags): Promise<void> {
  const cfg = loadConfig();
  const store = new Store(dbPath());
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const days = flags.days ? Number(flags.days) : 30;
  const series = store.series(now - days * dayMs, now + 1000, dayMs);
  const dailySpends = series.map((s) => s.costUsd);

  let realizedValueRate: number | null = null;
  let frontierCells: ReturnType<typeof computeFrontier>['byModelAndTask'] = [];
  const repo = flags.repo as string | undefined;
  const loadedValue = await loadRealization(store, repo, { persist: false });
  if (loadedValue) {
    realizedValueRate = loadedValue.report.matured.realizedValueRate;
    frontierCells = computeFrontier(loadedValue.report.units).byModelAndTask;
  }

  const rec = recommendBudget({ dailySpends, realizedValueRate, frontier: frontierCells });
  // Forward-looking allocation: re-weight the same budget by return + quantify the moves.
  const allocation =
    frontierCells.length >= 2
      ? recommendAllocation(
          frontierCells.map((c) => ({ key: c.key, costUsd: c.costUsd, roiIndex: c.roiIndex, realizedValueUsd: c.netRealizedValueUsd })),
        )
      : null;

  // The shadow price of intelligence — what one more AI dollar returns, optimally
  // deployed. Reliability-adjust each context's value first (empirical-Bayes
  // shrinkage of its realization rate) so a noisy 2-unit cell can't distort the
  // optimum. (docs/RETURN-ON-INTELLIGENCE.md §8–9.)
  let shadow: ReturnType<typeof shadowPriceOfIntelligence> | null = null;
  let betaEstimate: ReturnType<typeof estimateBetaFromPairs> | null = null;
  if (frontierCells.length >= 2) {
    // β from the org's OWN curvature when history supports it: the same contexts
    // observed in the window's two halves; within-context slopes cancel context
    // quality, so heterogeneous contexts can't bias the elasticity. Falls back to
    // the disclosed planning default (0.5) when not estimable. (docs §9.)
    const units = loadedValue!.report.units;
    let betaOpts: { beta?: number; betaHow?: string } = {};
    if (units.length >= 6) {
      const ts = units.map((u) => u.tsEpochMs).sort((a, b) => a - b);
      const cut = ts[ts.length >> 1]!;
      const early = computeFrontier(units.filter((u) => u.tsEpochMs < cut)).byModelAndTask;
      const late = new Map(computeFrontier(units.filter((u) => u.tsEpochMs >= cut)).byModelAndTask.map((c) => [c.key, c]));
      const pairs = early.flatMap((c) => {
        const l = late.get(c.key);
        return l ? [{ key: c.key, spend1: c.costUsd, value1: c.netRealizedValueUsd, spend2: l.costUsd, value2: l.netRealizedValueUsd }] : [];
      });
      betaEstimate = estimateBetaFromPairs(pairs);
      if (betaEstimate.beta !== null) betaOpts = { beta: betaEstimate.beta, betaHow: betaEstimate.how };
    }
    const prior = estimateBetaPrior(frontierCells.map((c) => ({ k: Math.round(c.realizationRate * c.units), n: c.units })));
    const marginalCells = frontierCells.map((c) => {
      const shrunk = shrinkRate(Math.round(c.realizationRate * c.units), c.units, prior);
      const adj = c.realizationRate > 0 ? shrunk / c.realizationRate : 1; // scale value by the reliable/raw ratio
      return { key: c.key, costUsd: c.costUsd, realizedValueUsd: c.netRealizedValueUsd * adj };
    });
    shadow = shadowPriceOfIntelligence(marginalCells, betaOpts);
  }

  if (flags.json) {
    process.stdout.write(JSON.stringify({ ...rec, allocation, shadowPrice: shadow }, null, 2) + '\n');
    store.close();
    return;
  }

  const tty = process.stdout.isTTY ?? false;
  console.log('');
  console.log(color(tty, C.bold, '  Budget advisor — a cap that fits real usage and follows the value'));
  console.log(color(tty, C.gray, `  Based on ${rec.basisDays} active days${loadedValue ? ' + realized-value data' : ' (usage only — pass --repo for value-based)'}`));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(64)));
  if (rec.recommendedDailyUsd === null || rec.recommendedSoftUsd === null) {
    console.log(color(tty, C.gray, `  ${rec.rationale[0] ?? 'No spend history yet — run some traffic through the proxy first.'}`));
    console.log('');
    store.close();
    return;
  }
  const dailyCap = rec.recommendedDailyUsd;
  const softCap = rec.recommendedSoftUsd;
  console.log(`  Recommended daily cap   ${color(tty, C.green, usd(dailyCap))}   ${color(tty, C.gray, `soft warn ${usd(softCap)}`)}`);
  console.log(`  Observed daily          median ${usd(rec.observed.medianDaily)} · p90 ${usd(rec.observed.p90Daily)} · max ${usd(rec.observed.maxDaily)}`);
  if (rec.realizedValueRate !== null) {
    console.log(`  Realized-value rate     ${color(tty, rec.realizedValueRate > 0.5 ? C.green : C.yellow, pct(rec.realizedValueRate))}`);
  }
  if (rec.projectedMonthlyWasteUsd !== null) {
    console.log(`  Projected monthly waste ${color(tty, C.red, usd(rec.projectedMonthlyWasteUsd))}   ${color(tty, C.gray, 'spend not turning into kept outcomes')}`);
  }
  console.log('');
  for (const r of rec.rationale) console.log(color(tty, C.gray, `  · ${r}`));
  // Prefer the quantified allocation (concrete $ moves + projected value gain);
  // fall back to the qualitative trim/grow when there isn't enough frontier data.
  if (allocation && allocation.moves.length) {
    const d2 = (n: number) => '$' + n.toFixed(2); // aggregate dollars read best at 2dp
    console.log('');
    console.log(
      color(tty, C.bold, '  Allocate the same budget by return') +
        color(tty, C.gray, `   → ≈ +${d2(allocation.projectedValueGainUsd)} realized value`),
    );
    for (const m of allocation.moves.slice(0, 5)) {
      console.log(
        `    ${color(tty, C.yellow, 'MOVE')} ${d2(m.amountUsd).padStart(8)}  ` +
          `${color(tty, C.gray, `${m.fromKey} → ${m.toKey}`)}  ${color(tty, C.green, '+' + d2(m.projectedValueGainUsd))}`,
      );
    }
    console.log(color(tty, C.gray, `  ${allocation.assumptions[1]}`));
  } else if (rec.reallocations.length) {
    console.log('');
    console.log(color(tty, C.bold, '  Reallocate'));
    for (const re of rec.reallocations) {
      const tag = re.action === 'grow' ? color(tty, C.green, 'GROW') : color(tty, C.yellow, 'TRIM');
      console.log(`    ${tag}  ${re.context.padEnd(28)} ${color(tty, C.gray, re.reason)}`);
    }
  }
  // The headline scalar: the marginal return on the next AI dollar at the optimum.
  if (shadow && shadow.budgetUsd > 0 && shadow.optimalValueUsd > 0) {
    const d2 = (n: number) => '$' + n.toFixed(2);
    console.log('');
    console.log(color(tty, C.bold, '  Shadow price of intelligence') + color(tty, C.gray, '   what one more AI $ returns, optimally spent'));
    console.log(
      `    ${color(tty, shadow.paysAtMargin ? C.green : C.red, d2(shadow.shadowPriceUsd) + ' per AI $')}   ` +
        color(tty, C.gray, shadow.paysAtMargin ? 'the next dollar still pays for itself — room to grow' : 'past positive margin — cut before you grow'),
    );
    console.log(color(tty, C.gray, `    same ${d2(shadow.budgetUsd)} budget split optimally: ${d2(shadow.currentValueUsd)} → ${d2(shadow.optimalValueUsd)} realized value (+${d2(shadow.upliftUsd)})`));
    const betaLine = betaEstimate && betaEstimate.beta !== null
      ? `β=${shadow.beta.toFixed(2)} — ${betaEstimate.how}`
      : `β=${shadow.beta.toFixed(2)} — disclosed planning default${betaEstimate ? ` (${betaEstimate.how})` : ''}`;
    console.log(color(tty, C.gray, `    ${betaLine}`));
  }
  if (flags.apply) {
    cfg.budget.dailyUsd = dailyCap;
    cfg.budget.dailySoftUsd = softCap;
    saveConfig(cfg);
    console.log('');
    console.log(color(tty, C.green, `  Applied: daily cap ${usd(dailyCap)}, soft ${usd(softCap)} written to config.`));
  } else {
    console.log('');
    console.log(color(tty, C.gray, '  Re-run with --apply to write these to your config.'));
  }
  console.log('');
  store.close();
}

export async function cmdFrontier(flags: Flags): Promise<void> {
  const repo = (flags.repo as string) ?? process.cwd();
  const windowDays = flags.window ? Number(flags.window) : 14;
  const store = new Store(dbPath());
  const loaded = await loadRealization(store, repo, { windowDays, persist: true });
  if (!loaded) {
    printNotAGitRepo(repo);
    process.exitCode = 1;
    store.close();
    return;
  }
  const report = loaded.report;
  const fr = computeFrontier(report.units);

  if (flags.json) {
    process.stdout.write(JSON.stringify(fr, null, 2) + '\n');
    store.close();
    return;
  }

  const tty = process.stdout.isTTY ?? false;
  const idx = (n: number | null) => (n === null ? '—' : n.toFixed(0));
  console.log('');
  console.log(color(tty, C.bold, '  The per-context frontier — what AI is worth it, for what'));
  console.log(color(tty, C.gray, '  RoI compared within like-for-like work · docs/RETURN-ON-INTELLIGENCE.md'));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(64)));
  noteSource(tty, loaded.source, loaded.report.projectScoped);

  console.log(color(tty, C.bold, '  By model'));
  console.log(color(tty, C.gray, '    model                        units   cost      realized   RoI'));
  for (const c of fr.byModel) {
    console.log(`    ${(c.model ?? '—').padEnd(28)} ${String(c.units).padStart(4)}   ${usd(c.costUsd).padStart(8)}   ${pct(c.realizationRate).padStart(6)}   ${color(tty, C.green, idx(c.roiIndex).padStart(3))}`);
  }

  console.log('');
  console.log(color(tty, C.bold, '  By task-type × model'));
  console.log(color(tty, C.gray, '    context                      units   cost      realized   RoI'));
  for (const c of fr.byModelAndTask.slice(0, 12)) {
    console.log(`    ${c.key.padEnd(28)} ${String(c.units).padStart(4)}   ${usd(c.costUsd).padStart(8)}   ${pct(c.realizationRate).padStart(6)}   ${color(tty, C.green, idx(c.roiIndex).padStart(3))}`);
  }

  console.log('');
  console.log(color(tty, C.bold, '  What to route where'));
  for (const r of fr.recommendations) console.log(color(tty, C.gray, `  → ${r}`));
  console.log('');
  store.close();
}

/**
 * Ambient outcome capture — `fiscus exec [--kind K] [--commit R|--session S] -- <cmd…>`.
 *
 * The adoption cliff of outcome reporting is the human in the loop: every manual
 * `report` decays to zero compliance. But machines already KNOW outcomes — as
 * exit codes. Wrap the test/deploy command once (a package.json script, a shell
 * alias, a Makefile target) and every run reports itself: exit 0 → the gate
 * passes, non-zero → it honestly fails. The wrapper is transparent — the wrapped
 * command's stdio and exit code pass straight through, so pipelines and CI steps
 * behave identically. Our own chatter goes to stderr only.
 */

export async function cmdExec(flags: Flags, command: string[]): Promise<void> {
  const codeKinds = ['tested', 'merged', 'shipped'];
  const usageKinds = ['used', 'resolved', 'published'];
  const kind = String(flags.kind ?? 'tested');
  if (![...codeKinds, ...usageKinds].includes(kind)) {
    console.error(`  Usage: fiscus exec [--kind <${[...codeKinds, ...usageKinds].join('|')}>] [--commit <ref> | --session <id>] -- <command…>`);
    process.exitCode = 1;
    return;
  }
  if (command.length === 0) {
    console.error('  Nothing to run. Put the wrapped command after a bare "--":  fiscus exec -- npm test');
    process.exitCode = 1;
    return;
  }
  if (usageKinds.includes(kind) && !flags.session) {
    console.error(`  Non-code outcome "${kind}" needs --session <id>.`);
    process.exitCode = 1;
    return;
  }

  // Resolve the ref BEFORE running: the outcome belongs to the work that was
  // current when the command started (HEAD may move underneath a long run).
  let ref: string | null = null;
  let project = 'default';
  if (flags.session) {
    ref = String(flags.session);
  } else {
    const repo = (flags.repo as string) ?? process.cwd();
    if (flags.commit) {
      if (!(await isGitRepo(repo))) {
        printNotAGitRepo(repo);
        process.exitCode = 1;
        return;
      }
      ref = await resolveCommit(repo, String(flags.commit));
      if (!ref) {
        console.error(`  Could not resolve commit: ${String(flags.commit)}`);
        process.exitCode = 1;
        return;
      }
      project = await projectName(repo);
    } else if (await isGitRepo(repo)) {
      ref = await resolveCommit(repo, 'HEAD');
      project = await projectName(repo);
    }
  }

  const started = Date.now();
  const exitCode: number = await new Promise((resolve) => {
    // Windows tool entrypoints (npm, npx, …) are .cmd shims that need a shell;
    // elsewhere spawn directly — no word-splitting surprises.
    const child =
      process.platform === 'win32'
        ? spawn(command.join(' '), { stdio: 'inherit', shell: true })
        : spawn(command[0]!, command.slice(1), { stdio: 'inherit' });
    child.on('error', (e) => {
      console.error(`  fiscus exec: could not start "${command[0]}": ${String(e)}`);
      resolve(127);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const verdict = exitCode === 0 ? 'pass' : 'fail';

  const store = new Store(dbPath());
  store.insertSignal({
    signalId: randomUUID(),
    kind,
    commitHash: ref,
    project,
    tsEpochMs: Date.now(),
    verdict,
    detail: `ambient: "${command.join(' ')}" exit ${exitCode} in ${secs}s`,
  });
  store.close();

  const tty = process.stderr.isTTY ?? false;
  console.error(color(tty, C.gray, `  [fiscus] ${kind} = ${verdict} (exit ${exitCode}, ${secs}s)${ref ? ` → ${ref.slice(0, 12)}` : ' (project-wide)'}`));
  process.exitCode = exitCode; // transparent: the wrapper never changes what the pipeline sees
}
