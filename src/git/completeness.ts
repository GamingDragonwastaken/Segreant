/**
 * ISSUANCE CLASS: kernel_primitive — see `src/epistemic/issuance-map.ts`. This
 * builds a completeness witness from what a git scan actually read. It issues
 * nothing itself.
 *
 * The first completeness witness this product emits from real evidence.
 *
 * Until now `computeRealization` took `completenessWitnesses` as an option and
 * nothing but a test ever passed one, so the machinery that lets absence become
 * a negative claim was correct and entirely unexercised — and the coding
 * `clean` gate could only ever be `unknown` in real use. That was the right
 * default (D-055) and it is not a resting place: a source that CAN report its
 * own coverage should do so.
 *
 * WHAT GIT CAN HONESTLY WITNESS. A revert of a commit is necessarily NEWER than
 * that commit. So a scan that walked back from HEAD as far as a given commit
 * has, by construction, seen every revert of it that exists in this history.
 * The completeness boundary is therefore the oldest commit the scan actually
 * read — not the depth requested, and not the age of the repository.
 *
 * Two consequences worth stating because they are easy to get backwards:
 *
 *   A SHALLOW CLONE DOES NOT IMPAIR THIS. Shallowness truncates OLD history,
 *   and reverts are newer than what they revert. A commit visible in a shallow
 *   clone has its whole revert-relevant future visible too.
 *
 *   A TRUNCATED SCAN DOES. The scan reads a bounded window, so a commit older
 *   than the oldest one it read is outside the witnessed period — and the
 *   containment test in `assessCompleteness` excludes it without anything here
 *   having to special-case it.
 *
 * This witness covers `commit_reverted` only. `linked_incident` has no local
 * source, so nothing here witnesses it, and the coding `clean` gate therefore
 * still cannot pass on git evidence alone. That is the intended outcome: this
 * packet supplies real evidence for one channel, it does not loosen a gate.
 */

import { completenessWitness, type CompletenessWitness } from '../measurement/completeness.ts';
import { scope } from '../epistemic/scope.ts';
import { interval } from '../epistemic/time.ts';
import type { RevertScan } from './quality.ts';

/**
 * A stable identifier for the witness a given scan produces.
 *
 * Keyed on the project and the coverage boundary rather than on the moment of
 * the scan: two scans that read back to the same commit witness the same fact,
 * and should not accumulate as distinct evidence.
 */
export function revertScanWitnessId(project: string, oldestExaminedMs: number): string {
  return `git-revert-scan:${project}:${oldestExaminedMs}`;
}

/**
 * Build the completeness witness for the `commit_reverted` channel, or null
 * when the scan cannot support one.
 *
 * Returns null — not a refuting witness — when the scan read nothing. "We did
 * not look" is unknown, and a refuting witness would assert that the source is
 * incomplete, which is a different and stronger claim than having no evidence
 * either way.
 */
export function revertCompletenessWitness(
  project: string,
  scan: RevertScan,
  observedAtMs: number,
): CompletenessWitness | null {
  if (scan.oldestExaminedMs === null || scan.examined === 0) return null;
  // A zero-width or inverted period would witness nothing; `interval` rejects
  // it, and reaching that state means the clock or the history disagrees with
  // itself rather than that coverage is complete.
  if (observedAtMs <= scan.oldestExaminedMs) return null;

  return completenessWitness({
    id: revertScanWitnessId(project, scan.oldestExaminedMs),
    sourceId: 'git-history',
    // `supported` is the whole claim: within this window, this history was
    // completely read for revert evidence. It says nothing about whether a
    // revert exists — only that if one did, this scan would have seen it.
    state: 'supported',
    eventTypes: ['commit_reverted'],
    scope: scope({ project }),
    period: interval(
      new Date(scan.oldestExaminedMs).toISOString(),
      new Date(observedAtMs).toISOString(),
    ),
  });
}
