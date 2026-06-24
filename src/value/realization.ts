/**
 * Realization — assembles each commit into a funnel of gate verdicts and rolls
 * the units up into the three headline numbers (docs/THE-STANDARD.md §6):
 *
 *   Realization Rate     production, dollar-free: matured units that realized
 *   Realized Value Rate  the money lens: share of spend that reached realized
 *   First-Pass Acceptance collaboration: mean edit-distance acceptance
 *
 * Gate sources:
 *   git    — committed (always), survived (blame), clean (revert/incident)
 *   proxy  — proposed / accepted (captured proposals vs committed lines)
 *   signal — tested / merged / shipped (ingested via `aegisflow report`)
 *
 * An unobservable gate is `unknown`, never `fail`. See THE-STANDARD §5.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Store, GateSignalRow, RealizationUnitRecord } from '../store/db.ts';
import { attributeCommits, isGitRepo, projectName, type CommitAttribution } from '../git/correlate.ts';
import { isDemo } from '../config.ts';
import { survivingLines, revertedHashes } from '../git/quality.ts';
import { acceptanceForCommit, type ProposedFile } from './proposals.ts';
import { GATE_LADDER, scoreFunnel, type Gate, type GateResult, type Verdict, type FunnelOutcome } from './gates.ts';
import { classifyTaskType, type TaskType } from './taskType.ts';
import { computeReturnOnIntelligence, type RoIOptions } from './lenses.ts';
import { liftFromData, timeWithAiMinutes, type AiEvent, type DataLiftResult } from './lift.ts';

const run = promisify(execFile);

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', repoPath, ...args], { maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

/** Map of file path → lines this commit ADDED (the '+' side of its diff). */
async function addedLinesByFile(repoPath: string, hash: string): Promise<Map<string, string[]>> {
  const out = await git(repoPath, ['show', '--format=', '--no-color', hash]);
  const map = new Map<string, string[]>();
  let cur: string | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('+++ ')) {
      const raw = line.slice(4).trim().replace(/^b\//, '');
      cur = raw === '/dev/null' ? null : raw;
      if (cur && !map.has(cur)) map.set(cur, []);
    } else if (cur && line.startsWith('+') && !line.startsWith('+++')) {
      map.get(cur)!.push(line.slice(1));
    }
  }
  return map;
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? p;
}

/** Does a proposal's file path plausibly refer to one of a commit's files? */
function matchesCommitFile(proposalPath: string | null, committedPaths: string[]): boolean {
  if (proposalPath === null) return true; // inline block: pooled, can't localize
  const norm = proposalPath.replace(/\\/g, '/');
  for (const cp of committedPaths) {
    if (cp.endsWith(norm) || norm.endsWith(cp) || baseName(cp) === baseName(norm)) return true;
  }
  return false;
}

/** Resolve a gate from ingested signals: any fail → fail, else any pass → pass, else unknown. */
function signalVerdict(signals: GateSignalRow[], kind: string): Verdict {
  let sawPass = false;
  for (const s of signals) {
    if (s.kind !== kind) continue;
    if (s.verdict === 'fail') return 'fail';
    if (s.verdict === 'pass') sawPass = true;
  }
  return sawPass ? 'pass' : 'unknown';
}

export interface WorkUnit extends CommitAttribution {
  ageDays: number;
  maturing: boolean;
  survivalRatio: number;
  reverted: boolean;
  hadProposal: boolean;
  acceptance: number | null;
  taskType: TaskType; // the "context" axis of the frontier
  dominantModel: string | null; // model that spent the most in this unit's window
  funnel: FunnelOutcome;
}

export interface WasteBucket {
  stage: string; // a Gate name, 'realized', or 'unverified'
  units: number;
  costUsd: number;
}

