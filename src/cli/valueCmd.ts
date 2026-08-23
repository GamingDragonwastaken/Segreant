/**
 * Value/RoI command cluster — yield, realize, report, exec, usage, roi,
 * budget-advisor, and frontier. Extracted verbatim from cli.ts in the
 * per-command-module split; these are the commands that read the realization
 * funnel, Lift, and RoI engines and present them honestly.
 */

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Store } from '../store/db.ts';
import { loadConfig, saveConfig, dbPath, isDemo } from '../config.ts';
import { isGitRepo, projectName, resolveCommit } from '../git/correlate.ts';
import { computeQuality } from '../git/quality.ts';
import { loadRealization } from '../value/realization.ts';
import { WORK_WEEK_MINUTES } from '../value/timeReclaimed.ts';
import { computeFrontier } from '../value/frontier.ts';
// The value report's one composition — shared with the dashboard's '/api/value'.
// These commands used to sequence the same primitives themselves; the sequence
// now has a single home, so the two surfaces cannot drift apart.
import { valueSpine, usageValue, budgetAdvice } from '../value/report.ts';
import { instrumentationPriority } from '../value/voi.ts';
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
  noteSource(tty, loaded.source, loaded.report.projectScoped, loaded.report.costStaleUnits);

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
  if (codeKinds.includes(kind) && !flags.commit) {
    console.error(`  Code outcome "${kind}" needs --commit <hash>. Fiscus will not apply a project-wide assertion to an arbitrary commit.`);
    process.exitCode = 1;
    return;
  }

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
    detail: JSON.stringify({ source: 'manual', assertion: flags.detail ? String(flags.detail) : null }),
    evidenceSource: 'manual',
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
  const days = flags.days ? Number(flags.days) : 30;
  // Money inputs (org-disclosed outcome baselines + labor rate, with the demo's
  // labeled illustrative stand-ins) live with the rest of the value composition
  // in src/value/report.ts, so this command and `/api/value` price the
  // non-coding dollar identically.
  const rep = usageValue(store, cfg, { windowDays: days });

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
    console.log(color(tty, C.gray, '  No sessions without code signals in range. Tag sessions with X-Fiscus-Session-Id to measure them.'));
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
    console.log(`  Value scenario       ${color(tty, C.yellow, rr.grossRatio.toFixed(2) + '×')}   ${color(tty, C.gray, 'observed/manual-equivalent, not a causal return' + (isDemo() ? ' (demo: illustrative baselines)' : ''))}`);
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
  const store = new Store(dbPath());
  // The whole composition — realization, this project's resolved baseline, the
  // Lift source, the money inputs, RoI, the Goodhart streams, VoI — is one
  // sequence in src/value/report.ts, shared with `/api/value`. The three inputs
  // below are this command's own flags; everything else the module decides, so
  // the CLI and the dashboard cannot disagree about what any of it means.
  //   --labor-rate  prices both the effort tax and the money number's denominator
  //                 (undefined falls back to config; the demo assumes a labeled
  //                 illustrative rate, since it has no real org rate)
  //   --tsf         an externally measured TSF — the gold-standard Lift source
  //   --risk        γ for the Index certainty-equivalent
  const spine = await valueSpine(store, cfg, {
    repo,
    windowDays,
    persist: true,
    laborRatePerHour: flags['labor-rate'] !== undefined ? Number(flags['labor-rate']) : undefined,
    tsfUpperBound: flags.tsf !== undefined ? Number(flags.tsf) : undefined,
    riskAversion: flags['risk'] !== undefined ? Number(flags['risk']) : 0,
  });
  if (!spine) {
    printNotAGitRepo(repo);
    process.exitCode = 1;
    store.close();
    return;
  }
  const loaded = spine.loaded;
  const { roi, drift, driftStreams, voi } = spine;

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
  noteSource(tty, loaded.source, loaded.report.projectScoped, loaded.report.costStaleUnits);

  const idx = roi.roiIndex;
  const iv = roi.roiInterval;
  const hasBand = iv.low !== null && iv.high !== null && idx !== null && (iv.high - iv.low) > 0.5;
  const band = hasBand ? color(tty, C.gray, `  [${iv.low!.toFixed(0)}–${iv.high!.toFixed(0)}]`) : '';
  console.log(`  ${color(tty, C.bold, 'RoI Index')}           ${idx === null ? color(tty, C.gray, 'n/a (no lenses instrumented)') : color(tty, idx > 60 ? C.green : idx > 30 ? C.yellow : C.red, `${idx.toFixed(0)} / 100`)}${band}   ${color(tty, C.gray, hasBand ? 'point in a partially-identified interval' : 'geometric mean — no axis can carry it alone')}`);
  if (idx !== null && roi.coverage < 1) {
    const observed = roi.instrumentationInterval.observed;
    const low = roi.instrumentationInterval.low;
    const high = roi.instrumentationInterval.high;
    const sensitivity = observed !== null && low !== null && high !== null
      ? `full-lens sensitivity ${low.toFixed(0)}–${high.toFixed(0)}`
      : 'full-lens sensitivity not established';
    console.log(color(tty, C.gray, `  ${''.padEnd(20)}${Math.round(roi.coverage * 4)}/4 lenses measured · ${sensitivity} — a measured lens may move the observed score up or down`));
  }
  const eff = roi.realizedEfficiency;
  console.log(`  Realized efficiency  ${eff === null ? '—' : color(tty, C.green, pct(eff))}   ${color(tty, C.gray, `of $${(roi.tokenCostUsd + roi.effortTaxUsd).toFixed(2)} spent (tokens${roi.effortTaxUsd > 0 ? ' + effort' : ''})`)}`);

  // The money number is an observed/manual-equivalent scenario until a separate
  // qualified randomized study supplies an economic estimand.
  const rr = roi.returnRatio;
  if (rr.basis === 'usd' && rr.grossRatio !== null) {
    console.log(`  ${color(tty, C.bold, 'Value scenario')}       ${color(tty, C.yellow, rr.grossRatio.toFixed(2) + '×')}   ${color(tty, C.gray, 'observed/manual-equivalent; causal study required for break-even')}`);
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
          `largest unmeasured exposure: at a mid ${top.reference}, the observed Index moves ${roi.roiIndex.toFixed(0)} → ${top.indexAtReference.toFixed(0)} — direction is disclosed sensitivity, not a monotone promise`,
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

/**
 * Time Reclaimed as a calendar-unit headline: manual work-weeks your REALIZED
 * work would have cost at your task baselines, vs the AI-assisted time
 * actually measured. Mirrors cmdRoi's repo/baseline resolution exactly so the
 * two commands never disagree about what "this project's baseline" means.
 */
export async function cmdSaved(flags: Flags): Promise<void> {
  const repo = (flags.repo as string) ?? process.cwd();
  const windowDays = flags.window ? Number(flags.window) : 14;
  const cfg = loadConfig();
  const store = new Store(dbPath());
  // Same composition as `roi` and `/api/value` — so "this project's baseline"
  // means one thing everywhere, and the reclaimed hours can never be priced off
  // a baseline the RoI lens did not use.
  const spine = await valueSpine(store, cfg, { repo, windowDays, persist: true });
  if (!spine) {
    printNotAGitRepo(repo);
    process.exitCode = 1;
    store.close();
    return;
  }
  const loaded = spine.loaded;
  const project = spine.project;
  const rec = spine.reclaimed;

  if (flags.json) {
    process.stdout.write(JSON.stringify(rec, null, 2) + '\n');
    store.close();
    return;
  }

  const tty = process.stdout.isTTY ?? false;
  console.log('');
  console.log(color(tty, C.bold, `  Fiscus — time reclaimed · ${project}`));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(64)));
  noteSource(tty, loaded.source, loaded.report.projectScoped, loaded.report.costStaleUnits);

  if (rec.workWeeksSaved === null || rec.workWeeksRange === null) {
    console.log(color(tty, C.gray, '  Uninstrumented — needs realized work with a task baseline and measured AI time.'));
    console.log('');
    for (const n of rec.notes) console.log(color(tty, C.gray, `  · ${n}`));
    console.log('');
    console.log(color(tty, C.gray, '  Route real traffic through the proxy, then: fiscus exec -- npm test   fiscus roi --repo .'));
    console.log('');
    store.close();
    return;
  }

  console.log(`  ${color(tty, C.bold, `≈ ${num(rec.manualMinutes)} manual minutes of realized work`)}   ${color(tty, C.gray, `[${num(rec.manualMinutesLow)} – ${num(rec.manualMinutesHigh)}]`)}`);
  console.log(color(tty, C.gray, `  delivered in ${num(rec.aiMinutes)} measured AI-minutes`));
  const weeksCol = rec.workWeeksSaved >= 0 ? C.green : C.red;
  console.log(`  ${color(tty, C.bold, `≈ ${(rec.savedMinutes! / 60).toFixed(1)} manual hours reclaimed`)}       ${color(tty, C.gray, `[${(rec.savedRange!.low / 60).toFixed(1)} – ${(rec.savedRange!.high / 60).toFixed(1)}]`)}`);
  console.log(`  ≈ ${color(tty, weeksCol, `${rec.workWeeksSaved.toFixed(2)} work-weeks`)}                       ${color(tty, C.gray, `(${WORK_WEEK_MINUTES / 60}h week)`)}`);
  console.log('');
  console.log(color(tty, C.bold, '  By task type'));
  for (const s of rec.strata) {
    if (s.manualMinutes === 0 && s.diedUnits === 0 && s.realizedUnits === 0) continue;
    const label = s.baselined ? s.taskType : `${s.taskType} (no baseline)`;
    console.log(`    ${label.padEnd(22)} ${String(s.realizedUnits).padStart(3)} realized  ${String(s.diedUnits).padStart(3)} died   ${num(s.manualMinutes).padStart(6)} min [${num(s.manualMinutesLow)}–${num(s.manualMinutesHigh)}]   ${usd(s.costUsd)}`);
  }
  console.log('');
  for (const n of rec.notes) console.log(color(tty, C.gray, `  · ${n}`));
  console.log('');
  store.close();
}

