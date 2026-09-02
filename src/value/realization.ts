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
 *   signal — tested / merged / shipped (ingested via `fiscus report`)
 *
 * An unobservable gate is `unknown`, never `fail`. See THE-STANDARD §5.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Store, GateSignalRow, RealizationUnitRecord, ProposalCaptureCoverage } from '../store/db.ts';
import { attributeCommits, isGitRepo, projectName, type CommitAttribution } from '../git/correlate.ts';
import { isDemo } from '../config.ts';
import { survivingLines, revertScan } from '../git/quality.ts';
import { revertCompletenessWitness } from '../git/completeness.ts';
import { acceptanceForCommit, type ProposedFile } from './proposals.ts';
import type { EpistemicState } from '../epistemic/state.ts';
import {
  GATE_LADDER,
  scoreFunnel,
  terminalRealizationBounds,
  serialRealization,
  type Gate,
  type GateResult,
  type Verdict,
  type FunnelOutcome,
  type TerminalRealizationBounds,
  type SerialRealization,
  aggregatePolarity,
  polarityFromVerdict,
  verdictFromPolarity,
} from './gates.ts';
import { classifyTaskType, type TaskType } from './taskType.ts';
import { computeReturnOnIntelligence, type RoIOptions } from './lenses.ts';
import { liftFromData, timeWithAiMinutes, type AiEvent, type DataLiftResult } from './lift.ts';
import { economicAttributionFromAttributions, type EconomicAttribution } from '../economics/attribution.ts';
import {
  assessCompleteness,
  CODING_CLEAN_COMPLETENESS_EVENT_TYPES,
  type CompletenessWitness,
} from '../measurement/completeness.ts';
import { scope } from '../epistemic/scope.ts';
import { interval } from '../epistemic/time.ts';
import { canonicalModelAttribution } from '../store/economicReadModel.ts';

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
/**
 * Aggregate every recorded signal of one kind into four-valued polarity.
 *
 * This used to return on the first `fail`, which meant a gate with a passing CI
 * run AND a failing one reported plain `fail` and lost the fact that both were
 * observed. Two runs disagreeing is not the same evidential situation as one
 * run failing, and the difference matters most exactly where it was being
 * discarded: at the gate that decides whether work realized (AII-003, WP-B03).
 */
function signalPolarity(signals: GateSignalRow[], kind: string): EpistemicState {
  const observations: boolean[] = [];
  for (const s of signals) {
    if (s.kind !== kind) continue;
    if (s.verdict === 'pass') observations.push(true);
    else if (s.verdict === 'fail') observations.push(false);
    // Anything else is an unobserved signal and contributes nothing, which is
    // not the same as contributing a negative.
  }
  return aggregatePolarity(observations);
}

export interface WorkUnit extends CommitAttribution {
  ageDays: number;
  maturing: boolean;
  survivalRatio: number;
  reverted: boolean;
  hadProposal: boolean;
  acceptance: number | null;
  taskType: TaskType; // the "context" axis of the frontier
  /** Provider paired with the dominant model when exact model authority exists. */
  dominantProvider?: string | null;
  dominantModel: string | null; // model that spent the most in this unit's window
  /**
   * The dominant model's OWN spend in this unit's window — not the window total.
   *
   * `attributedCostUsd` is every model's spend in the window, which is the right
   * basis for "what did this commit cost" but the wrong one for "what does this
   * model cost", because a mixed window books the other models' dollars to
   * whichever one happened to spend most. Model-vs-model comparison must use this
   * field. `null` when no spend was observed in the window.
   */
  dominantModelCostUsd: number | null;
  /**
   * The dominant model's share of the window's total spend, 0..1. A share near 1
   * means the window was effectively one model's work, so attributing the unit to
   * that model is meaningful; a share near 0.5 means the label is close to a
   * coin flip between two models. Model comparison gates on this. `null` when no
   * spend was observed in the window.
   */
  dominantModelCostShare: number | null;
  /** Exact effective spend for the dominant model, when request lineage exists. */
  dominantModelEconomic?: EconomicAttribution;
  /**
   * True when this unit was rehydrated from a snapshot whose dollars predate a
   * reprice that touched its window and could not be re-attributed (its snapshot
   * predates `cost_scope`, so the basis it used is unrecoverable). Its cost is a
   * real observation of a superseded price, not a current one — disclosed rather
   * than dropped, and excluded from model comparison. Always false on the live
   * git path, which prices from the ledger as it stands.
   */
  costStale: boolean;
  /**
   * The cost basis behind the dominant model's spend in this window — one of the
   * ledger's `cost_basis` values, or `'mixed'` when its rows were priced more than
   * one way. `null` when nothing was observed, or on a snapshot written before
   * this was recorded.
   *
   * Model comparison is a claim about PRICE, so it is only meaningful when both
   * sides' dollars are the same kind of price. A cell pooling exact list prices
   * with fallback guesses for unrecognized models is comparing pricing methods as
   * much as models.
   */
  dominantModelCostBasis: string | null;
  /**
   * The rate-card revision behind that spend, or `'mixed'` when the window spans
   * more than one. A cell whose units straddle a card refresh has pre- and
   * post-change dollars pooled into one per-unit cost, which is a comparison of
   * pricing eras. `null` when unobserved or unrecorded.
   */
  dominantModelRateCard: string | null;
  funnel: FunnelOutcome;
  /** Completeness evidence required before the negative clean predicate can pass. */
  cleanCompleteness?: CleanCompleteness;
  /** Coverage of the retained proposal capture used by the accepted gate. */
  proposalCaptureCoverage?: ProposalCaptureCoverage;
}