export interface RealizationReport {
  generatedAt: string;
  windowDays: number;
  acceptanceThreshold: number;
  survivalThreshold: number;
  units: WorkUnit[];
  firstPassAcceptance: number | null;
  proposalCoverage: number; // units with a captured proposal / total units
  matured: {
    units: number;
    realizedUnits: number;
    realizationRate: number;
    totalCostUsd: number;
    realizedValueUsd: number;
    netRealizedValueUsd: number; // realized value discounted by first-pass acceptance (reworked output is worth less)
    realizedValueRate: number | null;
    wasteByStage: WasteBucket[];
    instrumentation: Record<Gate, number>;
  };
}

export interface RealizationOptions {
  limit?: number;
  windowDays?: number;
  acceptanceThreshold?: number;
  survivalThreshold?: number;
  persist?: boolean;
}

function gate(g: Gate, verdict: Verdict, detail: string): GateResult {
  return { gate: g, verdict, detail };
}

export async function computeRealization(
  store: Store,
  repoPath: string,
  opts: RealizationOptions = {},
): Promise<RealizationReport> {
  const limit = opts.limit ?? 30;
  const windowDays = opts.windowDays ?? 14;
  const acceptanceThreshold = opts.acceptanceThreshold ?? 0.6;
  const survivalThreshold = opts.survivalThreshold ?? 0.5;
  const now = Date.now();
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const project = await projectName(repoPath);

  const attributions = await attributeCommits(store, repoPath, { limit, persist: opts.persist });
  const reverted = await revertedHashes(repoPath, limit);

  const units: WorkUnit[] = [];
  for (const a of attributions) {
    const ageDays = (now - a.tsEpochMs) / (24 * 60 * 60 * 1000);
    const maturing = now - a.tsEpochMs < windowMs;
    const { added, surviving } = await survivingLines(repoPath, a.hash);
    const survivalRatio = added > 0 ? Math.min(1, surviving / added) : 0;
    const isReverted = reverted.has(a.hash) || reverted.has(a.hash.slice(0, 7));

    // proxy gates: proposals captured in this commit's attribution window
    const addedByFile = await addedLinesByFile(repoPath, a.hash);
    const committedPaths = [...addedByFile.keys()];
    const winProposals = store.proposalsInWindow(project, a.windowStartMs, a.windowEndMs);
    const matched: ProposedFile[] = [];
    for (const p of winProposals) {
      for (const f of p.files) {
        if (matchesCommitFile(f.path, committedPaths)) matched.push(f);
      }
    }
    const acceptance = acceptanceForCommit(matched, addedByFile);
    const hadProposal = acceptance !== null;

    // signal gates
    const signals = [...store.signalsForCommit(a.hash), ...store.signalsInWindow(project, a.windowStartMs, a.windowEndMs)];
    const incidentFail = signals.some((s) => s.kind === 'incident');

    const verdicts: Record<Gate, GateResult> = {
      proposed: gate('proposed', hadProposal ? 'pass' : 'unknown', hadProposal ? 'AI proposal captured' : 'no proposal captured'),
      accepted: gate(
        'accepted',
        acceptance === null ? 'unknown' : acceptance >= acceptanceThreshold ? 'pass' : 'fail',
        acceptance === null ? 'no proposal to compare' : `${Math.round(acceptance * 100)}% of proposal shipped`,
      ),
      committed: gate('committed', 'pass', `${added} lines in ${committedPaths.length || a.filesChanged} files`),
      tested: gate('tested', signalVerdict(signals, 'tested'), 'CI/test signal'),
      merged: gate('merged', signalVerdict(signals, 'merged'), 'merge signal'),
      shipped: gate('shipped', signalVerdict(signals, 'shipped'), 'deploy signal'),
      survived: gate(
        'survived',
        maturing ? 'unknown' : survivalRatio >= survivalThreshold ? 'pass' : 'fail',
        maturing ? 'maturing' : `${Math.round(survivalRatio * 100)}% of lines survive`,
      ),
      clean: gate(
        'clean',
        isReverted || incidentFail ? 'fail' : maturing ? 'unknown' : 'pass',
        isReverted ? 'reverted' : incidentFail ? 'linked incident' : maturing ? 'maturing' : 'no revert/incident',
      ),
    };

    // Attribute the unit to the model that spent the most in its window.
    const modelSpend = store.byModel(a.windowStartMs, a.windowEndMs);
    const dominantModel = modelSpend.length > 0 ? modelSpend[0]!.label : null;

    units.push({
      ...a,
      ageDays,
      maturing,
      survivalRatio,
      reverted: isReverted,
      hadProposal,
      acceptance,
      taskType: classifyTaskType(a.subject),
      dominantModel,
      funnel: scoreFunnel(verdicts),
    });
  }

  // Persist the snapshot so this realized-value picture can be served later
  // without the repo (e.g. to a manager's dashboard). Keyed by commit hash.
  if (opts.persist) {
    store.saveRealizationUnits(
      units.map((u): RealizationUnitRecord => ({
        commitHash: u.hash,
        project,
        tsEpochMs: u.tsEpochMs,
        computedAtMs: now,
        attributedCostUsd: u.attributedCostUsd,
        maturing: u.maturing,
        realized: u.funnel.realized,
        unitJson: JSON.stringify(u),
      })),
    );
  }

  return rollupRealization(units, { generatedAt: now, windowDays, acceptanceThreshold, survivalThreshold });
}