export async function cmdBudgetAdvisor(flags: Flags): Promise<void> {
  const cfg = loadConfig();
  const store = new Store(dbPath());
  const days = flags.days ? Number(flags.days) : 30;

  let realizedValueRate: number | null = null;
  let frontierCells: ReturnType<typeof computeFrontier>['byModelAndTask'] = [];
  const repo = flags.repo as string | undefined;
  const loadedValue = await loadRealization(store, repo, { persist: false });
  if (loadedValue) {
    realizedValueRate = loadedValue.report.matured.realizedValueRate;
    frontierCells = computeFrontier(loadedValue.report.units).byModelAndTask;
  }

  // The cap and its basis disclosure come from the shared composition, so this
  // command and `/api/value` recommend from the same spend series — and the
  // recommendation is always fitted to the spend its --apply action can govern.
  const rec = budgetAdvice(store, cfg, { windowDays: days, realizedValueRate, frontier: frontierCells });
  const spendBasis = rec.spendBasis;
  // Raw RoI cells can mix unlike tasks. The actionable guidance is the
  // separately gated same-task model-switch trial, never a generic allocator.
  const allocation = null;

  if (flags.json) {
    process.stdout.write(JSON.stringify({ ...rec, allocation, shadowPrice: null }, null, 2) + '\n');
    store.close();
    return;
  }

  const tty = process.stdout.isTTY ?? false;
  console.log('');
  console.log(color(tty, C.bold, '  Budget advisor — a cap that fits real usage and follows the value'));
  console.log(color(tty, C.gray, `  Based on ${rec.basisDays} active days${loadedValue ? ' + realized-value data' : ' (usage only — pass --repo for value-based)'}`));
  console.log(color(tty, C.gray, '  ' + '─'.repeat(64)));
  console.log(color(tty, C.gray, `  Cap basis: ${spendBasis === 'live_proxy' ? 'live proxy spend only (imported spend remains observed-only)' : 'all observed spend (live + imported)'}`));
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
  /*
   * Raw allocation is intentionally withheld from the CLI. The retained helper
   * is an offline `exploratory_raw` scenario only; generic contexts can be
   * unlike work and its arithmetic is not a recommendation or forecast.
  if (allocation && allocation.moves.length) {
    const d2 = (n: number) => '$' + n.toFixed(2); // aggregate dollars read best at 2dp
    console.log('');
    console.log(
      color(tty, C.bold, '  Exploratory raw allocation scenario') +
        color(tty, C.gray, `   → raw arithmetic ${d2(allocation.rawRateScenarioGainUsd)} (not a recommendation)`),
    );
    for (const m of allocation.moves.slice(0, 5)) {
      console.log(
        `    ${color(tty, C.yellow, 'MOVE')} ${d2(m.amountUsd).padStart(8)}  ` +
          `${color(tty, C.gray, `${m.fromKey} → ${m.toKey}`)}  ${color(tty, C.green, d2(m.rawRateScenarioGainUsd))}`,
      );
    }
    for (const assumption of allocation.assumptions) {
      console.log(color(tty, C.gray, `  ${assumption}`));
    }
  } else if (rec.reallocations.length) {
    console.log('');
    console.log(color(tty, C.bold, '  Reallocate'));
    for (const re of rec.reallocations) {
      const tag = re.action === 'grow' ? color(tty, C.green, 'GROW') : color(tty, C.yellow, 'TRIM');
      console.log(`    ${tag}  ${re.context.padEnd(28)} ${color(tty, C.gray, re.reason)}`);
    }
  }
  }
  */
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
  noteSource(tty, loaded.source, loaded.report.projectScoped, loaded.report.costStaleUnits);

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
  // Review-only: this surface never changes routing, so it must not be headed
  // like an instruction. See frontier.ts — the recommendation is a comparison of
  // local historical evidence, not a directive.
  console.log(color(tty, C.bold, '  Cheaper-model trials to review'));
  for (const r of fr.recommendations) console.log(color(tty, C.gray, `  → ${r}`));
  console.log(
    color(tty, C.dim, '    Local historical comparison only — Fiscus does not change provider routing.'),
  );
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
    } else if (codeKinds.includes(kind)) {
      console.error(`  Code outcome "${kind}" needs a Git repository or --commit <ref>; no project-wide lifecycle signal was recorded.`);
      process.exitCode = 1;
      return;
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
    detail: JSON.stringify({ source: 'local-command', command: command.join(' '), exitCode, seconds: Number(secs) }),
    evidenceSource: 'local-command',
  });
  store.close();

  const tty = process.stderr.isTTY ?? false;
  console.error(color(tty, C.gray, `  [fiscus] ${kind} = ${verdict} (exit ${exitCode}, ${secs}s)${ref ? ` → ${ref.slice(0, 12)}` : ' (project-wide)'}`));
  process.exitCode = exitCode; // transparent: the wrapper never changes what the pipeline sees
}