export const CLEAN_COMPLETENESS_EVENT_TYPES = CODING_CLEAN_COMPLETENESS_EVENT_TYPES;
export type CleanCompletenessEventType = (typeof CODING_CLEAN_COMPLETENESS_EVENT_TYPES)[number];

export interface CleanCompletenessWitness {
  readonly id: string;
  readonly sourceId: string;
  readonly state: string;
  readonly eventTypes: readonly string[];
  /** JSON-safe scope constraints supplied by the completeness source. */
  readonly scope: Readonly<Record<string, string>>;
  readonly period: { readonly from: string; readonly to: string };
}

export interface CleanCompleteness {
  readonly qualified: boolean;
  readonly requiredEventTypes: readonly CleanCompletenessEventType[];
  readonly qualifyingWitnessIds: readonly string[];
  readonly witnesses: readonly CleanCompletenessWitness[];
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
  // True when the units' cost was attributed from spend SCOPED to this project (the
  // ledger is characterized by project — native imports, or tagged proxy traffic),
  // rather than the project-blind window sum. Honest disclosure of which basis the
  // dollars came from, never silent. See git/correlate.ts.
  projectScoped: boolean;
  units: WorkUnit[];
  firstPassAcceptance: number | null;
  proposalCoverage: number; // units with a captured proposal / total units
  // Units whose dollars predate a reprice and could not be re-attributed (their
  // snapshot predates the recorded cost basis). Non-zero means this report's
  // money numbers and the request ledger's totals are answering with different
  // prices — surfaced here so no surface has to imply agreement it does not have.
  costStaleUnits: number;
  /**
   * Units whose surviving-line count was NOT measured because the survival scan
   * budget ran out (see `survivalBudgetMs`). Their `survived` gate is `unknown`,
   * never a ratio — an unmeasured commit has not been shown to have churned.
   *
   * Non-zero means the survival and churn figures in this report describe fewer
   * commits than the report covers, which is the kind of thing that has to be
   * stated beside the number rather than discovered later.
   */
  survivalUnmeasuredUnits: number;
  matured: {
    units: number;
    realizedUnits: number;
    realizationRate: number;
    totalCostUsd: number;
    spendOnRealizedUnitsUsd: number;
    acceptanceWeightedSpendUsd: number; // realized value discounted by first-pass acceptance (reworked output is worth less)
    realizedSpendShare: number | null;
    wasteByStage: WasteBucket[];
    instrumentation: Record<Gate, number>;
    /**
     * Mature units whose evidence for a gate both supported and refuted it
     * (AII-003, WP-B03). Counted separately from `instrumentation` because a
     * contradiction is not a measurement of the gate — it is a measurement of
     * the sources disagreeing, and it calls for adjudication rather than for
     * reading the projected verdict.
     */
    gateConflicts: Record<Gate, number>;
    // Partial-identification interval on the realization rate: lower = confirmed
    // realized (== realizationRate), upper = not observed dead. The truth is inside;
    // the width is exactly the unobserved region. Guards the per-unit progress score
    // from being misread as a realization probability. See gates.ts.
    realizationBounds: TerminalRealizationBounds;
    // Ordered survival chain S_G = Π q_g — realization as a product of per-gate
    // conditional pass rates, with uninstrumented gates disclosed in `skipped`
    // rather than silently assumed passed. See gates.ts.
    serial: SerialRealization;
    /** Exact effective spend for mature units; numeric fields remain compatibility projections. */
    economic?: RealizationEconomicRollup;
  };
}

export type RealizationEconomicCoverage = 'exact' | 'partial' | 'legacy_unknown';

export interface RealizationEconomicRollup {
  coverage: RealizationEconomicCoverage;
  /** Resolved effective amount for all mature unit windows, when any exact lineage exists. */
  total: EconomicAttribution | null;
  /** Resolved effective amount for mature units whose funnel realized, when any exists. */
  realized: EconomicAttribution | null;
}