/**
 * Reconstruct a realization report from persisted snapshots — no git, no repo.
 * Units are rehydrated and rolled up by the SAME `rollupRealization`, so a
 * dashboard reading a store its machine never computed gets numbers identical to
 * a live run. Reads every project by default (the team aggregate); pass a project
 * to scope it. `generatedAt` reflects the freshest snapshot in the set.
 */
export function realizationFromStore(
  store: Store,
  opts: { project?: string; windowDays?: number; acceptanceThreshold?: number; survivalThreshold?: number } = {},
): RealizationReport {
  const rows = store.realizationUnitRows(opts.project);
  const units = rows.map((r) => JSON.parse(r.unitJson) as WorkUnit);
  const generatedAt = rows.length > 0 ? Math.max(...rows.map((r) => r.computedAtMs)) : Date.now();
  return rollupRealization(units, {
    generatedAt,
    windowDays: opts.windowDays ?? 14,
    acceptanceThreshold: opts.acceptanceThreshold ?? 0.6,
    survivalThreshold: opts.survivalThreshold ?? 0.5,
  });
}

export interface LoadedRealization {
  source: 'git' | 'store';
  report: RealizationReport;
}

/**
 * Resolve a realization report from the best available source, in order:
 *   1. live git — a real repo is the freshest read, and persists a snapshot when
 *      `persist` is set, so future repo-less reads have something to serve;
 *   2. the store — persisted snapshots from a previous run, so realized value
 *      survives the machine that computed it (a manager's dashboard, a CI box,
 *      the demo);
 *   3. null — nothing to show yet, reported honestly rather than faked.
 *
 * In demo mode the git path is skipped unconditionally: the seeded snapshots are
 * the subject, not whatever repository the process happens to be sitting in.
 */
export async function loadRealization(
  store: Store,
  repo: string | undefined,
  opts: { windowDays?: number; limit?: number; persist?: boolean } = {},
): Promise<LoadedRealization | null> {
  if (!isDemo() && repo && (await isGitRepo(repo))) {
    return {
      source: 'git',
      report: await computeRealization(store, repo, {
        limit: opts.limit ?? 40,
        windowDays: opts.windowDays ?? 14,
        persist: opts.persist ?? false,
      }),
    };
  }
  if (store.countRealizationUnits() > 0) {
    return { source: 'store', report: realizationFromStore(store, { windowDays: opts.windowDays }) };
  }
  return null;
}

export interface ProjectValue {
  project: string;
  units: number;
  costUsd: number;
  realizationRate: number;
  realizedValueUsd: number;
  netRealizedValueUsd: number;
  roiIndex: number | null;
}

