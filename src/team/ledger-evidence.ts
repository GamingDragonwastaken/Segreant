/**
 * Read the local ledger ONCE, so a rollup and the evidence it is checked
 * against describe the same read.
 *
 * WHY ONE READ AND NOT TWO. Every figure here is derived from a window measured
 * relative to NOW. Calling `projectValueBreakdown` twice — once to build the
 * body, once to build the evidence — measures two different windows a few
 * milliseconds apart, and a unit that ages out between them makes the two
 * disagree over nothing. A cross-check that can fail for reasons unrelated to
 * the property it checks is worse than no cross-check: it teaches whoever sees
 * it to widen the tolerance until it stops firing.
 *
 * WHY THE PROJECT LIST IS UNFILTERED. The scope claim is checked against the
 * population the machine actually has. A body declaring `all-projects` while
 * carrying one of three is the D-101 erasure — the team server keeps only the
 * latest rollup per developer and reads it as that developer's whole window, so
 * the other two projects leave every team total, `developerCount` falls with
 * them, and a colleague's project can disappear behind a k-anonymity floor that
 * has nothing to do with them. The filter is the CALLER's, applied after this
 * read, and this evidence is what tells the mint that a filter was applied.
 *
 * WHY THE RETENTION FACTS ARE CARRIED RAW. `retentionTruncatesWindow` and
 * `retentionPrunedBeforeMs` are the two halves of a three-state answer:
 * truncated, intact, and NO PRUNE ON RECORD (`null`), which is not "nothing was
 * pruned" and licenses nothing. Deriving a verdict here would collapse the
 * third state into one of the other two; the mint derives only the one
 * conclusion it is entitled to, which is that a truncated window cannot support
 * a `complete` claim.
 *
 * This module reads persistence and is therefore NOT importable by the separate
 * team-server package — `src/team/rollup.ts` deliberately keeps the check pure
 * and takes the evidence as data so that boundary holds.
 */

import type { Store } from '../store/db.ts';
import {
  projectTaskStrata,
  projectValueBreakdown,
  spendCoverageForProjects,
  type ProjectTaskStratum,
  type ProjectValue,
} from '../value/realization.ts';
import { UNKNOWN_ROLLUP_SCOPE, type RollupCoverage, type RollupLedgerEvidence, type RollupScope } from './rollup.ts';

export interface LedgerRollupRead {
  /** Every project the ledger holds for this window, before any caller filter. */
  projects: ProjectValue[];
  /** The same rows one grain finer, before any caller filter. */
  strata: ProjectTaskStratum[];
  /** What the mint checks the body against. */
  evidence: RollupLedgerEvidence;
}

/**
 * The window a rollup covers, computed once by the caller rather than inside
 * the signer, so the period in the body is the period the ledger was read over.
 * It used to be computed at signing time, several statements after the read.
 */
export function rollupPeriod(windowDays: number, now: Date = new Date()): { from: string; to: string } {
  return { from: new Date(now.getTime() - windowDays * 86_400_000).toISOString(), to: now.toISOString() };
}

/** The scope a `--project` filter implies. Null means no filter, which is a claim about the whole machine. */
export function rollupScopeForFilter(projectFilter: string | null): RollupScope {
  return projectFilter === null ? { kind: 'all-projects' } : { kind: 'project', project: projectFilter };
}

export function readLedgerForRollup(store: Store, opts: { windowDays: number; period: { from: string; to: string } }): LedgerRollupRead {
  const projects = projectValueBreakdown(store, { windowDays: opts.windowDays });
  const strata = projectTaskStrata(store, { windowDays: opts.windowDays });
  // The comparison `Store.windowCoverage` already makes for every other reader
  // of a truncated window: strictly before, because `prune` deletes rows older
  // than the boundary and the boundary instant itself survived.
  const retention = store.windowCoverage(Date.parse(opts.period.from));
  return {
    projects,
    strata,
    evidence: {
      window: { from: opts.period.from, to: opts.period.to },
      projects: projects.map((project) => ({
        project: project.project,
        units: project.units,
        costUsd: project.costUsd,
        spendOnRealizedUnitsUsd: project.spendOnRealizedUnitsUsd,
        acceptanceWeightedSpendUsd: project.acceptanceWeightedSpendUsd,
      })),
      retentionTruncatesWindow: retention.truncated,
      retentionPrunedBeforeMs: retention.prunedBeforeMs,
    },
  };
}

/**
 * The coverage claim for the body that will actually be signed.
 *
 * Computed over the FILTERED projects, because coverage describes the body and
 * not the window it was drawn from, and separate from `readLedgerForRollup` for
 * that reason: one is about the ledger, the other about the claim.
 */
export function rollupCoverageForBody(store: Store, projects: ReadonlyArray<{ project: string }>, windowDays: number): RollupCoverage {
  return spendCoverageForProjects(store, projects, { windowDays });
}

export { UNKNOWN_ROLLUP_SCOPE };