export interface RealizationOptions {
  limit?: number;
  /**
   * Wall-clock ceiling on the per-unit git work, in milliseconds. `Infinity`
   * removes the bound; zero exhausts it immediately. The default keeps a
   * dashboard route answering instead of hanging. Commits the budget does not
   * reach report `survived: unknown` rather than a ratio, so a smaller budget
   * withholds evidence and never fabricates it.
   */
  gitScanBudgetMs?: number;
  windowDays?: number;
  acceptanceThreshold?: number;
  survivalThreshold?: number;
  persist?: boolean;
  /** Supported completeness witnesses for the negative clean channels. */
  completenessWitnesses?: readonly CompletenessWitness[];
}

/**
 * Build a gate result from its four-valued polarity, deriving the legacy
 * verdict rather than accepting one. The projection lives in exactly one place
 * so that `conflicted` cannot become `pass` by a caller's oversight.
 */
function gate(g: Gate, polarity: EpistemicState, detail: string): GateResult {
  return { gate: g, polarity, verdict: verdictFromPolarity(polarity), detail };
}

/** A gate whose evidence is boolean by construction and cannot disagree with itself. */
function decided(value: boolean): EpistemicState {
  return value ? 'supported' : 'refuted';
}

function cleanCompleteness(
  project: string,
  commitHash: string,
  commitTsEpochMs: number,
  observedAtMs: number,
  witnesses: readonly CompletenessWitness[],
): CleanCompleteness {
  const requiredEventTypes = [...CLEAN_COMPLETENESS_EVENT_TYPES] as CleanCompletenessEventType[];
  const storedWitnesses = witnesses.map((witness): CleanCompletenessWitness => ({
    id: witness.id,
    sourceId: witness.sourceId,
    state: witness.state,
    eventTypes: [...witness.eventTypes],
    scope: Object.fromEntries(witness.scope.constraints.map((constraint) => [constraint.key, constraint.value])),
    period: { from: witness.period.from, to: witness.period.to },
  }));
  if (observedAtMs <= commitTsEpochMs) {
    return { qualified: false, requiredEventTypes, qualifyingWitnessIds: [], witnesses: storedWitnesses };
  }
  const target = {
    scope: scope({ project, commit: commitHash }),
    period: interval(new Date(commitTsEpochMs).toISOString(), new Date(observedAtMs).toISOString()),
  };
  const assessments = requiredEventTypes.map((eventType) => assessCompleteness(
    { eventType, ...target },
    witnesses,
  ));
  const qualifyingWitnessIds = [...new Set(assessments.flatMap((assessment) => assessment.qualifyingWitnessIds))].sort();
  return {
    qualified: assessments.every((assessment) => assessment.qualifiesAbsenceInference),
    requiredEventTypes,
    qualifyingWitnessIds,
    witnesses: storedWitnesses,
  };
}