/**
 * Per-project value — the budget owner's view. For each project with stored
 * realization snapshots, roll its units up (the same pure rollup) and score its
 * RoI, so a manager sees which projects' AI spend is paying off — with no repo on
 * their machine. `roiOptions` is threaded through so per-project RoI matches the
 * headline (e.g. the demo's synthetic lift), keeping the numbers consistent.
 */
export function projectValueBreakdown(
  store: Store,
  opts: { windowDays?: number; roiOptions?: RoIOptions } = {},
): ProjectValue[] {
  const out: ProjectValue[] = [];
  for (const project of store.realizationProjects()) {
    const rep = realizationFromStore(store, { project, windowDays: opts.windowDays });
    if (rep.matured.units === 0) continue;
    const roi = computeReturnOnIntelligence(rep, opts.roiOptions ?? {});
    out.push({
      project,
      units: rep.matured.units,
      costUsd: rep.matured.totalCostUsd,
      realizationRate: rep.matured.realizationRate,
      realizedValueUsd: rep.matured.realizedValueUsd,
      netRealizedValueUsd: rep.matured.netRealizedValueUsd,
      roiIndex: roi.roiIndex,
    });
  }
  return out.sort((a, b) => b.costUsd - a.costUsd);
}

/**
 * Roll a set of work units up into the three headline numbers + the waste P&L.
 *
 * Extracted as a PURE function (no git, no store) so the exact same arithmetic
 * serves two callers: live `computeRealization` (units built from git just now)
 * and `realizationFromStore` (units rehydrated from a previous run's snapshot).
 * One rollup means the headline RoI can't drift between the live and the cached
 * path — the property that lets a manager's dashboard read realized value off a
 * store its machine never computed. See docs/THE-STANDARD.md §6.
 */
export function rollupRealization(
  units: WorkUnit[],
  opts: { generatedAt?: number; windowDays: number; acceptanceThreshold: number; survivalThreshold: number },
): RealizationReport {
  const generatedMs = opts.generatedAt ?? Date.now();

  // collaboration lens — available immediately, over all units that had a proposal
  const withProposal = units.filter((u) => u.acceptance !== null);
  const firstPassAcceptance =
    withProposal.length > 0 ? withProposal.reduce((s, u) => s + (u.acceptance ?? 0), 0) / withProposal.length : null;

  // production + money lenses — over matured units only
  const mature = units.filter((u) => !u.maturing);
  const realizedUnits = mature.filter((u) => u.funnel.realized);
  const totalCostUsd = mature.reduce((s, u) => s + u.attributedCostUsd, 0);
  const realizedValueUsd = realizedUnits.reduce((s, u) => s + u.attributedCostUsd, 0);
  // Net of rework: each realized unit's dollars discounted by its first-pass
  // acceptance — output that had to be heavily rewritten delivered less value.
  // Unknown acceptance → full credit (the unknown-never-penalizes rule).
  const netRealizedValueUsd = realizedUnits.reduce((s, u) => s + u.attributedCostUsd * (u.acceptance ?? 1), 0);

  const wasteMap = new Map<string, WasteBucket>();
  for (const u of mature) {
    const stage = u.funnel.realized ? 'realized' : u.funnel.diedAt ?? 'unverified';
    const b = wasteMap.get(stage) ?? { stage, units: 0, costUsd: 0 };
    b.units += 1;
    b.costUsd += u.attributedCostUsd;
    wasteMap.set(stage, b);
  }

  const instrumentation = Object.fromEntries(GATE_LADDER.map((g) => [g, 0])) as Record<Gate, number>;
  for (const u of mature) {
    for (const r of u.funnel.results) if (r.verdict !== 'unknown') instrumentation[r.gate] += 1;
  }

  return {
    generatedAt: new Date(generatedMs).toISOString(),
    windowDays: opts.windowDays,
    acceptanceThreshold: opts.acceptanceThreshold,
    survivalThreshold: opts.survivalThreshold,
    units,
    firstPassAcceptance,
    proposalCoverage: units.length > 0 ? withProposal.length / units.length : 0,
    matured: {
      units: mature.length,
      realizedUnits: realizedUnits.length,
      realizationRate: mature.length > 0 ? realizedUnits.length / mature.length : 0,
      totalCostUsd,
      realizedValueUsd,
      netRealizedValueUsd,
      realizedValueRate: totalCostUsd > 0 ? realizedValueUsd / totalCostUsd : null,
      wasteByStage: [...wasteMap.values()].sort((a, b) => b.costUsd - a.costUsd),
      instrumentation,
    },
  };
}