export async function computeRealization(
  store: Store,
  repoPath: string,
  opts: RealizationOptions = {},
): Promise<RealizationReport> {
  const limit = opts.limit ?? 30;
  const windowDays = opts.windowDays ?? 14;
  // ONE budget across every commit's git work, not one per commit.
  //
  // THE MEASUREMENT, BECAUSE GUESSING WHICH CALL IS SLOW IS HOW THIS GOES
  // WRONG. At `limit: 40` on this repository: `attributeCommits` 2.3s,
  // `revertScan` 1.2s, the store reads 1.1s, `git show` for the per-file added
  // lines 42s across the forty, and `git blame --line-porcelain HEAD` **20.3s
  // for a SINGLE commit** — which extrapolates to the 416 seconds `/api/value`
  // was measured taking end to end. A dashboard route with no timeout of its
  // own spending seven minutes in git is a hang, not a slow answer.
  //
  // Bounding blame alone still left 126s, because the per-commit `git show`
  // that follows it is a full diff and this repository's commits are large. So
  // the deadline covers every per-unit git call, and the unit's git-derived
  // gates go UNKNOWN past it rather than reporting a number gathered from
  // nothing. A commit the scan did not reach has not been shown to have churned
  // or to have shipped no proposal; reading its absence as a verdict is the
  // exact collapse the epistemic standard exists to refuse, and it would make
  // the aggregate worse the slower the machine is.
  const gitBudgetMs = opts.gitScanBudgetMs ?? 20_000;
  // `Infinity` removes the bound; ZERO exhausts it immediately, which is how a
  // test reaches the unmeasured branch without owning a repository slow enough
  // to reach it by waiting. A budget expressed as "greater than zero means
  // bounded" would have made zero mean unbounded, which is the opposite of what
  // anyone passing it intends.
  let gitDeadlineMs: number | undefined;
  const gitBudgetSpent = (): boolean => gitDeadlineMs !== undefined && Date.now() >= gitDeadlineMs;
  let unmeasuredSurvival = 0;
  const acceptanceThreshold = opts.acceptanceThreshold ?? 0.6;
  const survivalThreshold = opts.survivalThreshold ?? 0.5;
  const now = Date.now();
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const project = await projectName(repoPath);
  // Attribute this project's OWN spend to its commits when the ledger is actually
  // characterized by project (native imports, or proxy traffic tagged with
  // x-fiscus-project); otherwise fall back to the project-blind window sum so a
  // classic 'default'-tagged proxy store is unchanged. This is the bridge that
  // makes native, no-proxy imported spend produce correct per-project RoI.
  const projectScoped = store.hasProjectSpend(project);

  const attributions = await attributeCommits(store, repoPath, {
    limit,
    persist: opts.persist,
    scopeProject: projectScoped ? project : undefined,
  });
  const scan = await revertScan(repoPath, limit);
  const reverted = scan.reverted;
  // The first completeness witness this product emits from real evidence.
  // A caller-supplied set still wins outright: an operator who has wired a
  // real incident feed knows more about their own coverage than this does,
  // and silently merging would make the resulting assessment untraceable to
  // either source.
  const gitWitness = revertCompletenessWitness(project, scan, now);
  const witnesses = opts.completenessWitnesses
    ?? (gitWitness === null ? [] : [gitWitness]);

  // The clock starts HERE, not at the top. `attributeCommits` and `revertScan`
  // above are fixed setup that runs once regardless of how many units there are,
  // and letting them consume a per-unit budget would mean a slow machine spent
  // the whole allowance before measuring anything — turning a scheduling
  // accident into forty unknown gates.
  gitDeadlineMs = Number.isFinite(gitBudgetMs) ? Date.now() + gitBudgetMs : undefined;

  const units: WorkUnit[] = [];
  for (const a of attributions) {
    const ageDays = (now - a.tsEpochMs) / (24 * 60 * 60 * 1000);
    const maturing = now - a.tsEpochMs < windowMs;
    // Checked ONCE per unit and reused, so a unit is measured or unmeasured as a
    // whole. Re-reading the clock between the two calls below would let a unit
    // report a survival ratio with no proposal comparison, or the reverse, and
    // an operator comparing two units would have no way to know which halves
    // were gathered.
    const scanned = !gitBudgetSpent();
    const survival = scanned
      ? await survivingLines(repoPath, a.hash, gitDeadlineMs)
      : { added: 0, surviving: 0, measured: false };
    const { added, surviving } = survival;
    const survivalRatio = added > 0 ? Math.min(1, surviving / added) : 0;
    if (!survival.measured) unmeasuredSurvival += 1;
    const isReverted = reverted.has(a.hash) || reverted.has(a.hash.slice(0, 7));

    // proxy gates: proposals captured in this commit's attribution window
    const addedByFile = scanned ? await addedLinesByFile(repoPath, a.hash) : new Map<string, string[]>();
    const committedPaths = [...addedByFile.keys()];
    const winProposals = store.proposalsInWindow(project, a.windowStartMs, a.windowEndMs);
    const proposalCaptureCoverage: ProposalCaptureCoverage = !scanned || winProposals.length === 0
      // Without this unit's committed paths there is nothing to match a proposal
      // against, so capture coverage is unknown for the same reason an empty
      // window is: nothing was compared.
      ? 'unknown'
      : winProposals.some((proposal) => proposal.captureCoverage === 'truncated')
        ? 'truncated'
        : winProposals.some((proposal) => proposal.captureCoverage === 'legacy_unknown')
          ? 'legacy_unknown'
          : 'complete';
    const matched: ProposedFile[] = [];
    for (const p of winProposals) {
      if (p.captureCoverage !== undefined && p.captureCoverage !== 'complete') continue;
      for (const f of p.files) {
        if (matchesCommitFile(f.path, committedPaths)) matched.push(f);
      }
    }
    const acceptance = proposalCaptureCoverage === 'complete' ? acceptanceForCommit(matched, addedByFile) : null;
    const hadProposal = acceptance !== null;

    // signal gates
    // A coding lifecycle gate is evidence about one immutable commit. Legacy
    // project-window assertions stay in the ledger for audit, but may not make
    // an unrelated commit look tested, merged, shipped, or clean by timing.
    const signals = store.signalsForCommit(a.hash);
    const incidentFail = signals.some((s) => s.kind === 'incident');
    const completeness = cleanCompleteness(project, a.hash, a.tsEpochMs, now, witnesses);

    const verdicts: Record<Gate, GateResult> = {
      proposed: gate(
        'proposed',
        hadProposal ? 'supported' : 'unknown',
        hadProposal
          ? 'AI proposal captured'
          : proposalCaptureCoverage === 'truncated'
            ? 'proposal capture truncated; coverage incomplete'
            : proposalCaptureCoverage === 'legacy_unknown'
              ? 'proposal capture predates coverage tracking'
              : 'no complete proposal captured',
      ),
      accepted: gate(
        'accepted',
        acceptance === null ? 'unknown' : decided(acceptance >= acceptanceThreshold),
        acceptance === null ? 'no proposal to compare' : `${Math.round(acceptance * 100)}% of proposal shipped`,
      ),
      // `committed` stays SUPPORTED past the budget: the commit exists in the
      // history the attribution read, which is evidence gathered before any of
      // this. Only the line and file counts come from the skipped calls, so the
      // reason falls back to what the attribution already knew.
      committed: gate(
        'committed',
        'supported',
        scanned
          ? `${added} lines in ${committedPaths.length || a.filesChanged} files`
          : `${a.filesChanged} files; line counts unmeasured (scan budget exhausted)`,
      ),
      tested: gate('tested', signalPolarity(signals, 'tested'), 'CI/test signal'),
      merged: gate('merged', signalPolarity(signals, 'merged'), 'merge signal'),
      shipped: gate('shipped', signalPolarity(signals, 'shipped'), 'deploy signal'),
      survived: gate(
        'survived',
        // UNMEASURED IS NOT ZERO. A commit whose blame did not run inside the
        // scan budget has not been shown to have churned; reading its partial
        // count as a ratio would turn "we ran out of time" into a quality
        // verdict against it. Unknown is the same answer `maturing` gives, for
        // the same reason: the evidence has not been gathered yet.
        maturing || !survival.measured ? 'unknown' : decided(survivalRatio >= survivalThreshold),
        maturing
          ? 'maturing'
          : survival.measured
            ? `${Math.round(survivalRatio * 100)}% of lines survive`
            : 'survival unmeasured: the blame budget was exhausted before this commit was covered',
      ),
      clean: gate(
        'clean',
        isReverted || incidentFail ? 'refuted' : maturing ? 'unknown' : completeness.qualified ? 'supported' : 'unknown',
        isReverted
          ? 'reverted'
          : incidentFail
            ? 'linked incident'
            : maturing
              ? 'maturing'
              : completeness.qualified
                ? 'no revert/incident in completeness-covered sources'
                : 'absence unresolved: completeness witness required for revert and incident channels',
      ),
    };

    // Attribute the unit to the provider/model that spent the most in its window.
    // Exact effective Money is the sole winner authority. Scope the model read to
    // the SAME project the dollars were scoped to, or the label could be taken
    // from another project's concurrent traffic. A partial exact window has no
    // winner; a wholly legacy window retains a display-only compatibility label
    // with null cost/share so the frontier cannot treat it as priceable evidence.
    const modelSpend = store.byModel(a.windowStartMs, a.windowEndMs, projectScoped ? project : undefined);
    const economicModelRows = store.economicRequestRowsInRange(a.windowStartMs, a.windowEndMs, {
      project: projectScoped ? project : undefined,
    });
    const modelAuthority = canonicalModelAttribution(economicModelRows);
    const dominantProvider = modelAuthority.coverage === 'exact'
      ? modelAuthority.dominant?.provider ?? null
      : modelAuthority.coverage === 'legacy_unknown'
        ? modelSpend[0]?.provider ?? null
        : null;
    const dominantModel = modelAuthority.coverage === 'exact'
      ? modelAuthority.dominant?.model ?? null
      : modelAuthority.coverage === 'legacy_unknown'
        ? modelSpend[0]?.label ?? null
        : null;
    // Keep the dominant model's OWN spend and its share of the window separately
    // from the window total: the total is what the commit cost, the share is how
    // much of that is really attributable to this model. Model comparison needs
    // both, and conflating them books one model's dollars to another.
    const dominantModelRow = modelAuthority.coverage === 'exact' ? modelAuthority.dominant : undefined;
    const dominantModelEconomic = dominantModelRow?.economic;
    const dominantModelCostUsd = modelAuthority.coverage === 'exact'
      ? modelAuthority.dominantCostUsd
      : null;
    const dominantModelCostShare = modelAuthority.coverage === 'exact' ? modelAuthority.dominantShare : null;
    // Record HOW that model's dollars were priced, not just how many there were.
    // Collapsed to one value or the sentinel 'mixed' here so every reader applies
    // the same rule; the raw sets stay in the ledger for `fiscus pricing --coverage`.
    let dominantModelCostBasis: string | null = null;
    let dominantModelRateCard: string | null = null;
    if (dominantProvider !== null && dominantModel !== null) {
      const lineage = store.modelPricingBasis(
        a.windowStartMs,
        a.windowEndMs,
        dominantModel,
        projectScoped ? project : undefined,
        dominantProvider,
      );
      dominantModelCostBasis =
        lineage.costBases.length === 1 ? lineage.costBases[0]! : lineage.costBases.length > 1 ? 'mixed' : null;
      dominantModelRateCard =
        lineage.rateCardShas.length === 1 ? lineage.rateCardShas[0]! : lineage.rateCardShas.length > 1 ? 'mixed' : null;
    }

    units.push({
      ...a,
      ageDays,
      maturing,
      survivalRatio,
      reverted: isReverted,
      hadProposal,
      acceptance,
      taskType: classifyTaskType(a.subject),
      dominantProvider,
      dominantModel,
      dominantModelCostUsd,
      dominantModelCostShare,
      ...(dominantModelEconomic === undefined ? {} : { dominantModelEconomic }),
      dominantModelCostBasis,
      dominantModelRateCard,
      costStale: false, // priced from the ledger as it stands right now
      funnel: scoreFunnel(verdicts),
      cleanCompleteness: completeness,
      proposalCaptureCoverage,
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
        // Record WHICH spend basis produced these dollars, so a later reprice can
        // re-attribute the snapshot the same way instead of guessing between the
        // project-scoped and project-blind sums.
        costScope: projectScoped ? 'project' : 'window',
      })),
    );
  }

  return rollupRealization(units, {
    generatedAt: now,
    windowDays,
    acceptanceThreshold,
    survivalThreshold,
    projectScoped,
    survivalUnmeasuredUnits: unmeasuredSurvival,
  });
}

/**
 * Reconstruct a realization report from persisted snapshots — no git, no repo.
 * Units are rehydrated and rolled up by the SAME `rollupRealization`, so a
 * dashboard reading a store its machine never computed gets numbers identical to
 * a live run. Reads every project by default (the team aggregate); pass a project
 * to scope it. `generatedAt` reflects the freshest snapshot in the set.
 */
/**
 * Fill four-valued gate fields on a snapshot that predates them, using only
 * what the stored three-valued row can honestly support.
 */
function normalizeFunnelPolarity(funnel: FunnelOutcome): FunnelOutcome {
  const results = funnel.results.map((result) =>
    result.polarity === undefined || result.polarity === null
      ? { ...result, polarity: polarityFromVerdict(result.verdict) }
      : result);
  return { ...funnel, results, conflicts: funnel.conflicts ?? [] };
}

export function realizationFromStore(
  store: Store,
  opts: { project?: string; windowDays?: number; acceptanceThreshold?: number; survivalThreshold?: number } = {},
): RealizationReport {
  const rows = store.realizationUnitRows(opts.project);
  // Snapshots persisted before per-model cost attribution existed carry neither
  // field. Normalize the absence to an explicit null rather than leaving it
  // `undefined`: a legacy unit's model attribution is genuinely unknown, and the
  // model-comparison purity gate must exclude it instead of silently treating a
  // missing share as a qualifying one.
  const units = rows.map((r) => {
    const u = JSON.parse(r.unitJson) as WorkUnit;
    return {
      ...u,
      // Snapshots persisted before four-valued gates carry neither `polarity`
      // nor `conflicts` (AII-003, WP-B03), and both are required fields — a
      // missing `conflicts` threw on `.length` in the waste rollup and the CLI
      // status line the moment anything read a legacy row.
      //
      // A legacy verdict maps through `polarityFromVerdict`, which can never
      // produce `conflicted`, so an empty `conflicts` is not an assertion that
      // no disagreement occurred: it is the only thing a three-valued row can
      // say, and it says it consistently with its own gates. This deliberately
      // differs from `src/value/epistemic.ts`, which reads a missing polarity
      // as null rather than deriving one — the kernel refuses to infer at all,
      // while a compatibility read must satisfy the type it hands on.
      funnel: normalizeFunnelPolarity(u.funnel),
      dominantProvider: u.dominantProvider ?? null,
      dominantModelCostUsd: u.dominantModelCostUsd ?? null,
      dominantModelCostShare: u.dominantModelCostShare ?? null,
      // Same normalization, same reason: a snapshot that predates pricing lineage
      // has genuinely unknown comparability, and `undefined` would read as "fine".
      dominantModelCostBasis: u.dominantModelCostBasis ?? null,
      dominantModelRateCard: u.dominantModelRateCard ?? null,
      // Staleness lives on the stored ROW, not in the serialized unit: a reprice
      // changes whether the snapshot's dollars are current without changing the
      // work it describes.
      costStale: r.costStale,
    };
  });
  const generatedAt = rows.length > 0 ? Math.max(...rows.map((r) => r.computedAtMs)) : Date.now();
  return rollupRealization(units, {
    generatedAt,
    windowDays: opts.windowDays ?? 14,
    acceptanceThreshold: opts.acceptanceThreshold ?? 0.6,
    survivalThreshold: opts.survivalThreshold ?? 0.5,
    // A single-project read is inherently project-scoped; the cross-project
    // aggregate is not. Reflects how the persisted snapshots were sliced here.
    projectScoped: opts.project !== undefined,
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
  spendOnRealizedUnitsUsd: number;
  acceptanceWeightedSpendUsd: number;
  roiIndex: number | null;
  // Which AI tools produced this project's spend (repo↔project↔tool interconnection).
  // Empty when the project has no cwd-tagged traffic (e.g. untagged proxy).
  sources: string[];
  /** Exact effective spend coverage for this project's mature units, when available. */
  economic?: RealizationEconomicRollup;
}

/**
 * Per-project value — the budget owner's view. For each project with stored
 * realization snapshots, roll its units up (the same pure rollup) and score its
 * RoI, so a manager sees which projects' AI spend is paying off — with no repo on
 * their machine. `roiOptions` is threaded through so per-project RoI matches the
 * headline (e.g. the demo's synthetic lift), keeping the numbers consistent. Each
 * project is joined to the TOOLS that produced its spend, so the view answers not
 * just "did this project pay off" but "which tool coded it".
 */
export function projectValueBreakdown(
  store: Store,
  opts: { windowDays?: number; roiOptions?: RoIOptions } = {},
): ProjectValue[] {
  const sourcesByProject = new Map(store.projectPaths().map((p) => [p.project, p.sources]));
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
      spendOnRealizedUnitsUsd: rep.matured.spendOnRealizedUnitsUsd,
      acceptanceWeightedSpendUsd: rep.matured.acceptanceWeightedSpendUsd,
      roiIndex: roi.roiIndex,
      sources: sourcesByProject.get(project) ?? [],
      ...(rep.matured.economic === undefined ? {} : { economic: rep.matured.economic }),
    });
  }
  return out.sort((a, b) => b.costUsd - a.costUsd);
}