/**
 * Bridge: derive a REAL Lift (measured AI time × configured task baselines) for a
 * report, pulling the request events from the store over the span of the report's
 * realized work. Keeps lift.ts pure (no store import) and gives the CLI + dashboard
 * a one-liner for the non-demo path. Uninstrumented when there's no baselined
 * realized work or no measured AI time — Lift stays honest, never invented.
 */
export function liftOptionsFromStore(
  store: Store,
  report: RealizationReport,
  baselineMinutes: Record<string, number>,
): DataLiftResult {
  const mature = report.units.filter((u) => !u.maturing);
  const realized = mature.filter((u) => u.funnel.realized);
  // Bound the measured-time window to when the realized work actually happened (the
  // unit attribution windows). timeWithAiMinutes dedupes overlapping windows, so
  // taking the union of the realized units' spans never double-counts.
  let events: AiEvent[] = [];
  if (realized.length > 0) {
    const startMs = Math.min(...realized.map((u) => u.windowStartMs));
    const endMs = Math.max(...realized.map((u) => u.windowEndMs));
    events = store.requestsInRange(startMs, endMs).map((r) => ({
      sessionId: r.sessionId ?? 'unknown',
      tsEpochMs: r.tsEpochMs,
    }));
  }
  return liftFromData({
    units: mature.map((u) => ({ taskType: u.taskType, realized: u.funnel.realized })),
    events,
    baselineMinutes,
  });
}

export interface MoneyInputs {
  grossRealizedValueUsd: number | null; // realized work valued at manual baseline × rate, net of rework
  supervisionMinutes: number | null; // measured time-with-AI over the matured-work span
}

/**
 * The money number's inputs, measured from the same store the lenses use — so the
 * CLI and the dashboard price the RoI return identically (one source of truth):
 *   · numerator   = Σ over REALIZED matured units of baseline manual $ × acceptance
 *   · supervision = measured time-with-AI (METR windowing) over the matured span
 * Gross value is null without a labor rate; supervision is null without measured
 * traffic — the return stays honestly un-priced rather than invented.
 */
export function moneyInputsFromStore(
  store: Store,
  report: RealizationReport,
  baselineMinutes: Record<string, number>,
  laborRate: number | null,
): MoneyInputs {
  const matured = report.units.filter((u) => !u.maturing);
  let grossRealizedValueUsd: number | null = null;
  if (laborRate !== null && laborRate > 0) {
    let v = 0;
    for (const u of matured) {
      if (!u.funnel.realized) continue;
      const b = baselineMinutes[u.taskType];
      if (typeof b === 'number' && b > 0) v += b * (laborRate / 60) * (u.acceptance ?? 1);
    }
    grossRealizedValueUsd = v;
  }
  let supervisionMinutes: number | null = null;
  if (matured.length > 0) {
    const startMs = Math.min(...matured.map((u) => u.windowStartMs));
    const endMs = Math.max(...matured.map((u) => u.windowEndMs));
    const events = store.requestsInRange(startMs, endMs).map((r) => ({ sessionId: r.sessionId ?? 'unknown', tsEpochMs: r.tsEpochMs }));
    const m = timeWithAiMinutes(events).totalMin;
    supervisionMinutes = m > 0 ? m : null;
  }
  return { grossRealizedValueUsd, supervisionMinutes };
}