export interface ProjectTaskStratum {
  project: string;
  taskType: string;
  units: number; // matured units in this stratum
  realizedUnits: number;
  costUsd: number;
}

/**
 * Per-project × task-type strata over matured units — the raw material for
 * task-standardized team comparison (src/team/standardize.ts). Numeric-only,
 * same disclosure posture as ProjectValue: no prompt/response content, no raw
 * request log — counts and dollars a budget owner already sees, one grain
 * finer. Without this grain, cross-machine comparisons are at the mercy of
 * task-mix differences (Simpson's paradox); with it, the team server can hold
 * the basket fixed and compare like with like.
 */
export function projectTaskStrata(store: Store, opts: { windowDays?: number } = {}): ProjectTaskStratum[] {
  const out: ProjectTaskStratum[] = [];
  for (const project of store.realizationProjects()) {
    const rep = realizationFromStore(store, { project, windowDays: opts.windowDays });
    const mature = rep.units.filter((u) => !u.maturing);
    if (mature.length === 0) continue;
    const byType = new Map<string, { units: number; realizedUnits: number; costUsd: number }>();
    for (const u of mature) {
      const cell = byType.get(u.taskType) ?? { units: 0, realizedUnits: 0, costUsd: 0 };
      cell.units += 1;
      if (u.funnel.realized) cell.realizedUnits += 1;
      cell.costUsd += u.attributedCostUsd;
      byType.set(u.taskType, cell);
    }
    for (const [taskType, cell] of byType) out.push({ project, taskType, ...cell });
  }
  return out.sort((a, b) => b.costUsd - a.costUsd);
}

export interface DiscoveredProject {
  project: string;
  repoPath: string; // the captured cwd that is a git working tree
  sources: string[]; // the tools that produced this project's spend
  costUsd: number;
  requests: number;
}

/**
 * Discover the git repos behind the ledger's projects — the interconnectedness that
 * makes native per-project RoI possible with NO --repo and NO wiring. For each
 * project the store has a working directory for (from `projectPaths`), keep the one
 * whose cwd is a real git working tree, paired with the tools (sources) that coded
 * it. Pure discovery: it neither attributes nor persists. An import with no cwd, or
 * a cwd that isn't a repo (or has been deleted), is simply skipped — never guessed.
 */
export async function discoverProjectRepos(store: Store): Promise<DiscoveredProject[]> {
  const out: DiscoveredProject[] = [];
  for (const p of store.projectPaths()) {
    if (await isGitRepo(p.cwd)) {
      out.push({ project: p.project, repoPath: p.cwd, sources: p.sources, costUsd: p.costUsd, requests: p.requests });
    }
  }
  return out;
}

/**
 * Auto-correlate every discovered project repo: run the REAL realization scorer on
 * each (persisting a per-project snapshot), so a user who only IMPORTED their tools
 * — never proxied, never passed --repo — still gets full per-project RoI. Because
 * attribution is project-scoped, each repo absorbs only its own project's spend, and
 * the captured source tags mean the persisted value knows which tool produced it.
 * Honest no-op when nothing is discoverable (no captured cwd, or none are repos) —
 * e.g. in demo mode, where seeded rows carry no cwd.
 */
export async function realizeDiscoveredProjects(
  store: Store,
  opts: { windowDays?: number; limit?: number } = {},
): Promise<Array<DiscoveredProject & { units: number; realizedUnits: number }>> {
  const repos = await discoverProjectRepos(store);
  const results: Array<DiscoveredProject & { units: number; realizedUnits: number }> = [];
  for (const r of repos) {
    const rep = await computeRealization(store, r.repoPath, {
      limit: opts.limit ?? 40,
      windowDays: opts.windowDays,
      persist: true,
    });
    const realizedUnits = rep.units.filter((u) => !u.maturing && u.funnel.realized).length;
    results.push({ ...r, units: rep.units.length, realizedUnits });
  }
  return results;
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
  opts: {
    generatedAt?: number;
    windowDays: number;
    acceptanceThreshold: number;
    survivalThreshold: number;
    projectScoped?: boolean;
    /** Units the survival scan could not reach; see `RealizationReport`. */
    survivalUnmeasuredUnits?: number;
  },
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
  const spendOnRealizedUnitsUsd = realizedUnits.reduce((s, u) => s + u.attributedCostUsd, 0);
  // Net of rework: each realized unit's dollars discounted by its first-pass
  // acceptance — output that had to be heavily rewritten delivered less value.
  // Unknown acceptance → full credit (the unknown-never-penalizes rule).
  const acceptanceWeightedSpendUsd = realizedUnits.reduce((s, u) => s + u.attributedCostUsd * (u.acceptance ?? 1), 0);

  const wasteMap = new Map<string, WasteBucket>();
  for (const u of mature) {
    // A unit stopped by a contradiction did not die at that gate. Bucketing it
    // under the gate name would report a refutation the evidence does not
    // support, and would put adjudicable work in the same column as work that
    // demonstrably failed.
    const stage = u.funnel.realized
      ? 'realized'
      : u.funnel.conflicts.length > 0
        ? 'conflicted'
        : u.funnel.diedAt ?? 'unverified';
    const b = wasteMap.get(stage) ?? { stage, units: 0, costUsd: 0 };
    b.units += 1;
    b.costUsd += u.attributedCostUsd;
    wasteMap.set(stage, b);
  }

  const instrumentation = Object.fromEntries(GATE_LADDER.map((g) => [g, 0])) as Record<Gate, number>;
  const gateConflicts = Object.fromEntries(GATE_LADDER.map((g) => [g, 0])) as Record<Gate, number>;
  for (const u of mature) {
    for (const r of u.funnel.results) {
      if (r.verdict !== 'unknown') instrumentation[r.gate] += 1;
      if (r.polarity === 'conflicted') gateConflicts[r.gate] += 1;
    }
  }

  const aggregateEconomic = (values: readonly EconomicAttribution[]): EconomicAttribution =>
    economicAttributionFromAttributions(values);
  const matureEconomic = mature.flatMap((unit) => unit.economic === undefined ? [] : [unit.economic]);
  const realizedEconomic = realizedUnits.flatMap((unit) => unit.economic === undefined ? [] : [unit.economic]);
  const economic: RealizationEconomicRollup = {
    coverage: matureEconomic.length === 0
      ? 'legacy_unknown'
      : matureEconomic.length === mature.length && aggregateEconomic(matureEconomic).complete
        ? 'exact'
        : 'partial',
    total: matureEconomic.length === 0 ? null : aggregateEconomic(matureEconomic),
    realized: matureEconomic.length === 0 ? null : aggregateEconomic(realizedEconomic),
  };

  return {
    generatedAt: new Date(generatedMs).toISOString(),
    windowDays: opts.windowDays,
    acceptanceThreshold: opts.acceptanceThreshold,
    survivalThreshold: opts.survivalThreshold,
    projectScoped: opts.projectScoped ?? false,
    units,
    firstPassAcceptance,
    proposalCoverage: units.length > 0 ? withProposal.length / units.length : 0,
    costStaleUnits: units.filter((u) => u.costStale).length,
    survivalUnmeasuredUnits: opts.survivalUnmeasuredUnits ?? 0,
    matured: {
      units: mature.length,
      realizedUnits: realizedUnits.length,
      realizationRate: mature.length > 0 ? realizedUnits.length / mature.length : 0,
      totalCostUsd,
      spendOnRealizedUnitsUsd,
      acceptanceWeightedSpendUsd,
      realizedSpendShare: totalCostUsd > 0 ? spendOnRealizedUnitsUsd / totalCostUsd : null,
      wasteByStage: [...wasteMap.values()].sort((a, b) => b.costUsd - a.costUsd),
      instrumentation,
      gateConflicts,
      realizationBounds: terminalRealizationBounds(mature.map((u) => u.funnel)),
      serial: serialRealization(mature.map((u) => u.funnel)),
      economic,
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
  baselineBounds?: { low: Record<string, number>; high: Record<string, number> },
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
    units: mature.map((u) => ({ taskType: u.taskType, realized: u.funnel.realized, acceptance: u.acceptance })),
    events,
    baselineMinutes,
    baselineMinutesLow: baselineBounds?.low,
    baselineMinutesHigh: baselineBounds?.high,
    ledgerAcceptance: report.firstPassAcceptance,
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
